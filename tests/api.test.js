import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApi} from '../dist/extension/api.js';
const target = {owner: 'acme', repo: 'widget', number: 23};
const sha = 'a'.repeat(40);
const review = {
  fullDatabaseId: '11',
  state: 'APPROVED',
  author: {databaseId: 7},
  commit: {oid: sha},
};

function response(data) {
  return Response.json({data});
}

test('approval selects metadata at a fixed HTTPS destination and pins the commit', async () => {
  const calls = [];
  const api = createApi(async (url, options) => {
    calls.push({url, options});
    return response({addPullRequestReview: {pullRequestReview: review}});
  });
  assert.equal((await api.approve('PR_test', sha, 'fake-token')).state, 'APPROVED');
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fake-token');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.operationName, 'QuickApproveApprove');
  assert.deepEqual(payload.variables, {pullRequestId: 'PR_test', commitOid: sha});
  assert.match(payload.query, /event: APPROVE/);
  assert.doesNotMatch(payload.query, /\b(author|commit)\b/);
  assert.doesNotMatch(payload.query, /\b(body|location|title|email|name|url)\b/);
});

test('identity and PR queries receive only selected metadata', async () => {
  const calls = [];
  const api = createApi(async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push(payload);
    return payload.operationName === 'QuickApproveUser'
      ? response({viewer: {databaseId: 7, login: 'reviewer'}})
      : response({
          repository: {
            pullRequest: {
              id: 'PR_test',
              fullDatabaseId: '99',
              state: 'OPEN',
              merged: false,
              author: {databaseId: 8},
              headRefOid: sha,
            },
          },
        });
  });
  assert.deepEqual(await api.user('fake-token'), {id: 7, login: 'reviewer'});
  assert.deepEqual(await api.pull(target, 'fake-token'), {
    id: 99,
    nodeId: 'PR_test',
    state: 'open',
    merged: false,
    user: {id: 8, login: ''},
    head: {sha},
  });
  assert.deepEqual(calls[1].variables, {owner: 'acme', name: 'widget', number: 23});
  assert.doesNotMatch(calls[0].query, /\b(location|email|name|bio)\b/);
  assert.doesNotMatch(calls[1].query, /\b(body|location|title|email|url)\b/);
});

test('review pagination follows opaque cursors only at the fixed destination', async () => {
  const calls = [];
  const cursor = 'https://evil.test/steal';
  const api = createApi(async (url, options) => {
    calls.push({url, payload: JSON.parse(options.body)});
    return response({
      repository: {
        pullRequest: {
          reviews: {
            nodes: [review],
            pageInfo:
              calls.length === 1
                ? {hasNextPage: true, endCursor: cursor}
                : {hasNextPage: false, endCursor: null},
          },
        },
      },
    });
  });
  assert.equal((await api.reviews(target, 'fake-token', 'reviewer')).length, 2);
  assert.ok(calls.every((call) => call.url === 'https://api.github.com/graphql'));
  assert.equal(calls[0].payload.variables.cursor, null);
  assert.equal(calls[0].payload.variables.author, 'reviewer');
  assert.match(calls[0].payload.query, /author: \$author/);
  assert.equal(calls[1].payload.variables.cursor, cursor);
  assert.doesNotMatch(calls[0].payload.query, /\b(body|location|title|email|url)\b/);
});

test('missing, repeating, or cyclic review cursors fail instead of losing reviews or looping', async () => {
  for (const cursors of [[null], ['a', 'a'], ['a', 'b', 'a']]) {
    let count = 0;
    const api = createApi(async () =>
      response({
        repository: {
          pullRequest: {
            reviews: {
              nodes: [review],
              pageInfo: {hasNextPage: true, endCursor: cursors[count++]},
            },
          },
        },
      }),
    );
    await assert.rejects(api.reviews(target, 'fake-token', 'reviewer'));
    assert.equal(count, cursors.length);
  }
});

test('HTTP and GraphQL failures expose only safe classification and reject partial data', async () => {
  const http = createApi(async () => new Response('token-secret-private-data', {status: 403}));
  await assert.rejects(
    http.pull(target, 'fake-token'),
    (error) => error.status === 403 && !error.message.includes('secret'),
  );
  for (const [type, status] of [
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['RATE_LIMITED', 429],
    ['OTHER', undefined],
  ]) {
    const api = createApi(async () =>
      Response.json({
        data: {viewer: {databaseId: 7, login: 'reviewer'}},
        errors: [{type, message: 'token-secret-private-data'}],
      }),
    );
    await assert.rejects(
      api.user('fake-token'),
      (error) => error.status === status && !error.message.includes('secret'),
    );
  }
});

