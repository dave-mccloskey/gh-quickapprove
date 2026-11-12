import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromeVersion} from './release-version.js';
import {writeRuntimeAssets} from './runtime-assets.js';

await rm('dist/extension', {recursive: true, force: true});
execFileSync(
  process.execPath,
  [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
  {stdio: 'inherit'},
);
await mkdir('dist/extension', {recursive: true});
for (const asset of [
  'manifest.json',
  'content.css',
  'options.html',
  'options.css',
  'THIRD_PARTY_NOTICES.txt',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png',
]) {
  await copyFile(`extension/${asset}`, `dist/extension/${asset}`);
}
if (process.env.RELEASE_NAME) {
  const manifest = JSON.parse(await readFile('dist/extension/manifest.json', 'utf8'));
  manifest.version = chromeVersion(process.env.RELEASE_NAME);
  manifest.version_name = process.env.RELEASE_NAME;
  await writeFile('dist/extension/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}
await writeRuntimeAssets('dist/extension');
