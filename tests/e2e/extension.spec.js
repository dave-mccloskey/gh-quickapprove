import {test, expect, chromium} from '@playwright/test';
import {mkdtemp, readFile, rm, cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {writeRuntimeAssets} from '../../scripts/runtime-assets.js';

let context;
let profile;
let extensionId;
let server;
const sha = 'a'.repeat(40);
let testExtension;

test.beforeAll(async () => {
  testExtension = await mkdtemp(join(tmpdir(), 'gh-quickapprove-test-build-'));
  await cp('dist/extension', testExtension, {recursive: true});
  await writeRuntimeAssets(testExtension, {
    uiStallMs: 200,
    messageStallMs: 200,
    messageRequestMs: 5000,
    diagnosticStorageMs: 500,
    snapshotMs: 500,
    metadataMs: 1000,
    apiRequestMs: 5000,
    optionsRequestMs: 5000,
    notificationMs: 200,
  });
});

test.afterAll(async () => {
  await rm(testExtension, {recursive: true, force: true});
});

test.beforeEach(async () => {
  server = {
    user: {databaseId: 7, login: 'reviewer'},
    reviews: [],
    posts: [],
    requests: [],
    invalid: false,
    pr: {
      id: 'PR_99',
      fullDatabaseId: '99',
      state: 'OPEN',
      merged: false,
      author: {databaseId: 8},
      headRefOid: sha,
    },
  };
  profile = await mkdtemp(join(tmpdir(), 'gh-quickapprove-'));
  await launchContext();
});

async function launchContext({viewport = {width: 1440, height: 900}, deviceScaleFactor = 1} = {}) {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${resolve(testExtension)}`,
      `--load-extension=${resolve(testExtension)}`,
    ],
    viewport,
    deviceScaleFactor,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  const fixture = await readFile('tests/fixtures/pr.html', 'utf8');
  await context.route('https://github.com/**', (route) => {
    let body = fixture;
    if (server.showNativeReviewState) {
      const pending = server.reviews.some(
        (review) =>
          review.author?.databaseId === server.user.databaseId && review.state === 'PENDING',
      );
      body = body.replace('Submit review ▾', pending ? 'Submit review 1 ▾' : 'Submit review ▾');
      const state = pending ? '1 pending comment' : 'Review submitted';
      body = body.replace(
        '<main>',
        '<main style="min-height:2000px"><p data-testid="native-review-state">' + state + '</p>',
      );
    }
    return route.fulfill({contentType: 'text/html', body});
  });
  await context.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const payload = request.postDataJSON();
    server.requests.push({path, method: request.method(), ...payload});
    expect(path).toBe('/graphql');
    expect(request.method()).toBe('POST');
    const operation = payload.query.match(/(?:query|mutation)\s+(QuickApprove\w+)/)?.[1];
    if (server.invalid || request.headers().authorization === 'Bearer bad')
      return route.fulfill({status: 401, json: {message: 'Bad credentials'}});
    if (operation === 'QuickApproveUser')
      return route.fulfill({json: {data: {viewer: server.user}}});
    if (operation === 'QuickApproveSubmitReview') {
      const review = server.reviews.find((item) => item.id === payload.variables.reviewId);
      expect(review?.state).toBe('PENDING');
      server.posts.push(payload.variables);
      review.state = {
        REQUEST_CHANGES: 'CHANGES_REQUESTED',
        COMMENT: 'COMMENTED',
        APPROVE: 'APPROVED',
      }[payload.variables.event];
      if (server.losePostResponse) return route.abort('failed');
      if (server.postGate) await server.postGate;
      return route.fulfill({json: {data: {submitPullRequestReview: {pullRequestReview: review}}}});
    }
    if (operation === 'QuickApproveApprove') {
      server.posts.push(payload.variables);
      const review = {
        fullDatabaseId: '101',
        author: server.user,
        state: 'APPROVED',
        commit: {oid: payload.variables.commitOid},
      };
      if (!server.hidePostedReview) server.reviews.push(review);
      if (server.losePostResponse) return route.abort('failed');
      if (server.postGate) await server.postGate;
      return route.fulfill({json: {data: {addPullRequestReview: {pullRequestReview: review}}}});
    }
    server.readRequests = (server.readRequests ?? 0) + 1;
    if (server.readGate) await server.readGate;
    if (server.accessDenied) return route.fulfill({status: 403, json: {message: 'Forbidden'}});
    if (operation === 'QuickApprovePull')
      return route.fulfill({
        json: {
          data: {
            repository: {pullRequest: server.prByNumber?.[payload.variables.number] ?? server.pr},
          },
        },
      });
    expect(operation).toBe('QuickApproveReviews');
    if (server.reviews.length && /\bcommit\s*\{/.test(payload.query)) {
      return route.fulfill({
        json: {
          data: {repository: {pullRequest: {reviews: {nodes: [{commit: null}]}}}},
          errors: [
            {
              type: 'FORBIDDEN',
              path: ['repository', 'pullRequest', 'reviews', 'nodes', 0, 'commit'],
            },
          ],
        },
      });
    }
    return route.fulfill({
      json: {
        data: {
          repository: {
            pullRequest: {
              reviews: {
                nodes: server.reviews.filter(
                  (review) => review.author?.login === payload.variables.author,
                ),
                pageInfo: {hasNextPage: false, endCursor: null},
              },
            },
          },
        },
      },
    });
  });
}

test.afterEach(async () => {
  await context?.close();
  await rm(profile, {recursive: true, force: true});
});

async function options() {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  return page;
}

async function connect() {
  const page = await options();
  await page.getByLabel('GitHub token').fill('fake-test-token');
  await page.getByRole('button', {name: 'Save token', exact: true}).click();
  await expect(page.getByText('Connected as reviewer', {exact: true})).toBeVisible();
  return page;
}

async function prPage() {
  const page = await context.newPage();
  await page.goto('https://github.com/example/widget/pull/23');
  return page;
}

test('missing token opens packaged setup without submitting', async () => {
  const page = await prPage();
  const button = page.getByRole('button', {name: 'Set up Quick Approve', exact: true});
  await expect(button).toBeVisible();
  const opened = context.waitForEvent('page');
  await button.click();
  const settings = await opened;
  await expect(settings.getByLabel('GitHub token')).toHaveAttribute('type', 'password');
  expect(server.posts).toHaveLength(0);
});

test('worker sessions persist their exact build fingerprint', async () => {
  const settings = await options();
  const first = await settings.evaluate(() =>
    chrome.runtime.sendMessage({op: 'diagnosticsExport'}),
  );
  expect(
    first.report.events.some(
      (e) =>
        e.name === 'worker.build' &&
        e.session === first.report.workerSession &&
        e.fields.buildId === first.report.buildId,
    ),
  ).toBe(true);
  await context.close();
  await launchContext();
  const reopened = await options();
  const second = await reopened.evaluate(() =>
    chrome.runtime.sendMessage({op: 'diagnosticsExport'}),
  );
  expect(second.report.workerSession).not.toBe(first.report.workerSession);
  for (const session of [first.report.workerSession, second.report.workerSession]) {
    expect(
      second.report.events.some(
        (e) =>
          e.name === 'worker.build' &&
          e.session === session &&
          e.fields.buildId === second.report.buildId,
      ),
    ).toBe(true);
  }
});

test('a stalled status check leaves a downloadable private report across worker restart', async () => {
  const settings = await connect();
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = (key) => (key === 'credential' ? new Promise(() => {}) : get(key));
  });
  const page = await prPage();
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'loading',
  );
  const second = await prPage();
  await expect(second.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'loading',
  );
  await expect
    .poll(async () =>
      settings.evaluate(async () => {
        const result = await chrome.runtime.sendMessage({op: 'diagnosticsExport'});
        return ['ui.stalled', 'message.stalled'].every((name) =>
          result.report.events.some((event) => event.name === name),
        );
      }),
    )
    .toBe(true);
  const download = settings.waitForEvent('download');
  await settings.getByRole('button', {name: 'Export diagnostic report'}).click();
  const file = await download;
  await file.saveAs('test-results/diagnostic-stall-report.json');
  const text = await readFile(await file.path(), 'utf8');
  const report = JSON.parse(text);
  expect(report.events.some((e) => e.name === 'ui.stalled')).toBe(true);
  expect(report.events.some((e) => e.name === 'message.stalled' && e.fields.op === 'state')).toBe(
    true,
  );
  expect(report.events.some((e) => e.name === 'queue.enter' && e.fields.pending >= 2)).toBe(true);
  expect(report.unfinished.some((e) => e.event.name === 'storage.begin')).toBe(true);
  expect(report.events.some((e) => e.name === 'ui.snapshot' && e.fields.state === 'loading')).toBe(
    true,
  );
  expect(report.buildId).toMatch(/^[a-f0-9]{64}$/);
  expect(
    report.events.some(
      (e) =>
        e.name === 'worker.build' &&
        e.session === report.workerSession &&
        e.fields.buildId === report.buildId,
    ),
  ).toBe(true);
  for (const value of [
    'fake-test-token',
    'reviewer',
    'contributor',
    'example/widget',
    'https://github.com',
    'https://api.github.com',
    'a'.repeat(40),
  ])
    expect(text).not.toContain(value);
  expect(server.posts).toHaveLength(0);
  expect(server.readRequests ?? 0).toBe(0);
  await context.close();
  await launchContext();
  const reopened = await options();
  const saved = await reopened.evaluate(() =>
    chrome.runtime.sendMessage({op: 'diagnosticsExport'}),
  );
  expect(saved.report.events.some((e) => e.name === 'ui.stalled')).toBe(true);
  expect(saved.report.unfinished.some((e) => e.interrupted)).toBe(true);
  await expect(reopened.getByLabel('Record diagnostic history')).toBeChecked();
  await reopened.getByLabel('Record diagnostic history').uncheck();
  await reopened.getByRole('button', {name: 'Clear history', exact: true}).click();
  const cleared = await reopened.evaluate(() =>
    chrome.runtime.sendMessage({op: 'diagnosticsExport'}),
  );
  expect(cleared.report.events).toEqual([]);
  expect(cleared.report.enabled).toBe(false);
  await expect(reopened.getByText('Connected as reviewer', {exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(0);
});

test('a pending control resumes stall diagnostics after its header remounts', async () => {
  const settings = await connect();
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    chrome.storage.local.get = (key) => (key === 'credential' ? new Promise(() => {}) : get(key));
  });
  const page = await prPage();
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'loading',
  );
  const actions = await page.locator('.actions').evaluateHandle((element) => {
    element.remove();
    return element;
  });
  await expect
    .poll(async () =>
      settings.evaluate(async () => {
        const result = await chrome.runtime.sendMessage({op: 'diagnosticsExport'});
        return result.report.events.some(
          (event) =>
            event.name === 'ui.snapshot' &&
            event.fields.mounted === false &&
            event.fields.watchdogActive === false,
        );
      }),
    )
    .toBe(true);
  const before = await settings.evaluate(async () => {
    const result = await chrome.runtime.sendMessage({op: 'diagnosticsExport'});
    return result.report.events.filter((event) => event.name === 'ui.stalled').length;
  });
  await page.evaluate((element) => document.querySelector('.pr-toolbar').append(element), actions);
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'loading',
  );
  await expect
    .poll(async () =>
      settings.evaluate(async () => {
        const result = await chrome.runtime.sendMessage({op: 'diagnosticsExport'});
        return result.report.events.filter((event) => event.name === 'ui.stalled').length;
      }),
    )
    .toBeGreaterThan(before);
  expect(server.posts).toHaveLength(0);
  expect(server.readRequests ?? 0).toBe(0);
});

test('PR-only token stays approved after refresh without reading review commits', async () => {
  await connect();
  const page = await prPage();
  const approve = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(approve).toBeVisible();
  const box = await approve.boundingBox();
  expect(box.width).toBe(32);
  expect(box.height).toBe(32);
  await approve.click();
  await expect(
    page.getByRole('button', {name: 'You approved this PR', exact: true}),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.reload();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  await page.screenshot({path: 'test-results/pr-approved.png'});
  expect(server.posts).toEqual([{pullRequestId: 'PR_99', commitOid: sha}]);
  expect(
    new Set(server.requests.map(({query}) => query.match(/(?:query|mutation)\s+(\w+)/)[1])),
  ).toEqual(
    new Set(['QuickApproveUser', 'QuickApprovePull', 'QuickApproveReviews', 'QuickApproveApprove']),
  );
  for (const request of server.requests) {
    expect(request.path).toBe('/graphql');
    expect(request.method).toBe('POST');
    expect(request.query).not.toMatch(/\b(?:location|body|title)\b/);
    if (/query QuickApprovePull\b/.test(request.query))
      expect(request.variables).toEqual({owner: 'example', name: 'widget', number: 23});
    if (/query QuickApproveReviews\b/.test(request.query))
      expect(request.variables).toEqual({
        owner: 'example',
        name: 'widget',
        number: 23,
        cursor: null,
        author: 'reviewer',
      });
  }
});

test('review state belongs to the connected reviewer', async () => {
  await connect();
  server.reviews = [
    {
      fullDatabaseId: '1',
      author: {databaseId: 9, login: 'other-reviewer'},
      state: 'CHANGES_REQUESTED',
      commit: {oid: sha},
    },
    {fullDatabaseId: '2', author: server.user, state: 'APPROVED', commit: {oid: sha}},
  ];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  const reviews = server.requests.filter(({query}) => /query QuickApproveReviews\b/.test(query));
  expect(reviews.length).toBeGreaterThan(0);
  for (const request of reviews) {
    expect(request.variables.author).toBe('reviewer');
    expect(request.query).toMatch(/author:\s*\$author/);
  }
  expect(server.posts).toHaveLength(0);
});

test('synthetic clicks never submit and keyboard activation works', async () => {
  await connect();
  const page = await prPage();
  const approve = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(approve).toBeVisible();
  await approve.evaluate((button) => button.click());
  expect(server.posts).toHaveLength(0);
  await approve.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

for (const [kind, label] of [
  ['own', "You can't approve your own PR"],
  ['merged', 'This PR is merged'],
  ['closed', 'This PR is closed'],
  ['pending', 'Finish your pending review in GitHub'],
]) {
  test(`${kind} state is visible and disabled without hover`, async () => {
    await connect();
    if (kind === 'own') server.pr.author = server.user;
    if (kind === 'merged') {
      server.pr.state = 'MERGED';
      server.pr.merged = true;
    }
    if (kind === 'closed') server.pr.state = 'CLOSED';
    if (kind === 'pending')
      server.reviews = [{fullDatabaseId: '1', author: server.user, state: 'PENDING'}];
    const page = await prPage();
    const button = page.getByRole('button', {name: label, exact: true});
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await button.click({force: true});
    expect(server.posts).toHaveLength(0);
  });
}

test('same-document navigation and header replacement keep exactly one button', async () => {
  await connect();
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Files changed', exact: true}).click();
  await expect(page).toHaveURL(/\/changes$/);
  await page.evaluate(() => {
    const toolbar = document.querySelector('.pr-toolbar');
    toolbar.replaceWith(toolbar.cloneNode(true));
  });
  await expect(page.locator('[data-quickapprove-root]')).toHaveCount(1);
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
});

test('navigation from a merged PR to an open PR uses the current PR for status and approval', async () => {
  await connect();
  server.prByNumber = {
    23: {...server.pr, state: 'MERGED', merged: true},
    4573: {...server.pr, id: 'PR_4573', fullDatabaseId: '4573'},
  };
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'This PR is merged', exact: true})).toBeVisible();
  await page.evaluate(() => {
    history.pushState({}, '', '/example/widget/pull/4573');
    document.dispatchEvent(new Event('turbo:load'));
  });
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
  expect(server.posts[0].pullRequestId).toBe('PR_4573');
});

test('a delayed status reply cannot replace a completed approval', async () => {
  const settings = await connect();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({context: execution}) => worlds.push(execution));
  await cdp.send('Runtime.enable');
  await page.goto('https://github.com/example/widget/pull/23');
  const control = page.locator('[data-quickapprove-root] button');
  await expect(control).toHaveAttribute('data-state', 'available');
  const isolated = worlds.find((world) => world.origin === `chrome-extension://${extensionId}`);
  await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `{
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let delayed = false;
      chrome.runtime.sendMessage = (...args) => {
        const response = original(...args);
        if (args[0]?.op !== 'state' || delayed) return response;
        delayed = true;
        globalThis.delayedReadTrace = args[0].traceId;
        return response.then(reply => new Promise(resolve => {
          globalThis.releaseRead = () => resolve(reply);
        }));
      };
    }`,
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect
    .poll(
      async () =>
        (
          await cdp.send('Runtime.evaluate', {
            contextId: isolated.id,
            expression: 'typeof globalThis.releaseRead',
          })
        ).result.value,
    )
    .toBe('function');
  await control.click();
  await expect(control).toHaveAttribute('data-state', 'approved');
  const {
    result: {value: traceId},
  } = await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: 'globalThis.releaseRead(); globalThis.delayedReadTrace;',
  });
  await expect
    .poll(() =>
      settings.evaluate(async (trace) => {
        const {report} = await chrome.runtime.sendMessage({op: 'diagnosticsExport'});
        return report.events.some(
          (event) => event.name === 'ui.refresh.end' && event.fields.traceId === trace,
        );
      }, traceId),
    )
    .toBe(true);
  await expect(control).toHaveAttribute('data-state', 'approved');
  expect(server.posts).toHaveLength(1);
});

