import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  createDiagnostics,
  diagnosticErrorFields,
  sanitizeDiagnosticFields,
} from '../dist/extension/diagnostics.js';

function harness() {
  const values = new Map();
  let clock = 1_800_000_000_000;
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => values.set(key, structuredClone(value)),
  };
  const make = (overrides = {}) => createDiagnostics({storage, now: () => clock, ...overrides});
  return {
    values,
    storage,
    make,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test('diagnostics retain allowlisted evidence and pseudonyms without sensitive payloads', async () => {
  const h = harness();
  const d = h.make();
  await d.ready;
  d.record(
    'message.begin',
    {
      op: 'state',
      spanId: 'a'.repeat(8) + '-aaaa-4aaa-aaaa-' + 'a'.repeat(12),
      token: 'FAKE_SECRET_MARKER',
      url: 'https://private.example',
      label: 'PRIVATE_LABEL',
      state: 'PRIVATE_LABEL',
      durationMs: 42,
    },
    {tabId: 23, documentId: 'PRIVATE_DOCUMENT', target: 'PRIVATE_REPOSITORY/123'},
  );
  d.record('PRIVATE_EVENT', {op: 'FAKE_SECRET_MARKER'});
  const report = await d.export();
  const text = JSON.stringify(report);
  assert.ok(text.includes('message.begin'));
  assert.equal(report.events.at(-1).fields.durationMs, 42);
  for (const secret of [
    'FAKE_SECRET_MARKER',
    'PRIVATE_LABEL',
    'PRIVATE_DOCUMENT',
    'PRIVATE_REPOSITORY',
    'private.example',
  ])
    assert.equal(text.includes(secret), false);
  assert.match(report.events.at(-1).context.target, /^[a-f0-9]{16}$/);
  assert.equal('secret' in report, false);
});

test('unfinished spans and pseudonyms survive a worker restart', async () => {
  const h = harness();
  const first = h.make();
  await first.ready;
  first.record(
    'api.begin',
    {endpoint: 'reviews', spanId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'},
    {target: 'private-target'},
  );
  const before = await first.export();
  await first.flush();
  h.advance(1000);
  const second = h.make();
  const after = await second.export();
  assert.equal(after.unfinished[0].interrupted, true);
  assert.equal(after.unfinished[0].event.context.target, before.unfinished[0].event.context.target);
  assert.notEqual(after.workerSession, before.workerSession);
});

test('retention and event bounds prune history and count discarded events', async () => {
  const h = harness();
  h.values.set('diagnosticHistory', {
    schema: 1,
    enabled: true,
    secret: 'a'.repeat(64),
    events: Array.from({length: 2000}, (_, count) => ({
      time: 1_800_000_000_000,
      session: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      name: 'ui.control',
      fields: {count},
      context: {},
    })),
    open: [],
    discarded: 97,
  });
  const d = h.make();
  await d.ready;
  for (let count = 2000; count < 2003; count++) d.record('ui.control', {count});
  let report = await d.export();
  assert.equal(report.events.length, 2000);
  assert.equal(report.discardedEvents, 100);
  assert.equal(report.events[0].fields.count, 3);
  assert.equal(report.events.at(-1).fields.count, 2002);
  h.advance(8 * 24 * 60 * 60 * 1000);
  report = await d.export();
  assert.equal(report.events.length, 0);
  assert.equal(report.discardedEvents, 2100);
});

test('disable and clear preserve credentials and approval attempt records', async () => {
  const h = harness();
  h.values.set('credential', {token: 'FAKE_SECRET_MARKER'});
  h.values.set('attempt:example', {id: 'attempt'});
  const d = h.make();
  await d.ready;
  await d.setEnabled(false);
  d.record('api.begin', {endpoint: 'pull'});
  assert.equal(
    (await d.export()).events.some((e) => e.name === 'api.begin'),
    false,
  );
  await d.clear();
  assert.equal((await d.export()).events.length, 0);
  assert.equal(h.values.get('credential').token, 'FAKE_SECRET_MARKER');
  assert.deepEqual(h.values.get('attempt:example'), {id: 'attempt'});
  const again = h.make();
  assert.equal((await again.export()).enabled, false);
});

test('failed diagnostic persistence leaves live evidence and reports its limitation', async () => {
  const h = harness();
  const d = h.make({
    storage: {
      ...h.storage,
      set: async () => {
        throw new Error('FAKE_SECRET_MARKER');
      },
    },
  });
  await d.ready;
  d.record('ui.stalled', {state: 'loading', durationMs: 60000});
  const report = await d.export();
  assert.ok(report.events.some((e) => e.name === 'ui.stalled'));
  assert.ok(report.persistence.failures > 0);
  assert.equal(JSON.stringify(report).includes('FAKE_SECRET_MARKER'), false);
});

test('clear and recording changes report failed persistence even after an earlier successful write', async () => {
  const h = harness();
  let fail = false;
  const d = h.make({
    storage: {
      ...h.storage,
      set: (key, value) =>
        fail ? Promise.reject(new Error('private-error')) : h.storage.set(key, value),
    },
  });
  await d.ready;
  d.record('worker.start');
  await d.flush();
  fail = true;
  await assert.rejects(d.clear());
  await assert.rejects(d.setEnabled(false));
});

async function exportAfterDeadline(t, diagnostics) {
  const schedule = globalThis.setTimeout;
  let deadlineScheduled;
  const scheduled = new Promise((resolve) => {
    deadlineScheduled = resolve;
  });
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    const timer = schedule(callback, milliseconds, ...args);
    deadlineScheduled(milliseconds);
    return timer;
  });
  const report = diagnostics.export();
  assert.equal(await scheduled, 1500);
  t.mock.timers.tick(1499);
  let settled = false;
  void report.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  return report;
}

