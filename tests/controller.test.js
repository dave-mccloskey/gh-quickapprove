import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const {initialController, transitionController} = runInNewContext(
  `${readFileSync('dist/extension/controller.js', 'utf8')}\n({initialController, transitionController});`,
);
const context = {route: '/example/widget/pull/4573', pageUser: 'reviewer'};
const available = {kind: 'available', label: 'Quick approve', sha: 'a'.repeat(40)};
const approved = {...available, kind: 'approved', label: 'You approved this PR'};
const merged = {...available, kind: 'merged', label: 'This PR is merged'};
const step = (state, event) => transitionController(state, {now: 100, ...event});
function reading() {
  return step(initialController(), {type: 'observe', context, pageState: 'open'});
}
function ready() {
  const state = reading();
  return step(state, {type: 'complete', token: state.operation, view: available});
}

test('context replacement discards the accepted view and fences every old completion', () => {
  for (const state of [reading(), step(ready(), {type: 'approve'})]) {
    const next = step(state, {
      type: 'observe',
      context: {...context, route: '/example/widget/pull/23'},
      pageState: 'open',
    });
    assert.equal(next.phase, 'reading');
    assert.equal(next.view.kind, 'loading');
    assert.equal(step(next, {type: 'complete', token: state.operation, view: merged}), next);
    const inactive = step(next, {type: 'observe', context: null, pageState: ''});
    assert.equal(inactive.phase, 'inactive');
    assert.equal(step(inactive, {type: 'complete', token: next.operation, view: merged}), inactive);
  }
});

test('ordinary refreshes coalesce and forced refreshes replace the read token', () => {
  const state = reading();
  assert.equal(step(state, {type: 'refresh', op: 'state'}), state);
  const next = step(state, {type: 'refresh', op: 'state', force: true});
  assert.notEqual(next.operation.number, state.operation.number);
  assert.equal(step(next, {type: 'complete', token: state.operation, view: merged}), next);
  assert.equal(
    step(next, {type: 'complete', token: next.operation, view: available}).phase,
    'idle',
  );
});

test('approval supersedes a pending read and its late response cannot replace approval', () => {
  const read = step(ready(), {type: 'refresh', op: 'state'});
  const write = step(read, {type: 'approve'});
  assert.equal(write.phase, 'approving');
  assert.equal(write.sha, available.sha);
  assert.equal(step(write, {type: 'complete', token: read.operation, view: merged}), write);
  const done = step(write, {type: 'complete', token: write.operation, view: approved});
  assert.equal(done.view.kind, 'approved');
  assert.equal(step(done, {type: 'complete', token: read.operation, view: available}), done);
  assert.equal(step(write, {type: 'approve'}), write);
});

test('badge changes during approval schedule exactly one read when approval finishes', () => {
  const write = step(ready(), {type: 'approve'});
  assert.equal(step(write, {type: 'refresh', op: 'state', force: true}), write);
  const dirty = step(write, {type: 'observe', context, pageState: 'merged'});
  assert.equal(dirty.phase, 'approving');
  assert.equal(dirty.deferredRefresh, true);
  const next = step(dirty, {type: 'complete', token: write.operation, view: approved});
  assert.equal(next.phase, 'reading');
  assert.equal(next.view.kind, 'approved');
  assert.equal(step(next, {type: 'observe', context, pageState: 'merged'}), next);
  assert.equal(
    step(next, {type: 'complete', token: next.operation, view: merged}).view.kind,
    'merged',
  );
});

test('navigation and cached restoration invalidate active tokens even for the same PR', () => {
  for (const state of [reading(), step(ready(), {type: 'approve'})]) {
    const reset = step(state, {type: 'reset'});
    const next = step(reset, {type: 'observe', context, pageState: 'open'});
    assert.equal(next.phase, 'reading');
    assert.ok(next.epoch > state.epoch);
    assert.equal(step(next, {type: 'complete', token: state.operation, view: available}), next);
  }
});

test('account changes invalidate the view and only an available view with SHA permits approval', () => {
  const state = ready();
  const next = step(state, {
    type: 'observe',
    context: {...context, pageUser: 'other'},
    pageState: 'open',
  });
  assert.equal(next.view.kind, 'loading');
  assert.equal(step(next, {type: 'approve'}), next);
  const noSha = step(next, {
    type: 'complete',
    token: next.operation,
    view: {kind: 'available', label: 'Quick approve'},
  });
  assert.equal(step(noSha, {type: 'approve'}), noSha);
});