test('valid setup refreshes existing PR and invalid candidate preserves saved credential', async () => {
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'Set up Quick Approve', exact: true})).toBeVisible();
  const settings = await connect();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await settings.getByLabel('GitHub token').fill('bad');
  await settings.getByRole('button', {name: 'Save token', exact: true}).click();
  await expect(settings.getByRole('alert')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(0);
});

test('token removal refreshes PR into setup', async () => {
  const settings = await connect();
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await settings.getByRole('button', {name: 'Remove token', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Set up Quick Approve', exact: true})).toBeVisible();
});

test('approval in one tab updates the other tab without a focus change', async () => {
  await connect();
  const first = await prPage();
  const second = await prPage();
  await expect(second.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await first.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect(
    second.getByRole('button', {name: 'You approved this PR', exact: true}),
  ).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

test('expired token uses recovery while insufficient permission preserves the connection', async () => {
  const settings = await connect();
  server.invalid = true;
  const page = await prPage();
  await expect(
    page.getByRole('button', {name: 'GitHub token expired or invalid. Update token', exact: true}),
  ).toBeVisible();
  server.invalid = false;
  await settings.getByLabel('GitHub token').fill('replacement-token');
  await settings.getByRole('button', {name: 'Save token', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  server.accessDenied = true;
  await page.reload();
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'access',
  );
  await settings.reload();
  await expect(settings.getByText('Connected as reviewer', {exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(0);
});

test('unknown write stays blocked across a real browser restart and reset never submits', async () => {
  await connect();
  server.losePostResponse = true;
  server.hidePostedReview = true;
  const page = await prPage();
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'uncertain',
  );
  expect(server.posts).toHaveLength(1);
  await context.close();
  await launchContext();
  const restored = await prPage();
  const control = restored.locator('[data-quickapprove-root] button');
  await expect(control).toHaveAttribute('data-state', 'uncertain');
  await control.click();
  await restored.getByRole('button', {name: 'Recheck', exact: true}).click();
  await expect(control).toHaveAttribute('data-state', 'uncertain');
  await restored.getByRole('button', {name: 'Allow another attempt', exact: true}).click();
  await expect(control).toHaveAttribute('data-state', 'available');
  expect(server.posts).toHaveLength(1);
});

test('content-script context cannot read credentials or manage tokens', async () => {
  await connect();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({context: execution}) => {
    worlds.push(execution);
  });
  await cdp.send('Runtime.enable');
  await page.goto('https://github.com/example/widget/pull/23');
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  const isolated = worlds.find((world) => world.origin === `chrome-extension://${extensionId}`);
  expect(isolated).toBeTruthy();
  const read = await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `chrome.storage.local.get('credential').then(value => Boolean(value.credential)).catch(() => false)`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(read.result.value).toBe(false);
  const mutation = await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `chrome.runtime.sendMessage({op:'removeToken'})`,
    awaitPromise: true,
    returnByValue: true,
  });
  expect(mutation.result.value.kind).toBe('error');
  for (const op of ['diagnosticsExport', 'diagnosticsClear', 'diagnosticsSetEnabled']) {
    const denied = await cdp.send('Runtime.evaluate', {
      contextId: isolated.id,
      expression: `chrome.runtime.sendMessage({op:${JSON.stringify(op)},enabled:false})`,
      awaitPromise: true,
      returnByValue: true,
    });
    expect(denied.result.value.ok).toBe(false);
  }
  await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `chrome.runtime.sendMessage({op:'diagnosticsEvent',name:'ui.control',fields:{state:'PRIVATE_STATE_MARKER',token:'PRIVATE_TOKEN_MARKER',url:'https://private.invalid',label:'PRIVATE_LABEL_MARKER'}})`,
    awaitPromise: true,
    returnByValue: true,
  });
  const settings = await options();
  const report = await settings.evaluate(() =>
    chrome.runtime.sendMessage({op: 'diagnosticsExport'}),
  );
  for (const secret of [
    'PRIVATE_STATE_MARKER',
    'PRIVATE_TOKEN_MARKER',
    'PRIVATE_LABEL_MARKER',
    'private.invalid',
  ])
    expect(JSON.stringify(report)).not.toContain(secret);
  await page.reload();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
});

test('captures generic dark, light and narrow UI screenshots', async () => {
  const settings = await connect();
  await settings.emulateMedia({colorScheme: 'dark'});
  await settings.screenshot({path: 'test-results/options-dark.png', fullPage: true});
  const page = await prPage();
  const control = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(control).toBeVisible();
  await page.screenshot({path: 'test-results/pr-dark.png'});
  await control.hover();
  await page.screenshot({path: 'test-results/pr-hover.png'});
  await page.setViewportSize({width: 1280, height: 800});
  await control.hover();
  await expect(page.getByText('Quick approve', {exact: true})).toBeVisible();
  await page.screenshot({path: 'test-results/store-screenshot.png'});
  await page.setViewportSize({width: 1440, height: 900});
  await page.evaluate(() => {
    document.body.classList.add('light');
    document.documentElement.style.colorScheme = 'light';
  });
  const light = await control.evaluate((button) => {
    const styles = getComputedStyle(button);
    const tooltip = button.parentElement.querySelector('[role="tooltip"]');
    const tip = getComputedStyle(tooltip);
    const luminance = (value) =>
      value
        .match(/\d+/g)
        .slice(0, 3)
        .map((channel) => Number(channel) / 255)
        .map((channel) =>
          channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(tip.color);
    const background = luminance(tip.backgroundColor);
    return {
      color: styles.color.match(/\d+/g).map(Number),
      contrast:
        (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
    };
  });
  expect(light.color[0]).toBeGreaterThan(light.color[1]);
  expect(light.color[1]).toBeGreaterThan(light.color[2]);
  expect(light.contrast).toBeGreaterThanOrEqual(4.5);
  await page.screenshot({path: 'test-results/pr-light.png'});
  await page.setViewportSize({width: 560, height: 800});
  await expect(control).toBeInViewport();
  await page.screenshot({path: 'test-results/pr-narrow.png'});
  await settings.emulateMedia({colorScheme: 'light'});
  await settings.setViewportSize({width: 390, height: 844});
  await expect(settings.getByRole('button', {name: 'Save token', exact: true})).toBeInViewport();
  await settings.screenshot({path: 'test-results/options-mobile-light.png', fullPage: true});
});

test('captures ready-to-upload store screenshots with generic accounts and repositories', async () => {
  const settings = await options();
  await settings.setViewportSize({width: 1280, height: 800});
  await settings.emulateMedia({colorScheme: 'dark'});
  await expect(settings.getByText('Not connected', {exact: true})).toBeVisible();
  await expect(settings.getByLabel('GitHub token')).toHaveValue('');
  await settings.screenshot({path: 'test-results/store-03-settings.png'});

  await context.close();
  await launchContext({viewport: {width: 1024, height: 640}, deviceScaleFactor: 1.25});
  await connect();
  const page = await prPage();
  const control = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(control).toBeVisible();
  await control.hover();
  await expect(page.getByText('Quick approve', {exact: true})).toBeVisible();
  await page.screenshot({path: 'test-results/store-01-quick-approve.png'});

  await control.click();
  const approved = page.getByRole('button', {name: 'You approved this PR', exact: true});
  await expect(approved).toHaveAttribute('aria-disabled', 'true');
  await page.locator('p.card').evaluate((card) => {
    card.replaceChildren(
      'You approved these changes',
      document.createElement('br'),
      'Your approval is recorded on this pull request.',
    );
  });
  await approved.hover();
  await expect(page.getByText('You approved this PR', {exact: true})).toBeVisible();
  await page.screenshot({path: 'test-results/store-02-approved.png'});
  expect(server.posts).toEqual([{pullRequestId: 'PR_99', commitOid: sha}]);
});

test('navigating within a PR during submission does not leave the button busy', async () => {
  await connect();
  let release;
  server.postGate = new Promise((done) => {
    release = done;
  });
  const page = await prPage();
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect.poll(() => server.posts.length).toBe(1);
  await page.getByRole('link', {name: 'Files changed', exact: true}).click();
  release();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

test('failed token removal keeps the connection and exposes an actionable error', async () => {
  const settings = await connect();
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    chrome.storage.local.remove = async () => {
      throw new Error('simulated storage failure');
    };
  });
  await settings.getByRole('button', {name: 'Remove token', exact: true}).click();
  await expect(settings.getByRole('alert')).toBeVisible();
  await expect(settings.getByText('Connected as reviewer', {exact: true})).toBeVisible();
  await expect(settings.getByRole('button', {name: 'Remove token', exact: true})).toBeVisible();
});

test('ongoing page updates cannot starve a slow approval-state response', async () => {
  await connect();
  let releaseRead;
  server.readGate = new Promise((done) => {
    releaseRead = done;
  });
  const page = await context.newPage();
  await page.goto('https://github.com/example/widget/pull/23');
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'loading',
  );
  await page.evaluate(async () => {
    const activity = document.createElement('div');
    document.body.append(activity);
    for (let count = 0; count < 5; count++) {
      activity.textContent = `Activity update ${count}`;
      await new Promise((done) => requestAnimationFrame(() => done()));
    }
  });
  releaseRead();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  expect(server.readRequests).toBeLessThan(6);
  expect(server.posts).toHaveLength(0);
});

test('hover and keyboard tooltip remain visible outside a clipped PR header', async () => {
  await connect();
  const page = await prPage();
  const control = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(control).toBeVisible();
  await page.locator('.pr-toolbar').evaluate((toolbar) => {
    toolbar.style.overflow = 'hidden';
  });
  const restingBackground = await control.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  const restingBorder = await control.evaluate((button) => getComputedStyle(button).borderColor);
  await control.hover();
  await expect
    .poll(() => control.evaluate((button) => getComputedStyle(button).backgroundColor))
    .not.toBe(restingBackground);
  expect(await control.evaluate((button) => getComputedStyle(button).borderColor)).toBe(
    restingBorder,
  );
  const tooltip = page.getByRole('tooltip', {name: 'Quick approve', exact: true});
  await expect(tooltip).toBeVisible();
  const visibleFraction = await tooltip.evaluate(
    (element) =>
      new Promise((resolve) => {
        const observer = new IntersectionObserver(([entry]) => {
          observer.disconnect();
          resolve(entry.intersectionRatio);
        });
        observer.observe(element);
      }),
  );
  await page.screenshot({path: 'test-results/hover-clipped-header.png'});
  expect(visibleFraction).toBeGreaterThanOrEqual(0.99);
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await control.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  expect(server.posts).toHaveLength(0);
});

test('an approved open PR changes to purple when GitHub marks it merged in place', async () => {
  await connect();
  server.reviews = [
    {fullDatabaseId: '1', author: server.user, state: 'APPROVED', commit: {oid: sha}},
  ];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  server.pr.state = 'MERGED';
  server.pr.merged = true;
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Merged';
  });
  const control = page.getByRole('button', {name: 'This PR is merged', exact: true});
  await expect(control).toHaveAttribute('aria-disabled', 'true');
  const color = await control.evaluate((button) =>
    getComputedStyle(button).color.match(/\d+/g).map(Number),
  );
  expect(color[2]).toBeGreaterThan(color[0]);
  expect(color[0]).toBeGreaterThan(color[1]);
  expect(server.posts).toHaveLength(0);
});

test('an accessible PR-state label change refreshes the approved button', async () => {
  await connect();
  server.reviews = [
    {fullDatabaseId: '1', author: server.user, state: 'APPROVED', commit: {oid: sha}},
  ];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const status = document.createElement('button');
    status.setAttribute('aria-label', 'Pull request state: Open');
    status.textContent = 'PR state';
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').replaceWith(status);
  });
  server.pr.state = 'MERGED';
  server.pr.merged = true;
  await page
    .getByRole('button', {name: 'Pull request state: Open', exact: true})
    .evaluate((status) => status.setAttribute('aria-label', 'Pull request state: Merged'));
  await expect(page.getByRole('button', {name: 'This PR is merged', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(0);
});

test('a merge arriving during approval wins over the late approval response', async () => {
  await connect();
  let release;
  server.postGate = new Promise((done) => {
    release = done;
  });
  const page = await prPage();
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect.poll(() => server.posts.length).toBe(1);
  server.pr.state = 'MERGED';
  server.pr.merged = true;
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Merged';
    return new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  release();
  await expect(page.getByRole('button', {name: 'This PR is merged', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

test('in-place close and reopen replace the approved and closed button states', async () => {
  await connect();
  server.reviews = [
    {fullDatabaseId: '1', author: server.user, state: 'APPROVED', commit: {oid: sha}},
  ];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  server.pr.state = 'CLOSED';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Closed';
  });
  await expect(page.getByRole('button', {name: 'This PR is closed', exact: true})).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  server.pr.state = 'OPEN';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Open';
  });
  await expect(
    page.getByRole('button', {name: 'You approved this PR', exact: true}),
  ).toHaveAttribute('aria-disabled', 'true');
  server.reviews = [];
  server.pr.state = 'CLOSED';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Closed';
  });
  await expect(page.getByRole('button', {name: 'This PR is closed', exact: true})).toBeVisible();
  server.pr.state = 'OPEN';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Open';
  });
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toHaveAttribute(
    'aria-disabled',
    'false',
  );
  expect(server.posts).toHaveLength(0);
});

