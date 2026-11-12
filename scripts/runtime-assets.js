import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Writes classic-script timing defaults and fingerprints a built extension. */
export async function writeRuntimeAssets(directory, overrides = {}) {
  const {timing} = await import(pathToFileURL(resolve(directory, 'timing.js')).href);
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(timing, name) || !Number.isFinite(value) || value < 1)
      throw new Error('Invalid timing override.');
  }
  const config = {...timing, ...overrides};
  await writeFile(
    resolve(directory, 'timing.js'),
    `export const timing = ${JSON.stringify(config)};\n`,
  );
  await writeFile(
    resolve(directory, 'timing-content.js'),
    `var quickApproveTiming = ${JSON.stringify(config)};\n`,
  );
  const fingerprint = createHash('sha256');
  for (const name of (await readdir(directory))
    .filter((name) => !['build-info.json', 'build-info.js'].includes(name))
    .sort()) {
    fingerprint.update(name);
    fingerprint.update(await readFile(resolve(directory, name)));
  }
  const buildId = fingerprint.digest('hex');
  await writeFile(resolve(directory, 'build-info.json'), `${JSON.stringify({buildId})}\n`);
  await writeFile(
    resolve(directory, 'build-info.js'),
    `var quickApproveBuildId = ${JSON.stringify(buildId)};\n`,
  );
}
