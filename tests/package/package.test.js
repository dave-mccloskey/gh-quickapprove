import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile, access} from 'node:fs/promises';
import {test} from 'node:test';
import {unzipSync} from 'fflate';

test('clean build discards stale executables and ZIP contains only loadable extension assets', async () => {
  await writeFile('dist/extension/stale.js', 'throw new Error("stale");');
  execFileSync(process.execPath, ['scripts/build.js'], {stdio: 'pipe'});
  await assert.rejects(access('dist/extension/stale.js'));
  execFileSync(process.execPath, ['scripts/package.js'], {stdio: 'pipe'});
  const files = unzipSync(await readFile('dist/gh-quickapprove.zip'));
  const names = Object.keys(files);
  assert.equal(
    names.some((name) => /(?:\.ts$|\.map$|test|node_modules|README|plan)/.test(name)),
    false,
  );
  const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(files[manifest.background.service_worker]);
  assert.ok(files[manifest.options_ui.page]);
  for (const script of manifest.content_scripts) {
    for (const asset of [...script.js, ...script.css]) assert.ok(files[asset]);
  }
  for (const name of names.filter((name) => name.endsWith('.js'))) {
    const code = new TextDecoder().decode(files[name]);
    for (const match of code.matchAll(/from ['"]\.\/([^'"]+)['"]/g))
      assert.ok(files[match[1]], `${name}: ${match[1]}`);
  }
});