test('draft PRs remain open for approval and Draft-to-Open refreshes state', async () => {
  await connect();
  server.pr.draft = true;
  const page = await prPage();
  const available = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(available).toHaveAttribute('aria-disabled', 'false');
  const beforeDraft = server.readRequests;
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Draft';
  });
  await expect.poll(() => server.readRequests).toBeGreaterThan(beforeDraft);
  await expect(available).toHaveAttribute('aria-disabled', 'false');
  server.pr.draft = false;
  const beforeOpen = server.readRequests;
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Open';
  });
  await expect.poll(() => server.readRequests).toBeGreaterThan(beforeOpen);
  await expect(available).toHaveAttribute('aria-disabled', 'false');
  expect(server.posts).toHaveLength(0);
});

test('Back returns from a label page to a usable PR control', async () => {
  await connect();
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/example/widget/labels';
    link.textContent = 'Edit labels';
    document.body.append(link);
  });
  await page.getByRole('link', {name: 'Edit labels', exact: true}).click();
  await expect(page).toHaveURL('https://github.com/example/widget/labels');
  await page.goBack();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(0);
});

test('diff hash updates preserve an in-flight approval check', async () => {
  await connect();
  let release;
  server.readGate = new Promise((resolve) => {
    release = resolve;
  });
  const page = await context.newPage();
  await page.goto('https://github.com/example/widget/pull/23/changes');
  const control = page.locator('[data-quickapprove-root] button');
  await expect(control).toHaveAttribute('data-state', 'loading');
  await expect.poll(() => server.readRequests ?? 0).toBe(1);
  for (let index = 0; index < 8; index++) {
    await page.evaluate((index) => {
      history.replaceState({}, '', `#diff-${index}`);
    }, index);
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  release();
  await expect(control).toHaveAttribute('data-state', 'available');
  expect(server.readRequests).toBe(2);
  // Replacing history state at the same URL must preserve the accepted view too.
  await page.evaluate(() => history.replaceState({scroll: 100}, '', location.href));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(control).toHaveAttribute('data-state', 'available');
  expect(server.readRequests).toBe(2);
});

test('restoring a cached PR replaces a state request whose reply was lost', async () => {
  await connect();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({context: execution}) => worlds.push(execution));
  await cdp.send('Runtime.enable');
  await page.goto('https://github.com/example/widget/pull/23');
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  const isolated = worlds.find((world) => world.origin === `chrome-extension://${extensionId}`);
  expect(isolated).toBeTruthy();
  await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `{
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let dropped = false;
      chrome.runtime.sendMessage = (...args) => {
        const response = original(...args);
        if (args[0]?.op === 'state' && !dropped) {
          dropped = true;
          globalThis.droppedStateReply = true;
          return new Promise(() => {});
        }
        return response;
      };
    }`,
  });
  await page.evaluate(() => history.replaceState({}, '', '?labels'));
  const control = page.locator('[data-quickapprove-root] button');
  await expect(control).toHaveAttribute('data-state', 'loading');
  // Loading is rendered at navigation invalidation, before the next frame sends its read.
  await expect
    .poll(
      async () =>
        (
          await cdp.send('Runtime.evaluate', {
            contextId: isolated.id,
            expression: 'globalThis.droppedStateReply === true',
          })
        ).result.value,
    )
    .toBe(true);
  // The routed harness reloads history entries; exercise the cached-document event directly.
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})),
  );
  await expect(control).toHaveAttribute('data-state', 'available');
  expect(server.posts).toHaveLength(0);
});

