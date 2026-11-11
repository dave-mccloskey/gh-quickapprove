import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {unzipSync, strFromU8} from 'fflate';
import {chromeVersion} from './release-version.js';

export function verifyPackage(bytes, checksums, release) {
  const version = chromeVersion(release);
  const filename = `gh-quickapprove-${release}.zip`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!checksums.split('\n').includes(`${digest}  ${filename}`))
    throw new Error('Release ZIP checksum mismatch.');
  const files = unzipSync(bytes);
  if (!files['manifest.json']) throw new Error('Release ZIP has no root manifest.');
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  if (manifest.version !== version || manifest.version_name !== release)
    throw new Error('Release ZIP version mismatch.');
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = process.env.RELEASE_NAME;
  chromeVersion(release);
  verifyPackage(
    await readFile(`dist/submission/gh-quickapprove-${release}.zip`),
    await readFile('dist/submission/SHA256SUMS', 'utf8'),
    release,
  );
  console.log(`Verified release ${release}.`);
}
