import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createService} from '../dist/extension/service.js';

test('diagnostics identify queue wait separately from execution without exposing targets', async () => {
  const events = [];
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  let first = true;
  let pullStarted;
  const pulling = new Promise((resolve) => {
    pullStarted = resolve;
  });
  let secondEntered;
  const queued = new Promise((resolve) => {
    secondEntered = resolve;
  });
  const h = harness({
    trace: (name, fields) => {
      events.push({name, fields});
      if (name === 'queue.enter' && fields.pending === 2) secondEntered();
    },
    api: {
      pull: async () => {
        if (first) {
          first = false;
          pullStarted();
          await gate;
        }
        return {id: 99, state: 'open', merged: false, user: {id: 8}, head: {sha: 'a'.repeat(40)}};
      },
    },
  });
  await h.save();
  const one = h.state();
  await pulling;
  const two = h.state();
  await queued;
  assert.equal(events.filter((e) => e.name === 'queue.enter').length, 2);
  assert.equal(events.filter((e) => e.name === 'queue.start').length, 1);
  assert.equal(
    events.find((e) => e.name === 'queue.enter' && e.fields.pending === 2).fields.op,
    'state',
  );
  release();
  await Promise.all([one, two]);
  assert.equal(events.filter((e) => e.name === 'queue.start').length, 2);
  assert.equal(JSON.stringify(events).includes('reviewer'), false);
});

function harness(overrides = {}) {
  const values = new Map();
  const writes = [];
  const user = {id: 7, login: 'reviewer'};
  const pr = {id: 99, state: 'open', merged: false, user: {id: 8}, head: {sha: 'a'.repeat(40)}};
  let reviews = [];
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    remove: async (key) => {
      values.delete(key);
    },
  };
  const api = {
    user: async (token) => {
      if (token === 'bad') throw Object.assign(new Error('secret must not escape'), {status: 401});
      return user;
    },
    pull: async () => pr,
    reviews: async () => reviews,
    approve: async (target, sha, token) => {
      writes.push({target, sha, token});
      const result = {id: 101, user, state: 'APPROVED', commit_id: sha};
      reviews = [...reviews, result];
      return result;
    },
    ...overrides.api,
  };
  const dependencies = {
    storage,
    api,
    extensionId: 'test-extension',
    verifyContext: async () => true,
    notify: async () => {},
    openSettings: async () => {},
    ...overrides,
  };
  dependencies.api = api;
  const service = createService(dependencies);
  const options = {id: 'test-extension', url: 'chrome-extension://test-extension/options.html'};
  const sender = {
    id: 'test-extension',
    frameId: 0,
    documentId: 'doc-1',
    url: 'https://github.com/acme/widget/pull/23',
    tab: {id: 1},
  };
  const message = {pageUser: 'reviewer', generation: 1};
  return {
    values,
    writes,
    user,
    pr,
    storage,
    api,
    dependencies,
    service,
    options,
    sender,
    message,
    setReviews: (value) => {
      reviews = value;
    },
    save: (token = 'valid') => service.handle({op: 'setToken', token}, options),
    state: () => service.handle({op: 'state', ...message}, sender),
    approve: () => service.handle({op: 'approve', ...message, sha: pr.head.sha}, sender),
  };
}

test('only the packaged options page can set or read credentials', async () => {
  const h = harness();
  await assert.rejects(h.service.handle({op: 'setToken', token: 'valid'}, h.sender));
  await assert.rejects(h.service.handle({op: 'status'}, {...h.options, url: 'https://evil.test/'}));
  assert.equal((await h.save()).login, 'reviewer');
  const status = await h.service.handle({op: 'status'}, h.options);
  assert.equal(status.login, 'reviewer');
  assert.equal(JSON.stringify(status).includes('valid'), false);
  assert.equal(JSON.stringify(await h.state()).includes('valid'), false);
});

test('bad token candidates preserve the working credential and sanitize errors', async () => {
  const h = harness();
  await h.save();
  const failed = await h.save('bad');
  assert.equal(failed.kind, 'invalid');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
  assert.equal((await h.state()).kind, 'available');
});