test('notification failures cannot turn a successful approval into an error', async () => {
  await connect();
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await context.serviceWorkers()[0].evaluate(() => {
    chrome.tabs.query = async () => {
      throw new Error('tab lookup failed');
    };
  });
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

test('notification failures cannot leave a removed token displayed as connected', async () => {
  const settings = await connect();
  await context.serviceWorkers()[0].evaluate(() => {
    chrome.tabs.query = async () => {
      throw new Error('tab lookup failed');
    };
  });
  await settings.getByRole('button', {name: 'Remove token', exact: true}).click();
  await expect(settings.getByText('Add a token to get started.', {exact: true})).toBeVisible();
  await expect(settings.getByRole('alert')).toBeHidden();
});

test('an unresponsive notification recipient cannot keep an approval busy', async () => {
  await connect();
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await context.serviceWorkers()[0].evaluate(() => {
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = (...args) =>
      args[1]?.op === 'refreshState' ? new Promise(() => {}) : send(...args);
  });
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

test('a rejected approval from an old PR cannot put its warning on a new PR', async () => {
  await connect();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({context: execution}) => worlds.push(execution));
  await cdp.send('Runtime.enable');
  await page.goto('https://github.com/example/widget/pull/23');
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  const isolated = worlds.find((world) => world.origin === `chrome-extension://${extensionId}`);
  await cdp.send('Runtime.evaluate', {
    contextId: isolated.id,
    expression: `{
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => args[0]?.op === 'approve'
        ? new Promise((resolve, reject) => { window.rejectOldApproval = () => reject(new Error('disconnected')); })
        : send(...args);
    }`,
  });
  await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'busy',
  );
  await page.evaluate(() => history.pushState({}, '', '/example/widget/pull/24'));
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  await cdp.send('Runtime.evaluate', {contextId: isolated.id, expression: 'rejectOldApproval()'});
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('[data-quickapprove-root] button')).toHaveAttribute(
    'data-state',
    'available',
  );
  expect(server.posts).toHaveLength(0);
});

for (const action of ['leaving the PR', 'dismissing the panel']) {
  test(`a late recovery recheck cannot reopen its panel after ${action}`, async () => {
    const settings = await connect();
    server.losePostResponse = true;
    server.hidePostedReview = true;
    const page = await prPage();
    await page.getByRole('button', {name: 'Quick approve', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Recheck', exact: true})).toBeVisible();
    let release;
    server.readGate = new Promise((resolve) => {
      release = resolve;
    });
    const before = server.readRequests;
    await page.getByRole('button', {name: 'Recheck', exact: true}).click();
    await expect.poll(() => server.readRequests).toBeGreaterThan(before);
    if (action === 'leaving the PR') {
      await page.evaluate(() => history.pushState({}, '', '/example/widget/labels'));
      await expect(page.locator('[data-quickapprove-root]')).toHaveCount(0);
    } else {
      await page.getByRole('button', {name: 'Dismiss', exact: true}).click();
    }
    release();
    await expect
      .poll(async () =>
        settings.evaluate(async () => {
          const {report} = await chrome.runtime.sendMessage({op: 'diagnosticsExport'});
          return report.events.some(
            (event) => event.name === 'ui.refresh.end' && event.fields.op === 'recheck',
          );
        }),
      )
      .toBe(true);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(server.posts).toHaveLength(1);
  });
}

for (const candidate of ['valid', 'invalid']) {
  test(`late initial settings status respects a ${candidate} token save`, async () => {
    if (candidate === 'invalid') await connect();
    const settings = await context.newPage();
    await settings.addInitScript(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => {
        const response = send(...args);
        return args[0]?.op === 'status'
          ? response.then(
              (result) =>
                new Promise((resolve) => {
                  window.releaseInitialStatus = () => resolve(result);
                }),
            )
          : response;
      };
    });
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    await expect
      .poll(() => settings.evaluate(() => typeof window.releaseInitialStatus))
      .toBe('function');
    await settings.getByLabel('GitHub token').fill(candidate === 'valid' ? 'fake-token' : 'bad');
    await settings.getByRole('button', {name: 'Save token', exact: true}).click();
    if (candidate === 'valid')
      await expect(settings.getByText('Connected as reviewer', {exact: true})).toBeVisible();
    else await expect(settings.getByRole('alert')).toBeVisible();
    await settings.evaluate(() => window.releaseInitialStatus());
    await expect(settings.getByText('Connected as reviewer', {exact: true})).toBeVisible();
    if (candidate === 'invalid') await expect(settings.getByRole('alert')).toBeVisible();
  });
}

for (const delayed of ['setToken', 'removeToken']) {
  test(`late ${delayed} replies cannot overwrite a newer credential action`, async () => {
    const settings = await connect();
    await settings.evaluate((op) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let held = false;
      chrome.runtime.sendMessage = (...args) => {
        const response = send(...args);
        if (args[0]?.op !== op || held) return response;
        held = true;
        return response.then(
          (result) =>
            new Promise((resolve) => {
              window.releaseOldCredentialAction = () => resolve(result);
            }),
        );
      };
    }, delayed);
    if (delayed === 'setToken') {
      await settings.getByLabel('GitHub token').fill('first-replacement');
      await settings.getByRole('button', {name: 'Save token', exact: true}).click();
    } else await settings.getByRole('button', {name: 'Remove token', exact: true}).click();
    await expect
      .poll(() => settings.evaluate(() => typeof window.releaseOldCredentialAction))
      .toBe('function');
    if (delayed === 'setToken') {
      await settings.getByRole('button', {name: 'Remove token', exact: true}).click();
      await expect(settings.getByText('Add a token to get started.', {exact: true})).toBeVisible();
    } else {
      await settings.getByLabel('GitHub token').fill('newest-replacement');
      await settings.getByRole('button', {name: 'Save token', exact: true}).click();
      await expect(settings.getByText('Connected as reviewer', {exact: true})).toBeVisible();
    }
    await settings.evaluate(() => window.releaseOldCredentialAction());
    await expect(
      settings.getByText(
        delayed === 'setToken' ? 'Add a token to get started.' : 'Connected as reviewer',
        {exact: true},
      ),
    ).toBeVisible();
    await expect(settings.getByRole('alert')).toBeHidden();
  });
}

for (const op of ['setToken', 'removeToken']) {
  test(`a lost ${op} reply re-enables settings controls and reports an unknown outcome`, async () => {
    const settings = await connect();
    await settings.evaluate(async (operation) => {
      const {timing} = await import(chrome.runtime.getURL('timing.js'));
      timing.optionsRequestMs = 100;
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => {
        const response = send(...args);
        return args[0]?.op === operation ? new Promise(() => {}) : response;
      };
    }, op);
    if (op === 'setToken') {
      await settings.getByLabel('GitHub token').fill('replacement-token');
      await settings.getByRole('button', {name: 'Save token', exact: true}).click();
    } else await settings.getByRole('button', {name: 'Remove token', exact: true}).click();
    await expect(settings.getByRole('alert')).toBeVisible();
    await expect(
      settings.getByRole('button', {
        name: op === 'setToken' ? 'Save token' : 'Remove token',
        exact: true,
      }),
    ).toBeEnabled();
    await settings.reload();
    await expect(
      settings.getByText(
        op === 'setToken' ? 'Connected as reviewer' : 'Add a token to get started.',
        {exact: true},
      ),
    ).toBeVisible();
  });
}

for (const op of ['state', 'approve']) {
  test(`a lost PR ${op} reply has a bounded wait and never repeats approval`, async () => {
    await connect();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', ({context: execution}) => worlds.push(execution));
    await cdp.send('Runtime.enable');
    await page.goto('https://github.com/example/widget/pull/23');
    await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
    const isolated = worlds.find((world) => world.origin === `chrome-extension://${extensionId}`);
    await cdp.send('Runtime.evaluate', {
      contextId: isolated.id,
      expression: `{
        quickApproveTiming.messageRequestMs = 100;
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        let dropped = false;
        chrome.runtime.sendMessage = (...args) => {
          const response = send(...args);
          if (args[0]?.op === '${op}' && !dropped) { dropped = true; return new Promise(() => {}); }
          return response;
        };
      }`,
    });
    const control = page.locator('[data-quickapprove-root] button');
    if (op === 'state') {
      await page.evaluate(() => history.replaceState({}, '', '?read-timeout'));
      await expect(control).toHaveAttribute('data-state', 'error');
      await control.click();
      await page.getByRole('button', {name: 'Retry', exact: true}).click();
      await expect(control).toHaveAttribute('data-state', 'available');
    } else {
      await control.click();
      await expect(control).toHaveAttribute('data-state', 'uncertain');
      await page.getByRole('button', {name: 'Recheck', exact: true}).click();
      await expect(control).toHaveAttribute('data-state', 'approved');
    }
    await expect(control).toHaveAttribute('aria-busy', 'false');
    expect(server.posts).toHaveLength(op === 'approve' ? 1 : 0);
  });
}

for (const [choice, action, event, label, icon] of [
  [
    'Request changes',
    'changes',
    'REQUEST_CHANGES',
    'Request changes and submit pending comments',
    'changes',
  ],
  ['Comment', 'comment', 'COMMENT', 'Submit pending comments as a review', 'comment'],
  ['Approve', 'approve', 'APPROVE', 'Approve and submit pending comments', 'approve-review'],
]) {
  test(`pending review setting ${action} persists and submits saved comments with one keyboard activation`, async () => {
    const settings = await connect();
    server.reviews = [
      {
        id: 'PRR_pending',
        fullDatabaseId: '51',
        author: server.user,
        state: 'PENDING',
        body: 'Saved summary',
        comments: ['Please handle expiration', 'Add coverage'],
      },
    ];
    const page = await prPage();
    await expect(
      page.getByRole('button', {name: 'Finish your pending review in GitHub', exact: true}),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(settings.getByRole('radio', {name: /Keep locked/})).toBeChecked();
    await settings.getByRole('radio', {name: new RegExp('^' + choice)}).check();
    await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
    const control = page.getByRole('button', {name: label, exact: true});
    await expect(control).toHaveAttribute('data-icon', icon);
    await expect(control).toHaveAttribute('aria-disabled', 'false');
    await settings.reload();
    await expect(settings.getByRole('radio', {name: new RegExp('^' + choice)})).toBeChecked();
    await control.focus();
    // Submission refreshes GitHub's native review state. Wait for that navigation
    // before issuing the explicit reload below so the two reloads cannot race.
    await Promise.all([page.waitForEvent('domcontentloaded'), page.keyboard.press('Enter')]);
    await expect.poll(() => server.posts.length).toBe(1);
    expect(server.posts[0]).toEqual({reviewId: 'PRR_pending', event});
    expect(server.reviews[0].body).toBe('Saved summary');
    expect(server.reviews[0].comments).toEqual(['Please handle expiration', 'Add coverage']);
    await page.reload();
    const nextLabel = action === 'approve' ? 'You approved this PR' : 'Quick approve';
    await expect(page.getByRole('button', {name: nextLabel, exact: true})).toBeVisible();
    expect(server.posts).toHaveLength(1);
  });
}

test('returning the pending action to lock updates open tabs without a submission', async () => {
  const settings = await connect();
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await settings.getByRole('radio', {name: /^Request changes/}).check();
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  const page = await prPage();
  await expect(
    page.getByRole('button', {name: 'Request changes and submit pending comments', exact: true}),
  ).toBeVisible();
  await settings.getByRole('radio', {name: /Keep locked/}).check();
  const lock = page.getByRole('button', {
    name: 'Finish your pending review in GitHub',
    exact: true,
  });
  await expect(lock).toHaveAttribute('aria-disabled', 'true');
  await lock.click({force: true});
  expect(server.posts).toHaveLength(0);
});

test('a lost pending review reply recovers its submitted review without another write', async () => {
  const settings = await connect();
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await settings.getByRole('radio', {name: /^Comment/}).check();
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  const page = await prPage();
  server.losePostResponse = true;
  await page.evaluate(() => {
    window.pendingReloadMarker = true;
  });
  await page
    .getByRole('button', {name: 'Submit pending comments as a review', exact: true})
    .click();
  await expect.poll(() => server.posts.length).toBe(1);
  await expect(page.locator('.qa-button')).toHaveAttribute('data-state', 'uncertain');
  expect(await page.evaluate(() => window.pendingReloadMarker)).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  expect(server.posts).toHaveLength(1);
});

test('a lost preference-save reply restores controls and reload confirms the saved choice', async () => {
  const settings = await options();
  await expect(settings.getByRole('radio', {name: /Keep locked/})).toBeEnabled();
  await settings.evaluate(async () => {
    const {timing} = await import(chrome.runtime.getURL('timing.js'));
    timing.optionsRequestMs = 100;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => {
      const response = send(...args);
      return args[0]?.op === 'setPreferences' ? new Promise(() => {}) : response;
    };
  });
  await settings.getByRole('radio', {name: /^Request changes/}).check();
  await expect(settings.locator('#review-preference-status')).toContainText('Could not confirm');
  await expect(settings.getByRole('radio', {name: /Keep locked/})).toBeEnabled();
  await settings.reload();
  await expect(settings.getByRole('radio', {name: /^Request changes/})).toBeChecked();
  expect(server.posts).toHaveLength(0);
});

test('pending review settings and colored header actions fit dark desktop and light mobile', async () => {
  const settings = await connect();
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await settings.emulateMedia({colorScheme: 'dark'});
  const page = await prPage();
  for (const [action, name, label] of [
    ['changes', /^Request changes/, 'Request changes and submit pending comments'],
    ['comment', /^Comment/, 'Submit pending comments as a review'],
    ['approve', /^Approve/, 'Approve and submit pending comments'],
  ]) {
    await settings.getByRole('radio', {name}).check();
    await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
    const control = page.getByRole('button', {name: label, exact: true});
    await control.hover();
    await expect(page.getByText(label, {exact: true})).toBeVisible();
    await page.screenshot({path: `test-results/pending-${action}-header.png`});
  }
  await settings
    .locator('.review-preferences')
    .screenshot({path: 'test-results/pending-settings-dark.png'});
  await settings.emulateMedia({colorScheme: 'light'});
  await settings.setViewportSize({width: 390, height: 844});
  await settings.locator('.review-preferences').scrollIntoViewIfNeeded();
  await expect(settings.getByRole('radio', {name: /^Approve/})).toBeInViewport();
  expect(await settings.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await settings
    .locator('.review-preferences')
    .screenshot({path: 'test-results/pending-settings-mobile-light.png'});
  expect(server.posts).toHaveLength(0);
});

test('settings radio choices retain focus between keyboard changes', async () => {
  const settings = await options();
  const locked = settings.getByRole('radio', {name: /Keep locked/});
  await expect(locked).toBeEnabled();
  await locked.focus();
  await settings.keyboard.press('ArrowDown');
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  await expect(settings.getByRole('radio', {name: /^Request changes/})).toBeFocused();
  await settings.keyboard.press('ArrowDown');
  await expect(settings.getByRole('radio', {name: /^Comment/})).toBeChecked();
});

test('navigation while a pending preference read yields cancels the old review submission', async () => {
  const settings = await connect();
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  server.prByNumber = {24: {...server.pr, id: 'PR_100', fullDatabaseId: '100'}};
  await settings.getByRole('radio', {name: /^Comment/}).check();
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  const page = await prPage();
  const control = page.getByRole('button', {
    name: 'Submit pending comments as a review',
    exact: true,
  });
  await expect(control).toBeVisible();
  const worker = context.serviceWorkers()[0];
  await worker.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    let preferenceReads = 0;
    chrome.storage.local.get = async (...args) => {
      const value = await get(...args);
      if (args[0] === 'pendingReviewAction' && ++preferenceReads === 3) {
        self.pendingPreferenceBlocked = true;
        await new Promise((resolve) => {
          self.releasePendingPreference = resolve;
        });
      }
      return value;
    };
  });
  await control.click();
  await expect.poll(() => worker.evaluate(() => self.pendingPreferenceBlocked)).toBe(true);
  await page.goto('https://github.com/example/widget/pull/24');
  await expect(
    page.getByRole('button', {name: 'Submit pending comments as a review', exact: true}),
  ).toBeVisible();
  await worker.evaluate(() => self.releasePendingPreference());
  await expect
    .poll(() =>
      settings.evaluate(
        async () => (await chrome.storage.local.get('attempt:7:99'))['attempt:7:99'],
      ),
    )
    .toBeUndefined();
  expect(server.posts).toHaveLength(0);
});

for (const [choice, label] of [
  [/^Request changes/, 'Request changes and submit pending comments'],
  [/^Comment/, 'Submit pending comments as a review'],
  [/^Approve/, 'Approve and submit pending comments'],
]) {
  test(`confirmed ${label} refreshes GitHub's native pending review controls`, async () => {
    const settings = await connect();
    server.showNativeReviewState = true;
    server.reviews = [
      {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
    ];
    await settings.getByRole('radio', {name: choice}).check();
    await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
    const page = await prPage();
    await expect(page.getByTestId('review-button')).toHaveText('Submit review 1 ▾');
    await expect(page.getByTestId('native-review-state')).toHaveText('1 pending comment');
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.getByRole('button', {name: label, exact: true}).click();
    await expect.poll(() => server.posts.length).toBe(1);
    await expect(page.getByTestId('review-button')).toHaveText('Submit review ▾');
    await expect(page.getByTestId('native-review-state')).toHaveText('Review submitted');
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(500);
    expect(server.posts).toHaveLength(1);
  });
}

test('approval actions share amber styling and completed approval is a distinct inert status', async () => {
  const settings = await connect();
  await expect(settings.locator('header .mark')).toHaveCount(0);
  await expect(settings.locator('header')).toContainText(
    'Review shortcuts for GitHub pull requests.',
  );
  const page = await prPage();
  const ordinary = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(ordinary).toBeVisible();
  const ordinaryColor = await ordinary.evaluate((button) => getComputedStyle(button).color);
  const ordinaryPath = await ordinary.locator('path').getAttribute('d');
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await settings.getByRole('radio', {name: /^Approve/}).check();
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  const pending = page.getByRole('button', {
    name: 'Approve and submit pending comments',
    exact: true,
  });
  await expect(pending).toBeVisible();
  expect(await pending.evaluate((button) => getComputedStyle(button).color)).toBe(ordinaryColor);
  const actionPath = await pending.locator('path').getAttribute('d');
  expect(ordinaryPath).toBe(actionPath);
  await pending.click();
  const completed = page.getByRole('button', {name: 'You approved this PR', exact: true});
  await expect(completed).toHaveAttribute('aria-disabled', 'true');
  await expect(completed).toBeVisible();
  expect(await completed.locator('path').getAttribute('d')).not.toBe(actionPath);
  const statusStyle = await completed.evaluate((button) => {
    const style = getComputedStyle(button);
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      color: style.color,
      cursor: style.cursor,
    };
  });
  expect(statusStyle.background).toBe('rgba(0, 0, 0, 0)');
  expect(statusStyle.border).toBe('rgba(0, 0, 0, 0)');
  expect(statusStyle.color).not.toBe(ordinaryColor);
  expect(statusStyle.cursor).toBe('default');
  await completed.hover();
  expect(await completed.evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  await completed.click({force: true});
  expect(server.posts).toHaveLength(1);
});

test('a confirmed pending submission from the previous PR cannot reload the current PR', async () => {
  const settings = await connect();
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await settings.getByRole('radio', {name: /^Comment/}).check();
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  const page = await prPage();
  let release;
  server.postGate = new Promise((resolve) => {
    release = resolve;
  });
  await page
    .getByRole('button', {name: 'Submit pending comments as a review', exact: true})
    .click();
  await expect.poll(() => server.posts.length).toBe(1);
  await page.evaluate(() => {
    window.pendingReloadMarker = true;
    history.pushState({}, '', '/example/widget/pull/24');
    document.dispatchEvent(new Event('turbo:load'));
  });
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
  release();
  await expect
    .poll(() =>
      settings.evaluate(async () => {
        const tabs = await chrome.tabs.query({url: 'https://github.com/*'});
        const snapshot = await chrome.tabs.sendMessage(
          tabs[0].id,
          {op: 'diagnosticsSnapshot'},
          {frameId: 0},
        );
        return snapshot.discarded;
      }),
    )
    .toBeGreaterThan(0);
  expect(await page.evaluate(() => window.pendingReloadMarker)).toBe(true);
  await expect(page).toHaveURL('https://github.com/example/widget/pull/24');
  expect(server.posts).toHaveLength(1);
});

test('Shift+L is disabled by default and the opt-in persists across settings reloads', async () => {
  const settings = await connect();
  const toggle = settings.getByRole('checkbox', {name: 'Enable Shift+L shortcut'});
  await expect(toggle).not.toBeChecked();
  const page = await prPage();
  const button = page.getByRole('button', {name: 'Quick approve', exact: true});
  await expect(button).toBeVisible();
  await page.keyboard.press('Shift+L');
  await expect(button).toHaveAttribute('data-state', 'available');
  expect(server.posts).toHaveLength(0);
  await toggle.check();
  await expect(settings.locator('#shortcut-status')).toHaveText('Shortcut enabled.');
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'Shift+L');
  await settings.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(settings.locator('#shortcut-status')).toHaveText('Shortcut disabled.');
  await expect(button).not.toHaveAttribute('aria-keyshortcuts');
  await page.keyboard.press('Shift+L');
  await expect(button).toHaveAttribute('data-state', 'available');
  expect(server.posts).toHaveLength(0);
});

for (const [choice, event] of [
  [null, 'APPROVE'],
  ['Request changes', 'REQUEST_CHANGES'],
  ['Comment', 'COMMENT'],
  ['Approve', 'APPROVE'],
]) {
  test(`Shift+L activates the ${choice ?? 'ordinary approval'} button action once`, async () => {
    const settings = await connect();
    if (choice) {
      server.reviews = [
        {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
      ];
      await settings.getByRole('radio', {name: new RegExp('^' + choice)}).check();
      await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
    }
    await settings.getByRole('checkbox', {name: 'Enable Shift+L shortcut'}).check();
    await expect(settings.locator('#shortcut-status')).toHaveText('Shortcut enabled.');
    const page = await prPage();
    await expect(page.locator('.qa-button')).toHaveAttribute('aria-keyshortcuts', 'Shift+L');
    await page.keyboard.press('Shift+L');
    await expect.poll(() => server.posts.length).toBe(1);
    if (choice) expect(server.posts[0]).toEqual({reviewId: 'PRR_pending', event});
    else expect(server.posts[0]).toEqual({pullRequestId: 'PR_99', commitOid: sha});
  });
}

test('Shift+L ignores editors, synthetic events, extra modifiers, and a locked review', async () => {
  const settings = await connect();
  await settings.getByRole('checkbox', {name: 'Enable Shift+L shortcut'}).check();
  await expect(settings.locator('#shortcut-status')).toHaveText('Shortcut enabled.');
  const page = await prPage();
  await expect(page.locator('.qa-button')).toHaveAttribute('aria-keyshortcuts', 'Shift+L');
  await page.evaluate(() => {
    const editors = document.createElement('div');
    editors.innerHTML =
      '<input id="shortcut-input"><textarea id="shortcut-comment"></textarea><select id="shortcut-select"><option>Value</option></select><div id="shortcut-editable" contenteditable="true">Review draft</div><div id="shortcut-textbox" role="textbox" tabindex="0">Custom editor</div>';
    document.querySelector('main').append(editors);
  });
  for (const id of [
    'shortcut-input',
    'shortcut-comment',
    'shortcut-select',
    'shortcut-editable',
    'shortcut-textbox',
  ]) {
    await page.locator('#' + id).focus();
    await page.keyboard.press('Shift+L');
  }
  await page.getByRole('heading', {name: 'Improve search results', exact: true}).click();
  await page.keyboard.press('Control+Shift+L');
  await page.keyboard.press('Alt+Shift+L');
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'L', shiftKey: true, bubbles: true})),
  );
  await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toHaveAttribute(
    'data-state',
    'available',
  );
  expect(server.posts).toHaveLength(0);
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await page.reload();
  await expect(
    page.getByRole('button', {name: 'Finish your pending review in GitHub', exact: true}),
  ).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Shift+L');
  expect(server.posts).toHaveLength(0);
});

