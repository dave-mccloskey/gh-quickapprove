import assert from 'node:assert/strict';
import {test} from 'node:test';
import {submitPackage} from '../scripts/store.js';

function api(responses) {
  const calls = [];
  return {
    calls,
    request: async (url, options) => {
      calls.push({url, ...options});
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error('Unexpected API request');
      return new Response(JSON.stringify(next.body), {status: next.status ?? 200});
    },
  };
}

const settings = {
  publisher: 'publisher-test',
  item: 'a'.repeat(32),
  token: 'fake-test-token',
  version: '2032.2.29.1',
  mode: 'upload-only',
  bytes: new Uint8Array([1, 2]),
  wait: async () => {},
};

test('upload-only waits for async completion and never submits for review', async () => {
  const fake = api([
    {body: {}},
    {body: {uploadState: 'IN_PROGRESS'}},
    {body: {lastAsyncUploadState: 'IN_PROGRESS'}},
    {body: {lastAsyncUploadState: 'SUCCEEDED'}},
  ]);
  const result = await submitPackage({...settings, request: fake.request});
  assert.equal(result.uploadState, 'SUCCEEDED');
  assert.equal(fake.calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(fake.calls[1].url.startsWith('https://chromewebstore.googleapis.com/upload/v2/'));
  assert.equal(fake.calls[1].body, settings.bytes);
});

test('review submission preserves review and blocks warnings', async () => {
  const fake = api([
    {body: {}},
    {body: {uploadState: 'SUCCEEDED', crxVersion: settings.version}},
    {body: {state: 'PENDING_REVIEW'}},
    {body: {submittedItemRevisionStatus: {state: 'PENDING_REVIEW'}}},
  ]);
  const result = await submitPackage({
    ...settings,
    mode: 'submit-for-review',
    request: fake.request,
  });
  assert.equal(result.submissionState, 'PENDING_REVIEW');
  assert.deepEqual(JSON.parse(fake.calls[2].body), {
    publishType: 'DEFAULT_PUBLISH',
    skipReview: false,
    blockOnWarnings: true,
  });
});

test('upload failure, mismatched version, and processing timeout never publish', async () => {
  for (const response of [
    {uploadState: 'FAILED'},
    {uploadState: 'SUCCEEDED', crxVersion: '2032.2.29.2'},
    {uploadState: 'IN_PROGRESS'},
  ]) {
    const fake = api([
      {body: {}},
      {body: response},
      ...Array.from({length: 3}, () => ({body: {lastAsyncUploadState: 'IN_PROGRESS'}})),
    ]);
    await assert.rejects(
      submitPackage({
        ...settings,
        mode: 'submit-for-review',
        request: fake.request,
        pollAttempts: 3,
      }),
    );
    assert.equal(
      fake.calls.some((call) => call.url.endsWith(':publish')),
      false,
    );
  }
});

test('uncertain writes are not retried and raw API errors cannot leak tokens', async () => {
  const fake = api([{body: {}}, {status: 401, body: {message: settings.token}}]);
  await assert.rejects(
    submitPackage({...settings, request: fake.request}),
    (error) => !error.message.includes(settings.token),
  );
  assert.equal(fake.calls.length, 2);
  const lost = api([{body: {}}, new Error(`network ${settings.token}`)]);
  await assert.rejects(
    submitPackage({...settings, request: lost.request}),
    (error) => !error.message.includes(settings.token),
  );
  assert.equal(lost.calls.length, 2);
});

test('invalid inputs and published or pending versions stop before upload', async () => {
  const fake = api([]);
  await assert.rejects(submitPackage({...settings, publisher: '../other', request: fake.request}));
  await assert.rejects(submitPackage({...settings, mode: 'wrong', request: fake.request}));
  assert.equal(fake.calls.length, 0);
  for (const body of [
    {lastAsyncUploadState: 'IN_PROGRESS'},
    {publishedItemRevisionStatus: {distributionChannels: [{crxVersion: settings.version}]}},
    {submittedItemRevisionStatus: {state: 'PENDING_REVIEW'}},
  ]) {
    const pending = api([{body}]);
    await assert.rejects(submitPackage({...settings, request: pending.request}));
    assert.equal(pending.calls.length, 1);
  }
});
