import {execFileSync} from 'node:child_process';
import {appendFile, readFile, writeFile} from 'node:fs/promises';
import {nextRelease, chromeVersion} from './release-version.js';

if (
  process.env.GITHUB_REF !== 'refs/heads/main' ||
  !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ||
  !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '')
) {
  throw new Error('Release creation requires a GitHub Actions run on main.');
}
const sha = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
const tags = run('git', [
  'for-each-ref',
  '--format=%(refname:short)%09%(contents:subject)',
  'refs/tags',
])
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => line.split('\t'));
const marker = `Release workflow run ${runId}`;
const reserved = tags.find((entry) => entry[1] === marker)?.[0];
const name =
  reserved ??
  nextRelease(
    tags.map((entry) => entry[0]),
    new Date(),
  );
chromeVersion(name);
process.env.RELEASE_NAME = name;
if (reserved && run('git', ['rev-list', '-n', '1', name]).trim() !== sha)
  throw new Error('Reserved release tag points to another commit.');
const releases = JSON.parse(
  run('gh', ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/releases']),
).flat();
if (reserved) {
  const existing = releases.find((release) => release.tag_name === name);
  if (existing) {
    if (existing.draft)
      throw new Error(
        `Release ${name} is a partial draft. Inspect its assets in GitHub; start a new release run rather than replacing them.`,
      );
    console.log(`Release ${name} already exists. Its assets were preserved.`);
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `Release ${name} already exists; its assets were preserved.\n`,
    );
    process.exit(0);
  }
}
const later = tags.find(
  ([tag]) =>
    tag !== name && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag) && compareRelease(tag, name) > 0,
);
if (later) throw new Error('A later release tag exists. Start a new release run.');
if (!reserved) {
  run('git', [
    '-c',
    'user.name=Release automation',
    '-c',
    'user.email=release@users.noreply.github.com',
    'tag',
    '-a',
    name,
    sha,
    '-m',
    marker,
  ]);
  run('git', ['push', 'origin', `refs/tags/${name}`]);
}
run('node', ['scripts/build.js']);
run('node', ['scripts/package.js']);
run('node', ['scripts/release-bundle.js']);
const previous = releases
  .filter((release) => !release.draft && !release.prerelease)
  .map((release) => release.tag_name)
  .filter(
    (tag) =>
      tags.some(([known]) => known === tag) &&
      /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(tag) &&
      compareRelease(tag, name) < 0,
  )
  .sort((a, b) => compareRelease(b, a))[0];
const changes = run('git', ['log', '--format=- %s', previous ? `${previous}..${sha}` : sha]).trim();
const notes = `Chrome version: ${chromeVersion(name)}\nSource commit: ${sha}\n\n${changes || 'No source changes since the preceding release.'}\n\nUpload gh-quickapprove-${name}.zip to Chrome Web Store. The separate store-materials ZIP contains listing copy, generic screenshots, privacy text, and submission instructions. SHA256SUMS covers both ZIPs.\n\nKnown limitations: supports github.com’s new PR interface only; requires a user-supplied GitHub token; Quick approve submits immediately. Initial store setup and listing/privacy fields require the developer dashboard.\n\nThis GitHub release has not been submitted to Chrome Web Store. Use the separate Submit to Chrome Web Store workflow.\n`;
await writeFile('dist/release/RELEASE-NOTES.md', notes);
run('gh', [
  'release',
  'create',
  name,
  '--verify-tag',
  '--draft',
  '--title',
  name,
  '--notes-file',
  'dist/release/RELEASE-NOTES.md',
  `dist/release/gh-quickapprove-${name}.zip`,
  `dist/release/store-materials-${name}.zip`,
  'dist/release/SHA256SUMS',
  'dist/release/release-info.json',
  'dist/release/RELEASE-NOTES.md',
]);
run('gh', ['release', 'edit', name, '--draft=false', '--latest']);
await appendFile(
  process.env.GITHUB_STEP_SUMMARY,
  `Created release **${name}** from \`${sha}\`.\n\nChrome Web Store submission is a separate manual workflow.\n`,
);
console.log(await readFile('dist/release/release-info.json', 'utf8'));

function run(command, args) {
  return execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']});
}

function compareRelease(left, right) {
  const a = chromeVersion(left)
    .split('.')
    .map((part) => Number(part));
  const b = chromeVersion(right)
    .split('.')
    .map((part) => Number(part));
  for (let index = 0; index < 4; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}
