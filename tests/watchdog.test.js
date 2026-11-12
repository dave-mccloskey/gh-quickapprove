import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const source = readFileSync('dist/extension/watchdog.js', 'utf8');

test('stall deadline starts with the pending state rather than script initialization', (t) => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const calls = [];
  const watchdog = makeWatchdog(30000, (elapsed) => calls.push(elapsed));
  t.mock.timers.tick(10000);
  watchdog.start();
  t.mock.timers.tick(29999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [30000]);
  t.mock.timers.tick(30000);
  assert.deepEqual(calls, [30000, 60000]);
  watchdog.stop();
});

test('an early callback waits only the remaining deadline instead of another full interval', (t) => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const calls = [];
  let offset = 0;
  const watchdog = makeWatchdog(
    30000,
    (elapsed) => calls.push(elapsed),
    () => Date.now() + offset,
  );
  watchdog.start();
  offset = -1;
  t.mock.timers.tick(30000);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [30000]);
  watchdog.stop();
});

test('stop and restart discard the previous state deadline', (t) => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 10000});
  const calls = [];
  const watchdog = makeWatchdog(30000, (elapsed) => calls.push(elapsed));
  watchdog.start();
  t.mock.timers.tick(10000);
  watchdog.stop();
  t.mock.timers.tick(60000);
  assert.deepEqual(calls, []);
  watchdog.start();
  t.mock.timers.tick(30000);
  assert.deepEqual(calls, [30000]);
  watchdog.stop();
});

function makeWatchdog(duration, callback, now = () => Date.now()) {
  const factory = runInNewContext(`${source}\ncreateStallWatchdog;`, {
    performance: {now},
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (timer) => globalThis.clearTimeout(timer),
  });
  return factory(duration, callback);
}
