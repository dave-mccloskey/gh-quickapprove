import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApi} from '../dist/extension/api.js';
const target = {owner: 'acme', repo: 'widget', number: 23};

test('approval uses fixed HTTPS route, pinned SHA, no cookies or redirects', async () => {
  const calls = [];
  const api = createApi(async (url, options) => {
    calls.push({url, options});
    return Response.json({id: 11, state: 'APPROVED'});
  });
  await api.approve(target, 'a'.repeat(40), 'fake-token');
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/widget/pulls/23/reviews');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fake-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    event: 'APPROVE',
    commit_id: 'a'.repeat(40),
  });
});

test('pagination constructs next pages rather than following hostile Link headers', async () => {
  const urls = [];
  const api = createApi(async (url) => {
    urls.push(url);
    return Response.json(
      urls.length === 1 ? Array.from({length: 100}, (_, id) => ({id})) : [{id: 100}],
      {headers: {Link: '<https://evil.test/steal>; rel="next"'}},
    );
  });
  assert.equal((await api.reviews(target, 'fake-token')).length, 101);
  assert.deepEqual(urls, [
    'https://api.github.com/repos/acme/widget/pulls/23/reviews?per_page=100&page=1',
    'https://api.github.com/repos/acme/widget/pulls/23/reviews?per_page=100&page=2',
  ]);
});

test('errors expose status and safe classification without copying server content', async () => {
  const api = createApi(async () => new Response('token-secret-private-data', {status: 403}));
  await assert.rejects(
    api.pull(target, 'fake-token'),
    (error) => error.status === 403 && !error.message.includes('secret'),
  );
});

test('diagnostics distinguish response headers from a stalled JSON body without leaking requests', async () => {
  const events = [];
  let body;
  const stream = new ReadableStream({
    start: (controller) => {
      body = controller;
    },
  });
  const traceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const api = createApi(
    async () => new Response(stream, {headers: {'x-ratelimit-remaining': '123'}}),
    (name, fields) => events.push({name, fields}),
  );
  const pending = api.pull(target, 'FAKE_SECRET_MARKER', traceId);
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(
    events.map((e) => e.name),
    ['api.begin', 'api.headers'],
  );
  assert.equal(events[1].fields.rateRemaining, 123);
  body.enqueue(new TextEncoder().encode('{"privateBody":"PRIVATE_BODY"}'));
  body.close();
  await pending;
  assert.equal(events.at(-1).name, 'api.end');
  assert.ok(events.every((e) => e.fields.traceId === traceId));
  for (const value of ['FAKE_SECRET_MARKER', 'PRIVATE_BODY', '/repos/', target.owner])
    assert.equal(JSON.stringify(events).includes(value), false);
});

test('a broken diagnostic hook cannot break API reads or approvals', async () => {
  const api = createApi(
    async () => Response.json({id: 1, state: 'APPROVED'}),
    () => {
      throw new Error('broken diagnostics');
    },
  );
  assert.equal((await api.approve(target, 'b'.repeat(40), 'fake-token')).state, 'APPROVED');
});
