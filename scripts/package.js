import {readFile, readdir, writeFile} from 'node:fs/promises';
import {zipSync} from 'fflate';

const entries = {};
for (const filename of await readdir('dist/extension')) {
  if (!/\.(?:js|json|html|css|txt|png)$/.test(filename))
    throw new Error(`Unexpected package asset: ${filename}`);
  entries[filename] = new Uint8Array(await readFile(`dist/extension/${filename}`));
}
await writeFile('dist/gh-quickapprove.zip', zipSync(entries));
console.log('Created dist/gh-quickapprove.zip');
