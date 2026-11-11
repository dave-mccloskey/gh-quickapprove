import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile, rm} from 'node:fs/promises';
import {zipSync} from 'fflate';
import {chromeVersion} from './release-version.js';
import {verifyPackage} from './verify-release.js';

const release = process.env.RELEASE_NAME;
const version = chromeVersion(release);
await rm('dist/release', {recursive: true, force: true});
await mkdir('dist/release', {recursive: true});
const extensionName = `gh-quickapprove-${release}.zip`;
await copyFile('dist/gh-quickapprove.zip', `dist/release/${extensionName}`);
const entries = {};
for (const name of ['listing.txt', 'privacy-policy.txt', 'submission.md']) {
  entries[name] = new Uint8Array(await readFile(`store/${name}`));
}
entries['icon-128.png'] = new Uint8Array(await readFile('extension/icon-128.png'));
entries['THIRD_PARTY_NOTICES.txt'] = new Uint8Array(
  await readFile('extension/THIRD_PARTY_NOTICES.txt'),
);
entries['screenshot.png'] = new Uint8Array(await readFile('test-results/store-screenshot.png'));
const storeName = `store-materials-${release}.zip`;
await writeFile(`dist/release/${storeName}`, zipSync(entries));
const checksums = [];
for (const filename of [extensionName, storeName]) {
  const digest = createHash('sha256')
    .update(await readFile(`dist/release/${filename}`))
    .digest('hex');
  checksums.push(`${digest}  ${filename}`);
}
await writeFile('dist/release/SHA256SUMS', `${checksums.join('\n')}\n`);
verifyPackage(await readFile(`dist/release/${extensionName}`), checksums.join('\n'), release);
await writeFile(
  'dist/release/release-info.json',
  `${JSON.stringify({release, chromeVersion: version, commit: process.env.GITHUB_SHA}, null, 2)}\n`,
);
console.log(`Prepared release ${release}.`);
