import {test, expect, chromium} from '@playwright/test';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

let context;
let profile;
let extensionId;
let server;
const sha = 'a'.repeat(40);

test.beforeEach(async () => {
  server = {
    user: {id: 7, login: 'reviewer'},
    reviews: [],
    posts: [],
    invalid: false,
    pr: {id: 99, state: 'open', merged: false, user: {id: 8, login: 'contributor'}, head: {sha}},
  };
  profile = await mkdtemp(join(tmpdir(), 'gh-quickapprove-'));
  await launchContext();
});

async function launchContext({viewport = {width: 1440, height: 900}, deviceScaleFactor = 1} = {}) {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${resolve('dist/extension')}`,
      `--load-extension=${resolve('dist/extension')}`,
    ],
    viewport,
    deviceScaleFactor,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  const fixture = await readFile('tests/fixtures/pr.html', 'utf8');
  await context.route('https://github.com/**', (route) =>
    route.fulfill({contentType: 'text/html', body: fixture}),
  );
  await context.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (server.invalid || request.headers().authorization === 'Bearer bad')
      return route.fulfill({status: 401, json: {message: 'Bad credentials'}});
    if (path === '/user') return route.fulfill({json: server.user});
    if (request.method() === 'POST') {
      server.posts.push(request.postDataJSON());
      const review = {id: 101, user: server.user, state: 'APPROVED', commit_id: sha};
      if (!server.hidePostedReview) server.reviews.push(review);
      if (server.losePostResponse) return route.abort('failed');
      if (server.postGate) await server.postGate;
      return route.fulfill({status: 201, json: review});
    }
    server.readRequests = (server.readRequests ?? 0) + 1;
    if (server.readDelay) await new Promise((done) => setTimeout(() => done(), server.readDelay));
    if (server.accessDenied) return route.fulfill({status: 403, json: {message: 'Forbidden'}});
    return route.fulfill({json: path.endsWith('/reviews') ? server.reviews : server.pr});
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

test('one native click approves pinned commit and keeps toolbar placement', async () => {
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
  await page.screenshot({path: 'test-results/pr-approved.png'});
  expect(server.posts).toEqual([{event: 'APPROVE', commit_id: sha}]);
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
    if (kind === 'own') server.pr.user = server.user;
    if (kind === 'merged') {
      server.pr.state = 'closed';
      server.pr.merged = true;
    }
    if (kind === 'closed') server.pr.state = 'closed';
    if (kind === 'pending') server.reviews = [{id: 1, user: server.user, state: 'PENDING'}];
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
  expect(server.posts).toEqual([{event: 'APPROVE', commit_id: sha}]);
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
  server.readDelay = 100;
  const page = await context.newPage();
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const activity = document.createElement('div');
      document.body.append(activity);
      let updates = 0;
      window.setInterval(() => {
        activity.textContent = `Activity update ${++updates}`;
      }, 20);
    });
  });
  await page.goto('https://github.com/example/widget/pull/23');
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
  server.reviews = [{id: 1, user: server.user, state: 'APPROVED', commit_id: sha}];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  server.pr.state = 'closed';
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
  server.reviews = [{id: 1, user: server.user, state: 'APPROVED', commit_id: sha}];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  await page.evaluate(() => {
    const status = document.createElement('button');
    status.setAttribute('aria-label', 'Pull request state: Open');
    status.textContent = 'PR state';
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').replaceWith(status);
  });
  server.pr.state = 'closed';
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
  server.pr.state = 'closed';
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
  server.reviews = [{id: 1, user: server.user, state: 'APPROVED', commit_id: sha}];
  const page = await prPage();
  await expect(page.getByRole('button', {name: 'You approved this PR', exact: true})).toBeVisible();
  server.pr.state = 'closed';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Closed';
  });
  await expect(page.getByRole('button', {name: 'This PR is closed', exact: true})).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  server.pr.state = 'open';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Open';
  });
  await expect(
    page.getByRole('button', {name: 'You approved this PR', exact: true}),
  ).toHaveAttribute('aria-disabled', 'true');
  server.reviews = [];
  server.pr.state = 'closed';
  await page.evaluate(() => {
    document.querySelector('[class^="prc-StateLabel-StateLabel"]').textContent = 'Closed';
  });
  await expect(page.getByRole('button', {name: 'This PR is closed', exact: true})).toBeVisible();
  server.pr.state = 'open';
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
