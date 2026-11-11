import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {zipSync, strToU8} from 'fflate';
import {nextRelease, chromeVersion} from '../scripts/release-version.js';
import {verifyPackage} from '../scripts/verify-release.js';

test('release numbering uses Pacific dates and the largest existing daily sequence', () => {
  assert.equal(
    nextRelease(['2032.02.28.2', '2032.02.28.9', 'other'], new Date('2032-02-29T07:00:00Z')),
    '2032.02.28.10',
  );
  assert.equal(nextRelease(['2032.02.28.9'], new Date('2032-02-29T09:00:00Z')), '2032.02.29.1');
});

test('Chrome versions remove padding and reject malformed dates and numeric overflow', () => {
  assert.equal(chromeVersion('2032.02.29.12'), '2032.2.29.12');
  for (const name of [
    '2031.02.29.1',
    '2032.13.01.1',
    '2032.01.01.0',
    '2032.1.01.1',
    '2032.01.01.01',
    '2032.01.01.65536',
    '../2032.01.01.1',
  ]) {
    assert.throws(() => chromeVersion(name));
  }
  assert.throws(() => nextRelease(['2032.02.29.65535'], new Date('2032-02-29T12:00:00Z')));
});

test('submission verifies exact ZIP bytes and both manifest versions', () => {
  const release = '2032.02.29.3';
  const bytes = zipSync({
    'manifest.json': strToU8(JSON.stringify({version: '2032.2.29.3', version_name: release})),
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    verifyPackage(bytes, `${digest}  gh-quickapprove-${release}.zip\n`, release),
    '2032.2.29.3',
  );
  assert.throws(() =>
    verifyPackage(bytes, `${'0'.repeat(64)}  gh-quickapprove-${release}.zip\n`, release),
  );
  assert.throws(() =>
    verifyPackage(bytes, `${digest}  gh-quickapprove-${release}.zip\n`, '2032.02.29.4'),
  );
  assert.throws(() => verifyPackage(bytes, `${digest}  wrong.zip\n`, release));
});
