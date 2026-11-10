import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, rm} from 'node:fs/promises';
import {resolve} from 'node:path';

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
]) {
  await copyFile(`extension/${asset}`, `dist/extension/${asset}`);
}