test('token removal prevents a late validation from restoring it', async () => {
  let resolve;
  let validating;
  const started = new Promise((done) => {
    validating = done;
  });
  const h = harness({
    api: {
      user: () =>
        new Promise((done) => {
          resolve = done;
          validating();
        }),
    },
  });
  const save = h.save();
  await started;
  await h.service.handle({op: 'removeToken'}, h.options);
  resolve(h.user);
  assert.equal((await save).kind, 'canceled');
  assert.equal((await h.state()).kind, 'setup');
});

test('rejects child frames, foreign senders, destinations and mutation fields', async () => {
  const h = harness();
  await h.save();
  for (const sender of [
    {...h.sender, frameId: 2},
    {...h.sender, id: 'foreign'},
    {...h.sender, url: 'https://evil.test/acme/widget/pull/23'},
    {...h.sender, documentId: undefined},
  ]) {
    await assert.rejects(
      h.service.handle({op: 'approve', ...h.message, sha: h.pr.head.sha}, sender),
    );
  }
  await assert.rejects(
    h.service.handle(
      {op: 'approve', ...h.message, sha: h.pr.head.sha, url: 'https://evil.test'},
      h.sender,
    ),
  );
  assert.equal(h.writes.length, 0);
});

test('pins a single immediate approval to the loaded SHA and journals before POST', async () => {
  const h = harness();
  await h.save();
  const approve = h.api.approve;
  h.api.approve = async (...args) => {
    assert.equal(
      [...h.values.keys()].some((key) => key.startsWith('attempt:')),
      true,
    );
    return approve(...args);
  };
  assert.equal((await h.approve()).kind, 'approved');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].sha, 'a'.repeat(40));
  assert.equal((await h.approve()).kind, 'approved');
  assert.equal(h.writes.length, 1);
});

test('blocks pending review, account mismatch, own PR and changed commits', async () => {
  const h = harness();
  await h.save();
  h.setReviews([{id: 1, user: h.user, state: 'PENDING'}]);
  assert.equal((await h.approve()).kind, 'pending');
  h.setReviews([]);
  h.message.pageUser = 'other-user';
  assert.equal((await h.approve()).kind, 'account');
  h.message.pageUser = 'reviewer';
  assert.equal(
    (await h.service.handle({op: 'approve', ...h.message, sha: 'b'.repeat(40)}, h.sender)).kind,
    'changed',
  );
  h.pr.user = h.user;
  assert.equal((await h.approve()).kind, 'own');
  assert.equal(h.writes.length, 0);
});

test('concurrent tabs cannot create duplicate writes', async () => {
  const h = harness();
  await h.save();
  await Promise.all([h.approve(), h.approve()]);
  assert.equal(h.writes.length, 1);
});

test('persistence failure prevents dispatch', async () => {
  const h = harness();
  await h.save();
  h.storage.set = async () => {
    throw new Error('disk unavailable');
  };
  assert.equal((await h.approve()).kind, 'error');
  assert.equal(h.writes.length, 0);
});

test('lost response remains blocked across restarts and token replacement', async () => {
  const h = harness({
    api: {
      approve: async () => {
        throw new Error('lost response');
      },
    },
  });
  await h.save();
  assert.equal((await h.approve()).kind, 'uncertain');
  const restarted = createService(h.dependencies);
  await restarted.handle({op: 'removeToken'}, h.options);
  await restarted.handle({op: 'setToken', token: 'replacement'}, h.options);
  assert.equal(
    (await restarted.handle({op: 'approve', ...h.message, sha: h.pr.head.sha}, h.sender)).kind,
    'uncertain',
  );
  assert.equal((await restarted.handle({op: 'recheck', ...h.message}, h.sender)).kind, 'uncertain');
  assert.equal(
    (await restarted.handle({op: 'resetAttempt', ...h.message}, h.sender)).kind,
    'available',
  );
  assert.equal(h.writes.length, 0);
});

test('reconciles a successful write with a lost response from new authoritative review', async () => {
  const h = harness();
  await h.save();
  const approve = h.api.approve;
  h.api.approve = async (...args) => {
    await approve(...args);
    throw new Error('lost response');
  };
  assert.equal((await h.approve()).kind, 'uncertain');
  assert.equal((await h.state()).kind, 'approved');
  assert.equal(h.writes.length, 1);
  assert.equal(
    [...h.values.keys()].some((key) => key.startsWith('attempt:')),
    false,
  );
});