test('a hung diagnostic write does not prevent export of live evidence', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const h = harness();
  const d = h.make({storage: {...h.storage, set: () => new Promise(() => {})}});
  await d.ready;
  d.record('ui.stalled', {state: 'loading'});
  const report = await exportAfterDeadline(t, d);
  assert.ok(report.events.some((e) => e.name === 'ui.stalled'));
  assert.ok(report.persistence.pendingSince);
});

test('unreadable history cannot block a report or leak its storage error', async () => {
  const h = harness();
  const d = h.make({
    storage: {
      ...h.storage,
      get: async () => {
        throw new Error('PRIVATE_READ_ERROR');
      },
    },
  });
  await d.ready;
  d.record('worker.start');
  const report = await d.export();
  assert.equal(report.persistence.available, false);
  assert.equal(report.enabled, false);
  assert.equal(report.events.length, 0);
  assert.equal(JSON.stringify(report).includes('PRIVATE_READ_ERROR'), false);
});

test('retention removes expired persisted history while recording is disabled', async () => {
  const h = harness();
  const d = h.make();
  await d.ready;
  d.record('worker.start');
  await d.setEnabled(false);
  assert.ok(h.values.get('diagnosticHistory').events.length > 0);
  h.advance(8 * 24 * 60 * 60 * 1000);
  await d.export();
  assert.equal(h.values.get('diagnosticHistory').events.length, 0);
});

test('a pending storage write is not reported as durable', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const h = harness();
  const d = h.make({storage: {...h.storage, set: () => new Promise(() => {})}});
  await d.ready;
  d.record('worker.start');
  const report = await exportAfterDeadline(t, d);
  assert.equal(report.persistence.upToDate, false);
});

test('exception evidence retains only packaged script coordinates', () => {
  const error = new TypeError('PRIVATE_ERROR_TEXT');
  error.stack = `PRIVATE_ERROR_TEXT\n at token-secret (https://private.invalid/repo.js:99:1)\n at request (chrome-extension://${'b'.repeat(32)}/api.js:42:7)`;
  const clean = sanitizeDiagnosticFields(diagnosticErrorFields(error));
  assert.deepEqual(clean, {line: 42, column: 7, file: 'api.js', error: 'TypeError'});
  assert.equal(JSON.stringify(clean).includes('PRIVATE'), false);
});
