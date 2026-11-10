import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePrUrl, reduceState} from '../dist/extension/shared.js';

const user = {id: 7, login: 'reviewer'};
const pr = {id: 99, state: 'open', merged: false, user: {id: 8}, head: {sha: 'a'.repeat(40)}};
const review = (id, state) => ({id, state, user, commit_id: pr.head.sha});
const state = (overrides = {}) =>
  reduceState({pr, user, reviews: [], pageUser: 'reviewer', ...overrides});

test('parses only HTTPS GitHub PR routes and supported subpages', () => {
  for (const suffix of [
    '',
    '/commits',
    '/checks',
    '/files',
    '/changes',
    '/commits/abcdef',
    '/files/src/test.js',
  ]) {
    assert.deepEqual(parsePrUrl(`https://github.com/acme/widget/pull/23${suffix}?x=1#diff`), {
      owner: 'acme',
      repo: 'widget',
      number: 23,
      key: 'acme/widget/23',
    });
  }
});

test('rejects foreign origins and route/path injection', () => {
  for (const url of [
    'http://github.com/a/b/pull/1',
    'https://github.com.evil.test/a/b/pull/1',
    'https://github.com:444/a/b/pull/1',
    'https://github.com/a/b/issues/1',
    'https://github.com/a/b/pull/0',
    'https://github.com/a/b/pull/9007199254740992',
    'https://github.com/a/%2e%2e/pull/1',
    'https://github.com/a/b%2fc/pull/1',
    'https://github.com/a/b/pull/1/evil',
    'https://user@github.com/a/b/pull/1',
    'not a url',
  ])
    assert.equal(parsePrUrl(url), null, url);
});

test('only a current decisive approval disables approval', () => {
  assert.equal(state().kind, 'available');
  assert.equal(state({reviews: [review(1, 'APPROVED'), review(2, 'COMMENTED')]}).kind, 'approved');
  assert.equal(state({reviews: [review(1, 'APPROVED'), review(2, 'DISMISSED')]}).kind, 'available');
  assert.equal(
    state({reviews: [review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED')]}).kind,
    'available',
  );
  assert.equal(state({reviews: [review(1, 'PENDING')]}).kind, 'pending');
});

test('blocks own PR, account mismatch, closed, merged and uncertain outcomes', () => {
  assert.equal(state({pr: {...pr, user}}).kind, 'own');
  assert.equal(state({pageUser: 'another-user'}).kind, 'account');
  assert.equal(state({pageUser: ''}).kind, 'account');
  assert.equal(state({pageUser: 'REVIEWER'}).kind, 'available');
  assert.equal(state({pr: {...pr, state: 'closed'}}).kind, 'closed');
  assert.equal(state({pr: {...pr, state: 'closed', merged: true}}).kind, 'merged');
  assert.equal(state({pendingAttempt: true}).kind, 'uncertain');
});
