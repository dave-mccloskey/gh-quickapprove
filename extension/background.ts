import {timing} from './timing.js';
import {createApi} from './api.js';
import {createService} from './service.js';
import {parsePrUrl} from './shared.js';
import {
  createDiagnostics,
  diagnosticErrorFields,
  isRecord,
  sanitizeDiagnosticFields,
} from './diagnostics.js';
import type {DiagnosticContext} from './diagnostics.js';
import type {MessageSender} from './model.js';

const rawStorage = {
  get: async <T>(key: string): Promise<T | undefined> => {
    const values: Record<string, T> = await chrome.storage.local.get(key);
    return values[key];
  },
  set: async (key: string, value: unknown) => chrome.storage.local.set({[key]: value}),
  remove: async (key: string) => chrome.storage.local.remove(key),
};
const diagnostics = createDiagnostics({storage: rawStorage});
const metadata = buildMetadata();
diagnostics.record('worker.start');
void metadata.then((info) => diagnostics.record('worker.build', {buildId: info.buildId}));
const ready = restrictStorage();
void ready.then(
  () => diagnostics.record('worker.ready'),
  (error) => diagnostics.record('worker.error', diagnosticErrorFields(error)),
);
const service = createService({
  extensionId: chrome.runtime.id,
  api: createApi(
    (...args) => fetch(...args),
    (name, fields) => diagnostics.record(name, fields),
  ),
  trace: (name, fields, target) => diagnostics.record(name, fields, {target}),
  storage: {
    get: <T>(key: string) => tracedStorage('get', key, () => rawStorage.get<T>(key)),
    set: (key, value) => tracedStorage('set', key, () => rawStorage.set(key, value)),
    remove: (key) => tracedStorage('remove', key, () => rawStorage.remove(key)),
  },
  verifyContext: async (sender, message) => {
    const spanId = crypto.randomUUID();
    const start = performance.now();
    const context = senderContext(sender);
    let matched = false;
    diagnostics.record('context.begin', {spanId, traceId: message.traceId}, context);
    try {
      if (sender.tab?.id === undefined || !sender.documentId) return false;
      const tab = await chrome.tabs.get(sender.tab.id);
      const current = parsePrUrl(tab.url ?? '');
      const original = parsePrUrl(sender.tab?.url ?? sender.url ?? '');
      if (!current || current.key !== original?.key) return false;
      const acknowledgment = await chrome.tabs.sendMessage(
        sender.tab.id,
        {
          op: 'confirmContext',
          generation: message.generation,
          pageUser: message.pageUser,
          sha: message.sha,
        },
        {documentId: sender.documentId},
      );
      matched = acknowledgment?.current === true;
      return matched;
    } catch {
      return false;
    } finally {
      diagnostics.record(
        'context.end',
        {spanId, traceId: message.traceId, matched, durationMs: performance.now() - start},
        context,
      );
    }
  },
  notify: async () => {
    const spanId = crypto.randomUUID();
    const start = performance.now();
    let outcome = 'ok';
    diagnostics.record('notify.begin', {spanId});
    try {
      const tabs = await withTimeout(
        chrome.tabs.query({url: 'https://github.com/*'}),
        timing.notificationMs,
      );
      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.id === undefined) return;
          try {
            await withTimeout(
              chrome.tabs.sendMessage(tab.id, {op: 'refreshState'}, {frameId: 0}),
              timing.notificationMs,
            );
          } catch {
            outcome = 'unavailable';
          }
        }),
      );
    } catch {
      // Notifications must not change the outcome of a completed user action.
      outcome = 'unavailable';
    } finally {
      diagnostics.record('notify.end', {spanId, outcome, durationMs: performance.now() - start});
    }
  },
  openSettings: async () => chrome.runtime.openOptionsPage(),
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (isRecord(message) && typeof message.op === 'string' && message.op.startsWith('diagnostics')) {
    void handleDiagnostics(message, sender).then(
      (result) => respond(result),
      () => respond({ok: false}),
    );
    return true;
  }
  const spanId = crypto.randomUUID();
  const start = performance.now();
  const context = senderContext(sender);
  const fields = sanitizeDiagnosticFields(message);
  diagnostics.record('message.begin', {...fields, spanId}, context);
  const watchdog = setTimeout(
    () =>
      diagnostics.record(
        'message.stalled',
        {...fields, spanId, durationMs: performance.now() - start},
        context,
      ),
    timing.messageStallMs,
  );
  ready
    .then(() => service.handle(message, sender))
    .then(
      (result) => {
        diagnostics.record(
          'message.end',
          {
            ...fields,
            spanId,
            state: result.kind,
            outcome: 'ok',
            durationMs: performance.now() - start,
          },
          context,
        );
        respond(result);
      },
      (error) => {
        diagnostics.record(
          'message.end',
          {
            ...fields,
            spanId,
            outcome: 'error',
            ...diagnosticErrorFields(error),
            durationMs: performance.now() - start,
          },
          context,
        );
        respond({
          kind: 'error',
          label: 'Quick Approve could not process this request. Reload the extension and try again',
        });
      },
    )
    .finally(() => clearTimeout(watchdog));
  return true;
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
self.addEventListener('unhandledrejection', (event) =>
  diagnostics.record('worker.error', {reason: 'unhandled', ...diagnosticErrorFields(event.reason)}),
);
self.addEventListener('error', (event) =>
  diagnostics.record('worker.error', {reason: 'uncaught', ...diagnosticErrorFields(event.error)}),
);

