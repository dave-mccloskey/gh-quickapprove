import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, cp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';
import {writeRuntimeAssets} from '../../scripts/runtime-assets.js';

test('timing overrides change only the isolated build and receive a new matching fingerprint', async () => {
  const original = await mkdtemp(join(tmpdir(), 'runtime-default-'));
  const overridden = await mkdtemp(join(tmpdir(), 'runtime-overrides-'));
  try {
    await writeFile(
      join(original, 'timing.js'),
      'export const timing = {uiStallMs: 45000, apiRequestMs: 12000};\n',
    );
    await writeRuntimeAssets(original);
    const defaults = await readFile(join(original, 'timing.js'), 'utf8');
    const initial = JSON.parse(await readFile(join(original, 'build-info.json'), 'utf8'));
    await cp(original, overridden, {recursive: true});
    await writeRuntimeAssets(overridden, {uiStallMs: 20});
    assert.equal(await readFile(join(original, 'timing.js'), 'utf8'), defaults);
    const config = runInNewContext(
      `${await readFile(join(overridden, 'timing-content.js'), 'utf8')}\nquickApproveTiming;`,
    );
    assert.equal(config.uiStallMs, 20);
    assert.equal(config.apiRequestMs, 12000);
    const changed = JSON.parse(await readFile(join(overridden, 'build-info.json'), 'utf8'));
    assert.notEqual(changed.buildId, initial.buildId);
    assert.ok(
      (await readFile(join(overridden, 'build-info.js'), 'utf8')).includes(changed.buildId),
    );
    await assert.rejects(writeRuntimeAssets(overridden, {unknownMs: 2}));
    await assert.rejects(writeRuntimeAssets(overridden, {uiStallMs: 0}));
  } finally {
    await rm(original, {recursive: true, force: true});
    await rm(overridden, {recursive: true, force: true});
  }
});
