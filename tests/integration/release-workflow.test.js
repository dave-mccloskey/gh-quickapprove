import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {test} from 'node:test';

test('release CLI creates a draft with assets before finalizing and reserves a tag', async () => {
  const {result, calls} = await simulate({});
  assert.equal(result.status, 0);
  const tag = calls.find((call) => call.command === 'git' && call.args.includes('tag'));
  assert.ok(tag.args.includes('-a'));
  assert.ok(tag.args.includes('Release workflow run 42'));
  const create = calls.findIndex((call) => call.args[0] === 'release' && call.args[1] === 'create');
  const publish = calls.findIndex((call) => call.args[0] === 'release' && call.args[1] === 'edit');
  assert.ok(create > 0 && publish > create);
  assert.ok(calls[create].args.includes('--draft'));
  assert.ok(calls[create].args.includes('dist/release/SHA256SUMS'));
});

test('finalized release reruns preserve assets and partial drafts stop without writes', async () => {
  for (const draft of [false, true]) {
    const {result, calls} = await simulate({reserved: true, existing: {draft}});
    assert.equal(result.status, draft ? 1 : 0);
    assert.equal(
      calls.some((call) => call.command === 'node'),
      false,
    );
    assert.equal(
      calls.some((call) => call.args[0] === 'release'),
      false,
    );
    assert.equal(
      calls.some((call) => call.args.includes('push')),
      false,
    );
  }
});

test('reserved tag cannot be reused for another commit', async () => {
  const {result, calls} = await simulate({reserved: true, otherCommit: true});
  assert.equal(result.status, 1);
  assert.equal(
    calls.some((call) => call.command === 'gh' || call.command === 'node'),
    false,
  );
});

test('an unfinished older release cannot replace a newer release on rerun', async () => {
  const {result, calls} = await simulate({reserved: true, laterTag: true});
  assert.equal(result.status, 1);
  assert.equal(
    calls.some((call) => call.command === 'node'),
    false,
  );
  assert.equal(
    calls.some((call) => call.args[0] === 'release'),
    false,
  );
});

test('release notes compare against a finalized release rather than a failed tag reservation', async () => {
  const {result, calls} = await simulate({
    failedTag: true,
    releases: [{tag_name: '2000.12.31.1', draft: false, prerelease: false}],
  });
  assert.equal(result.status, 0);
  const log = calls.find((call) => call.command === 'git' && call.args[0] === 'log');
  assert.equal(log.args.at(-1), `2000.12.31.1..${'a'.repeat(40)}`);
});

async function simulate(config) {
  const directory = await mkdtemp(join(tmpdir(), 'release-workflow-test-'));
  try {
    const bin = join(directory, 'bin');
    await mkdir(bin);
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const stub = `#!${process.execPath}
import {appendFileSync, readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {basename} from 'node:path';
const command = basename(process.argv[1]);
const args = process.argv.slice(2);
const config = JSON.parse(readFileSync('config.json', 'utf8'));
appendFileSync('calls.jsonl', JSON.stringify({command, args}) + '\\n');
if (command === 'git') {
  if (args[0] === 'for-each-ref' && config.reserved) console.log('2033.06.07.2\\tRelease workflow run 42');
  if (args[0] === 'for-each-ref' && config.laterTag) console.log('2033.06.08.1\\tRelease workflow run 43');
  if (args[0] === 'for-each-ref' && config.failedTag) console.log('2000.12.31.1\\tRelease workflow run 1\\n2001.01.01.1\\tRelease workflow run 2');
  if (args[0] === 'rev-list') console.log((config.otherCommit ? 'b' : 'a').repeat(40));
  if (args[0] === 'log') console.log('- Improve example behavior');
}
if (command === 'gh' && args[0] === 'api') console.log(JSON.stringify([config.releases ?? (config.existing ? [{tag_name: '2033.06.07.2', ...config.existing}] : [])]));
if (command === 'node' && args[0] === 'scripts/release-bundle.js') {
  mkdirSync('dist/release', {recursive: true});
  writeFileSync('dist/release/release-info.json', '{}');
}
`;
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    for (const command of ['git', 'gh', 'node']) {
      await writeFile(join(bin, command), stub, {mode: 0o755});
    }
    let status = 0;
    try {
      execFileSync(process.execPath, [resolve('scripts/release.js')], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GITHUB_REF: 'refs/heads/main',
          GITHUB_RUN_ID: '42',
          GITHUB_SHA: 'a'.repeat(40),
          GITHUB_STEP_SUMMARY: join(directory, 'summary.md'),
        },
        stdio: 'pipe',
      });
    } catch (error) {
      status = error.status;
    }
    const calls = (await readFile(join(directory, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    return {result: {status}, calls};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}