test('stale document acknowledgment and changed credentials stop preflight writes', async () => {
  const h = harness({verifyContext: async () => false});
  await h.save();
  assert.equal((await h.approve()).kind, 'canceled');
  assert.equal(h.writes.length, 0);
  h.dependencies.verifyContext = async () => true;
});

test('401 invalidates a saved token without retrying it on further reads', async () => {
  const h = harness();
  await h.save();
  let calls = 0;
  h.api.pull = async () => {
    calls++;
    throw Object.assign(new Error('unauthorized'), {status: 401});
  };
  assert.equal((await h.state()).kind, 'invalid');
  assert.equal((await h.state()).kind, 'invalid');
  assert.equal(calls, 1);
});

test('cross-tab notification observes the completed state after releasing write lock', async () => {
  const observed = [];
  let h;
  h = harness({
    notify: async () => {
      if (h) observed.push((await h.state()).kind);
    },
  });
  await h.save();
  observed.length = 0;
  await h.approve();
  assert.equal(observed.at(-1), 'approved');
});

test('token removal during final context acknowledgment prevents dispatch', async () => {
  let h;
  let confirmations = 0;
  h = harness({
    verifyContext: async () => {
      if (++confirmations === 2) await h.service.handle({op: 'removeToken'}, h.options);
      return true;
    },
  });
  await h.save();
  assert.equal((await h.approve()).kind, 'canceled');
  assert.equal(h.writes.length, 0);
});

test('a superseded token save cannot erase a newer successful save', async () => {
  const h = harness();
  const set = h.storage.set;
  let release;
  let started;
  const pending = new Promise((done) => {
    release = done;
  });
  const writing = new Promise((done) => {
    started = done;
  });
  h.storage.set = async (key, value) => {
    await set(key, value);
    if (key === 'credential' && value.token === 'first-token') {
      started();
      await pending;
    }
  };
  const first = h.save('first-token');
  await writing;
  const second = h.save('second-token');
  release();
  await Promise.all([first, second]);
  assert.equal(h.values.get('credential')?.token, 'second-token');
});

test('a delayed 401 response cannot restore a removed credential', async () => {
  const h = harness();
  await h.save();
  h.api.pull = async () => {
    throw Object.assign(new Error('unauthorized'), {status: 401});
  };
  const get = h.storage.get;
  let release;
  let started;
  let reads = 0;
  const gate = new Promise((done) => {
    release = done;
  });
  const checking = new Promise((done) => {
    started = done;
  });
  h.storage.get = async (key) => {
    const value = await get(key);
    if (key === 'credential' && ++reads === 2) {
      started();
      await gate;
    }
    return value;
  };
  const pending = h.state();
  await checking;
  await h.service.handle({op: 'removeToken'}, h.options);
  release();
  await pending;
  assert.equal((await h.state()).kind, 'setup');
});

test('stale state reconciliation cannot erase a newer uncertain attempt', async () => {
  const h = harness();
  await h.save();
  h.values.set('attempt:7:99', {
    id: 'old-attempt',
    accountId: 7,
    prId: 99,
    sha: h.pr.head.sha,
    reviewIds: [],
  });
  h.setReviews([
    {id: 10, user: h.user, state: 'APPROVED', commit_id: h.pr.head.sha},
    {id: 11, user: h.user, state: 'CHANGES_REQUESTED', commit_id: h.pr.head.sha},
  ]);
  const remove = h.storage.remove;
  let release;
  let started;
  let first = true;
  const gate = new Promise((done) => {
    release = done;
  });
  const reconciling = new Promise((done) => {
    started = done;
  });
  h.storage.remove = async (key) => {
    if (key === 'attempt:7:99' && first) {
      first = false;
      started();
      await gate;
    }
    await remove(key);
  };
  h.api.approve = async (target, sha, token) => {
    h.writes.push({target, sha, token});
    throw new Error('lost response');
  };
  const stale = h.state();
  await reconciling;
  const approval = h.approve();
  release();
  await Promise.all([stale, approval]);
  assert.equal((await h.state()).kind, 'uncertain');
  assert.equal((await h.approve()).kind, 'uncertain');
  assert.equal(h.writes.length, 1);
});