test('holding Shift+L cannot submit again after the pending review refreshes', async () => {
  const settings = await connect();
  server.reviews = [
    {id: 'PRR_pending', fullDatabaseId: '51', author: server.user, state: 'PENDING'},
  ];
  await settings.getByRole('radio', {name: /^Comment/}).check();
  await expect(settings.locator('#review-preference-status')).toHaveText('Preference saved.');
  await settings.getByRole('checkbox', {name: 'Enable Shift+L shortcut'}).check();
  await expect(settings.locator('#shortcut-status')).toHaveText('Shortcut enabled.');
  const page = await prPage();
  await expect(page.locator('.qa-button')).toHaveAttribute('aria-keyshortcuts', 'Shift+L');
  await page.keyboard.down('Shift');
  try {
    await page.keyboard.down('l');
    await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
    await page.evaluate(() => {
      window.addEventListener(
        'keydown',
        (event) => {
          window.shortcutRepeatObserved = event.repeat;
        },
        {once: true},
      );
    });
    await page.keyboard.down('l');
    expect(await page.evaluate(() => window.shortcutRepeatObserved)).toBe(true);
    await expect(page.getByRole('button', {name: 'Quick approve', exact: true})).toBeVisible();
    expect(server.posts).toHaveLength(1);
  } finally {
    await page.keyboard.up('l');
    await page.keyboard.up('Shift');
  }
});