async function tracedStorage<T>(
  operation: string,
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  const spanId = crypto.randomUUID();
  const start = performance.now();
  const area = key === 'credential' ? 'credential' : 'attempt';
  diagnostics.record('storage.begin', {spanId, area, operation});
  try {
    const value = await action();
    diagnostics.record('storage.end', {
      spanId,
      area,
      operation,
      outcome: 'ok',
      durationMs: performance.now() - start,
    });
    return value;
  } catch (error) {
    diagnostics.record('storage.end', {
      spanId,
      area,
      operation,
      outcome: 'error',
      durationMs: performance.now() - start,
      ...diagnosticErrorFields(error),
    });
    throw error;
  }
}

function senderContext(sender: MessageSender): DiagnosticContext {
  return {
    tabId: sender.tab?.id,
    documentId: sender.documentId,
    target: parsePrUrl(sender.tab?.url ?? sender.url ?? '')?.key,
  };
}

async function handleDiagnostics(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
) {
  if (sender.id !== chrome.runtime.id) return {ok: false};
  if (message.op === 'diagnosticsEvent') {
    if (
      sender.frameId !== 0 ||
      !sender.documentId ||
      !Number.isInteger(sender.tab?.id) ||
      !sender.url?.startsWith('https://github.com/')
    )
      return {ok: false};
    if (
      typeof message.name !== 'string' ||
      !message.name.startsWith('ui.') ||
      !allowClientEvent(sender.documentId)
    )
      return {ok: false};
    diagnostics.record(
      message.name,
      sanitizeDiagnosticFields(message.fields),
      senderContext(sender),
    );
    return {ok: true};
  }
  if (sender.url !== `chrome-extension://${chrome.runtime.id}/options.html`) return {ok: false};
  if (message.op === 'diagnosticsClear') {
    await diagnostics.clear();
    return {ok: true};
  }
  if (message.op === 'diagnosticsSetEnabled' && typeof message.enabled === 'boolean') {
    await diagnostics.setEnabled(message.enabled);
    return {ok: true};
  }
  if (message.op === 'diagnosticsStatus') {
    const report = await diagnostics.export();
    return {
      ok: true,
      enabled: report.enabled,
      count: report.events.length,
      failures: report.persistence.failures,
      persisted: report.persistence.upToDate,
      available: report.persistence.available,
    };
  }
  if (message.op !== 'diagnosticsExport') return {ok: false};
  const tabs = await chrome.tabs.query({url: 'https://github.com/*'});
  const targets = tabs
    .filter((tab) => tab.id !== undefined && parsePrUrl(tab.url ?? ''))
    .slice(0, 32);
  await Promise.all(
    targets.map(async (tab) => {
      const context = {tabId: tab.id, target: parsePrUrl(tab.url ?? '')?.key};
      try {
        const snapshot = await withTimeout(
          chrome.tabs.sendMessage(tab.id ?? -1, {op: 'diagnosticsSnapshot'}, {frameId: 0}),
          timing.snapshotMs,
        );
        diagnostics.record(
          'ui.snapshot',
          {...sanitizeDiagnosticFields(snapshot), outcome: 'ok'},
          context,
        );
      } catch {
        diagnostics.record('ui.snapshot', {outcome: 'unavailable'}, context);
      }
    }),
  );
  return {
    ok: true,
    report: {
      ...(await diagnostics.export()),
      ...(await metadata),
      inspectedTabs: targets.length,
      omittedTabs: Math.max(0, tabs.length - targets.length),
    },
  };
}

const clientRates = new Map<string, {start: number; count: number}>();
function allowClientEvent(documentId: string) {
  const now = Date.now();
  for (const [id, rate] of clientRates) if (now - rate.start > 60_000) clientRates.delete(id);
  let rate = clientRates.get(documentId);
  if (!rate) {
    if (clientRates.size >= 100) return false;
    rate = {start: now, count: 0};
    clientRates.set(documentId, rate);
  }
  return ++rate.count <= 180;
}

async function buildMetadata() {
  let buildId = 'unavailable';
  try {
    const response = await fetch(chrome.runtime.getURL('build-info.json'), {
      signal: AbortSignal.timeout(timing.metadataMs),
    });
    const info: unknown = await response.json();
    if (isRecord(info) && typeof info.buildId === 'string' && /^[a-f0-9]{64}$/.test(info.buildId))
      buildId = info.buildId;
  } catch {
    /* Older unpacked builds might not contain build metadata. */
  }
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    buildId,
    chromeVersion: navigator.userAgent.match(/Chrom(?:e|ium)\/([\d.]+)/)?.[1] ?? 'unknown',
  };
}

async function restrictStorage() {
  const spanId = crypto.randomUUID();
  diagnostics.record('storage.begin', {spanId, area: 'access', operation: 'set'});
  try {
    if (typeof chrome.storage.local.setAccessLevel !== 'function')
      throw new Error('Trusted storage is unavailable');
    await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
    diagnostics.record('storage.end', {spanId, area: 'access', operation: 'set', outcome: 'ok'});
  } catch (error) {
    diagnostics.record('storage.end', {
      spanId,
      area: 'access',
      operation: 'set',
      outcome: 'error',
      ...diagnosticErrorFields(error),
    });
    throw error;
  }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((resolve, reject) => {
        void resolve;
        timer = setTimeout(() => reject(new Error('Request timed out')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
