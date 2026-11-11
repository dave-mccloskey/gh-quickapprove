import {appendFile, readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {verifyPackage} from './verify-release.js';
import {chromeVersion} from './release-version.js';

export async function submitPackage({
  publisher,
  item,
  token,
  version,
  mode,
  bytes,
  request = fetch,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  pollAttempts = 24,
}) {
  if (
    !/^[a-zA-Z0-9_-]+$/.test(publisher ?? '') ||
    !/^[a-p]{32}$/.test(item ?? '') ||
    !token ||
    !['upload-only', 'submit-for-review'].includes(mode)
  ) {
    throw new Error('Invalid store configuration or submission mode.');
  }
  const base = `https://chromewebstore.googleapis.com/v2/publishers/${publisher}/items/${item}`;
  const status = await call(`${base}:fetchStatus`);
  if (status.lastAsyncUploadState === 'IN_PROGRESS')
    throw new Error(
      'A store upload is still processing. Wait and inspect the dashboard before retrying.',
    );
  if (status.takenDown || status.warned)
    throw new Error('Resolve the store policy warning in the dashboard first.');
  if (
    status.submittedItemRevisionStatus &&
    !['REJECTED', 'CANCELLED'].includes(status.submittedItemRevisionStatus.state)
  ) {
    throw new Error(
      'A store submission already exists. Inspect the dashboard before another upload.',
    );
  }
  for (const channel of status.publishedItemRevisionStatus?.distributionChannels ?? []) {
    if (compareVersions(version, channel.crxVersion) <= 0)
      throw new Error('Release must be newer than the published store version.');
  }
  const upload = await call(
    `https://chromewebstore.googleapis.com/upload/v2/publishers/${publisher}/items/${item}:upload`,
    {
      method: 'POST',
      body: bytes,
      headers: {'Content-Type': 'application/zip'},
    },
  );
  if (upload.crxVersion && upload.crxVersion !== version)
    throw new Error('Store upload returned a different version.');
  let state = upload.uploadState;
  for (let attempt = 0; state === 'IN_PROGRESS' && attempt < pollAttempts; attempt++) {
    await wait(5000);
    state = (await call(`${base}:fetchStatus`)).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED')
    throw new Error(
      `Store upload did not complete successfully (${safeState(state)}). Inspect the dashboard before retrying.`,
    );
  if (mode === 'upload-only') return {uploadState: state};
  const submission = await call(`${base}:publish`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      publishType: 'DEFAULT_PUBLISH',
      skipReview: false,
      blockOnWarnings: true,
    }),
  });
  if (!submission.state)
    throw new Error('Store submission returned no state. Inspect the dashboard before retrying.');
  const current = await call(`${base}:fetchStatus`);
  return {
    uploadState: state,
    submissionState: safeState(submission.state),
    storeState: safeState(
      current.submittedItemRevisionStatus?.state ?? current.publishedItemRevisionStatus?.state,
    ),
  };

  async function call(url, options = {}) {
    let response;
    try {
      response = await request(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
        headers: {...options.headers, Authorization: `Bearer ${token}`},
      });
    } catch {
      // A lost POST response can still mean the store accepted the request.
      throw new Error(
        'Store request failed or timed out. Inspect the dashboard before retrying; writes are not retried automatically.',
      );
    }
    if (!response.ok)
      throw new Error(
        `Store request failed (HTTP ${response.status}). Inspect the dashboard for details before retrying.`,
      );
    try {
      return await response.json();
    } catch {
      throw new Error(
        'Store returned an unreadable response. Inspect the dashboard before retrying.',
      );
    }
  }
}

function compareVersions(left, right) {
  if (!/^\d+(?:\.\d+){0,3}$/.test(right ?? ''))
    throw new Error('Store returned an invalid version.');
  const a = left.split('.').map((part) => Number(part));
  const b = right.split('.').map((part) => Number(part));
  for (let index = 0; index < 4; index++) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function safeState(state) {
  return [
    'SUCCEEDED',
    'IN_PROGRESS',
    'FAILED',
    'NOT_FOUND',
    'UPLOAD_STATE_UNSPECIFIED',
    'PENDING_REVIEW',
    'STAGED',
    'PUBLISHED',
    'PUBLISHED_TO_TESTERS',
    'REJECTED',
    'CANCELLED',
    'ITEM_STATE_UNSPECIFIED',
  ].includes(state)
    ? state
    : 'UNKNOWN';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = process.env.RELEASE_NAME;
  chromeVersion(release);
  const bytes = await readFile(`dist/submission/gh-quickapprove-${release}.zip`);
  const version = verifyPackage(
    bytes,
    await readFile('dist/submission/SHA256SUMS', 'utf8'),
    release,
  );
  const result = await submitPackage({
    publisher: process.env.CWS_PUBLISHER_ID,
    item: process.env.CWS_EXTENSION_ID,
    token: process.env.CWS_ACCESS_TOKEN,
    version,
    mode: process.env.SUBMISSION_MODE,
    bytes,
  });
  const summary = `Release: ${release}\n\nChrome Web Store result:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n\nSubmission does not mean Google has approved or published the extension. Check the developer dashboard for review progress.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}
