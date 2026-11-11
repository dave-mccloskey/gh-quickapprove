import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, copyFile, rm} from 'node:fs/promises';
import {zipSync} from 'fflate';
import {chromeVersion} from './release-version.js';
import {verifyPackage} from './verify-release.js';

const release = process.env.RELEASE_NAME;
const version = chromeVersion(release);
const repository = process.env.GITHUB_REPOSITORY;
if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository ?? ''))
  throw new Error('GITHUB_REPOSITORY is required to generate the listing links.');
const homepage = `https://github.com/${repository}`;
const listing = {
  ...JSON.parse(await readFile('store/listing.json', 'utf8')),
  homepageUrl: homepage,
  supportUrl: `${homepage}/issues`,
  privacyPolicyUrl: `${homepage}/blob/main/PRIVACY.md`,
};
await rm('dist/release', {recursive: true, force: true});
await mkdir('dist/release', {recursive: true});
const extensionName = `gh-quickapprove-${release}.zip`;
await copyFile('dist/gh-quickapprove.zip', `dist/release/${extensionName}`);
const entries = {};
for (const name of ['description.txt', 'privacy-practices.json', 'reviewer-instructions.txt']) {
  entries[name] = new Uint8Array(await readFile(`store/${name}`));
}
entries['listing.json'] = new TextEncoder().encode(`${JSON.stringify(listing, null, 2)}\n`);
entries['listing.txt'] = new TextEncoder().encode(
  Object.entries(listing)
    .map(([field, value]) => `${field}: ${value}`)
    .join('\n') + '\n',
);
entries['PRIVACY.md'] = new Uint8Array(await readFile('PRIVACY.md'));
entries['icon-128.png'] = new Uint8Array(await readFile('extension/icon-128.png'));
entries['THIRD_PARTY_NOTICES.txt'] = new Uint8Array(
  await readFile('extension/THIRD_PARTY_NOTICES.txt'),
);
for (const name of ['01-quick-approve.png', '02-approved.png', '03-settings.png']) {
  const bytes = await readFile(`store/assets/${name}`);
  if (
    bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) !== 1280 ||
    bytes.readUInt32BE(20) !== 800
  )
    throw new Error(`Store screenshot must be a 1280x800 PNG: ${name}`);
  entries[name] = new Uint8Array(bytes);
}
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