test('GraphQL mutation errors keep an unknown outcome even alongside partial success', async () => {
  const api = createApi(async () =>
    Response.json({
      data: {addPullRequestReview: {pullRequestReview: review}},
      errors: [{type: 'FORBIDDEN', message: 'private'}],
    }),
  );
  await assert.rejects(
    api.approve('PR_test', sha, 'fake-token'),
    (error) => error.status === undefined,
  );
});

test('missing objects and unsafe numeric IDs fail closed', async () => {
  for (const viewer of [null, {}, {databaseId: 7, login: ''}]) {
    const api = createApi(async () => response({viewer}));
    await assert.rejects(api.user('fake-token'));
  }
  for (const id of [null, '9007199254740993', 'invalid']) {
    const api = createApi(async () =>
      response({addPullRequestReview: {pullRequestReview: {...review, fullDatabaseId: id}}}),
    );
    await assert.rejects(api.approve('PR_test', sha, 'fake-token'));
  }
});

test('diagnostics distinguish response headers from a stalled JSON body without leaking requests', async () => {
  const events = [];
  let headersReceived;
  const headers = new Promise((resolve) => {
    headersReceived = resolve;
  });
  let body;
  const stream = new ReadableStream({
    start: (controller) => {
      body = controller;
    },
  });
  const traceId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
  const api = createApi(
    async () => new Response(stream, {headers: {'x-ratelimit-remaining': '123'}}),
    (name, fields) => {
      events.push({name, fields});
      if (name === 'api.headers') headersReceived();
    },
  );
  const pending = api.user('FAKE_SECRET_MARKER', traceId);
  await headers;
  assert.deepEqual(
    events.map((e) => e.name),
    ['api.begin', 'api.headers'],
  );
  assert.equal(events[1].fields.rateRemaining, 123);
  body.enqueue(
    new TextEncoder().encode(
      JSON.stringify({data: {viewer: {databaseId: 7, login: 'PRIVATE_BODY'}}}),
    ),
  );
  body.close();
  await pending;
  assert.equal(events.at(-1).name, 'api.end');
  assert.ok(events.every((e) => e.fields.traceId === traceId));
  for (const value of ['FAKE_SECRET_MARKER', 'PRIVATE_BODY', target.owner])
    assert.equal(JSON.stringify(events).includes(value), false);
});

test('a broken diagnostic hook cannot break API reads or approvals', async () => {
  const api = createApi(
    async () => response({addPullRequestReview: {pullRequestReview: review}}),
    () => {
      throw new Error('broken diagnostics');
    },
  );
  assert.equal((await api.approve('PR_test', sha, 'fake-token')).state, 'APPROVED');
});

test('PR-only tokens can read existing approvals without Contents permission', async () => {
  const api = createApi(async (url, options) => {
    const {query} = JSON.parse(options.body);
    if (/\bcommit\s*\{/.test(query)) return Response.json({errors: [{type: 'FORBIDDEN'}]});
    return response({
      repository: {
        pullRequest: {
          reviews: {
            nodes: [{fullDatabaseId: '11', state: 'APPROVED', author: {databaseId: 7}}],
            pageInfo: {hasNextPage: false, endCursor: null},
          },
        },
      },
    });
  });
  assert.deepEqual(await api.reviews(target, 'fake-token', 'reviewer'), [
    {id: 11, state: 'APPROVED', user: {id: 7, login: ''}},
  ]);
});

// Catches creating a second review, replacing its body, or submitting the wrong event.
test('pending review submission targets its node ID and leaves body unchanged', async () => {
  for (const [action, event, state] of [
    ['changes', 'REQUEST_CHANGES', 'CHANGES_REQUESTED'],
    ['comment', 'COMMENT', 'COMMENTED'],
    ['approve', 'APPROVE', 'APPROVED'],
  ]) {
    let payload;
    const api = createApi(async (url, options) => {
      assert.equal(url, 'https://api.github.com/graphql');
      payload = JSON.parse(options.body);
      return response({
        submitPullRequestReview: {pullRequestReview: {fullDatabaseId: '11', state}},
      });
    });
    assert.deepEqual(await api.submitReview('PRR_pending', action, 'fake-token'), {id: 11, state});
    assert.equal(payload.operationName, 'QuickApproveSubmitReview');
    assert.deepEqual(payload.variables, {reviewId: 'PRR_pending', event});
    assert.match(payload.query, /submitPullRequestReview/);
    assert.doesNotMatch(payload.query, /\bbody\b/);
  }
});

test('partial pending review submission errors retain an uncertain outcome', async () => {
  const api = createApi(async () =>
    Response.json({
      data: {
        submitPullRequestReview: {pullRequestReview: {fullDatabaseId: '11', state: 'APPROVED'}},
      },
      errors: [{type: 'FORBIDDEN'}],
    }),
  );
  await assert.rejects(
    api.submitReview('PRR_pending', 'approve', 'fake-token'),
    (error) => error.status === undefined,
  );
});
