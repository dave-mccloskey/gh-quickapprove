import {timing} from './timing.js';
export interface DiagnosticContext {
  tabId?: number;
  documentId?: string;
  target?: string;
}

export type DiagnosticTrace = (
  name: string,
  fields?: Record<string, unknown>,
  target?: string,
) => void;

interface DiagnosticEvent {
  time: number;
  session: string;
  name: string;
  fields: Record<string, number | boolean | string>;
  context: Record<string, string>;
}

interface DiagnosticData {
  schema: number;
  enabled: boolean;
  secret: string;
  events: DiagnosticEvent[];
  open: DiagnosticEvent[];
  discarded: number;
}

interface DiagnosticStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
}

/** Records bounded local evidence with an allowlisted, privacy-filtered export. */
export function createDiagnostics({
  storage,
  now = () => Date.now(),
}: {
  storage: DiagnosticStorage;
  now?: () => number;
}) {
  const session = crypto.randomUUID();
  const data = emptyData();
  let failures = 0;
  let lastSavedAt: number | undefined;
  let writeStartedAt: number | undefined;
  let writing: Promise<void> | undefined;
  let dirty = false;
  let canPersist = true;
  let revision = 0;
  let savedRevision = 0;
  let key: CryptoKey;
  const aliases = new Map<string, string>();
  const ready = initialize();
  let operations = ready;

  function record(
    name: string,
    fields: Record<string, unknown> = {},
    context: DiagnosticContext = {},
  ) {
    if (!EVENT_NAMES.includes(name)) return;
    const clean = sanitizeDiagnosticFields(fields);
    const time = now();
    operations = operations
      .then(async () => {
        if (!data.enabled) return;
        const pseudonyms: Record<string, string> = {};
        for (const [kind, value] of Object.entries(context)) {
          if (!['tabId', 'documentId', 'target'].includes(kind) || value === undefined) continue;
          const input = `${kind}:${value}`;
          let alias = aliases.get(input);
          if (!alias) {
            const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
            alias = hex(new Uint8Array(bytes)).slice(0, 16);
            if (aliases.size < 1000) aliases.set(input, alias);
          }
          pseudonyms[kind === 'tabId' ? 'tab' : kind === 'documentId' ? 'document' : 'target'] =
            alias;
        }
        const event = {time, session, name, fields: clean, context: pseudonyms};
        data.events.push(event);
        const span = clean.spanId;
        if (typeof span === 'string') {
          if (name.endsWith('.end') || name === 'queue.start') {
            data.open = data.open.filter((entry) => entry.fields.spanId !== span);
          } else if (name.endsWith('.begin') || name === 'queue.enter') {
            data.open.push(event);
            if (data.open.length > 100) {
              data.open.shift();
              data.discarded++;
            }
          }
        }
        prune();
        persist();
      })
      .catch(() => {
        failures++;
      });
  }

  async function exportReport() {
    await operations;
    if (prune()) persist();
    await flush();
    return {
      schemaVersion: 1,
      capturedAt: new Date(now()).toISOString(),
      workerSession: session,
      enabled: data.enabled,
      retentionDays: 7,
      maximumEvents: 2000,
      discardedEvents: data.discarded,
      persistence: {
        failures,
        lastSavedAt,
        pendingSince: writeStartedAt,
        available: canPersist,
        upToDate: canPersist && savedRevision === revision,
      },
      events: structuredClone(data.events),
      unfinished: data.open.map((event) => ({
        event: structuredClone(event),
        ageMs: Math.max(0, now() - event.time),
        interrupted: event.session !== session,
      })),
    };
  }

  async function flush() {
    await operations;
    // Export must still work if diagnostic storage is full or unresponsive.
    const pending = writing;
    if (pending) await bounded(pending, timing.diagnosticStorageMs);
    if (writing && writing !== pending) await bounded(writing, timing.diagnosticStorageMs);
  }

  async function clear() {
    operations = operations.then(async () => {
      data.events = [];
      data.open = [];
      data.discarded = 0;
      data.secret = randomSecret();
      aliases.clear();
      await importKey();
      persist();
    });
    await operations;
    const targetRevision = revision;
    await flush();
    if (savedRevision < targetRevision) throw new Error('Diagnostic history could not be saved');
  }

  async function setEnabled(enabled: boolean) {
    operations = operations.then(() => {
      data.enabled = enabled;
      persist();
    });
    await operations;
    const targetRevision = revision;
    await flush();
    if (savedRevision < targetRevision) throw new Error('Diagnostic settings could not be saved');
  }

  async function initialize() {
    try {
      const stored = await bounded(storage.get(STORAGE_KEY), timing.diagnosticStorageMs);
      if (stored.timedOut) {
        canPersist = false;
        data.enabled = false;
        failures++;
      } else if (isRecord(stored.value) && stored.value.schema === 1) {
        const value = stored.value;
        data.enabled = value.enabled !== false;
        if (typeof value.secret === 'string' && /^[a-f0-9]{64}$/.test(value.secret))
          data.secret = value.secret;
        data.events = readEvents(value.events);
        data.open = readEvents(value.open).slice(-100);
        if (typeof value.discarded === 'number' && Number.isFinite(value.discarded))
          data.discarded = Math.max(0, value.discarded);
      }
    } catch {
      canPersist = false;
      data.enabled = false;
      failures++;
    }
    await importKey();
    if (prune()) persist();
  }

  async function importKey() {
    key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(data.secret),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['sign'],
    );
  }

  function prune() {
    const before = data.events.length + data.open.length;
    const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
    const kept = data.events.filter((event) => event.time >= cutoff).slice(-2000);
    data.discarded += data.events.length - kept.length;
    data.events = kept;
    data.open = data.open.filter((event) => event.time >= cutoff);
    return before !== data.events.length + data.open.length;
  }

  function persist() {
    revision++;
    dirty = true;
    if (writing || !canPersist) return;
    dirty = false;
    writeStartedAt = now();
    const snapshot = structuredClone(data);
    const snapshotRevision = revision;
    writing = Promise.resolve()
      .then(() => storage.set(STORAGE_KEY, snapshot))
      .then(
        () => {
          lastSavedAt = now();
          savedRevision = snapshotRevision;
        },
        () => {
          failures++;
        },
      )
      .finally(() => {
        writing = undefined;
        writeStartedAt = undefined;
        if (dirty) persist();
      });
  }

  return {ready, record, export: exportReport, flush, clear, setEnabled};
}

/** Discards arbitrary text, payloads, and unknown fields before persistence. */
export function sanitizeDiagnosticFields(
  input: unknown,
): Record<string, number | boolean | string> {
  const result: Record<string, number | boolean | string> = {};
  if (!isRecord(input)) return result;
  for (const name of NUMBER_FIELDS) {
    const value = input[name];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      result[name] = Math.min(1_000_000_000, Math.round(value));
  }
  for (const name of BOOLEAN_FIELDS)
    if (typeof input[name] === 'boolean') result[name] = input[name];
  for (const [name, choices] of Object.entries(CHOICE_FIELDS)) {
    const value = input[name];
    if (typeof value === 'string' && choices.includes(value)) result[name] = value;
  }
  for (const name of ['spanId', 'traceId', 'clientId']) {
    const value = input[name];
    if (
      typeof value === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
    )
      result[name] = value;
  }
  if (typeof input.buildId === 'string' && /^[a-f0-9]{64}$/.test(input.buildId))
    result.buildId = input.buildId;
  return result;
}

function diagnosticError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'QuotaExceededError'].includes(
    name,
  )
    ? name
    : 'OtherError';
}

/** Keeps only packaged script locations, never arbitrary exception text or stacks. */
export function diagnosticErrorFields(error: unknown): Record<string, unknown> {
  const frame =
    error instanceof Error
      ? error.stack?.match(
          /chrome-extension:\/\/[a-p]{32}\/(background|content|api|service|diagnostics|options|shared|watchdog|timing)\.js:(\d+):(\d+)/,
        )
      : undefined;
  return {
    error: diagnosticError(error),
    ...(frame ? {file: `${frame[1]}.js`, line: Number(frame[2]), column: Number(frame[3])} : {}),
  };
}

/** Prevents optional diagnostics from changing application outcomes. */
export function emitDiagnostic(
  trace: DiagnosticTrace | undefined,
  name: string,
  fields: Record<string, unknown> = {},
  target?: string,
) {
  try {
    trace?.(name, fields, target);
  } catch {
    /* Diagnostics must not affect an approval. */
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function bounded<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<{timedOut: boolean; value?: T}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({timedOut: false, value})),
      new Promise<{timedOut: boolean}>((resolve) => {
        timer = setTimeout(() => resolve({timedOut: true}), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyData(): DiagnosticData {
  return {schema: 1, enabled: true, secret: randomSecret(), events: [], open: [], discarded: 0};
}

function randomSecret() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}
function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readEvents(value: unknown): DiagnosticEvent[] {
  if (!Array.isArray(value)) return [];
  const events: DiagnosticEvent[] = [];
  for (const item of value.slice(-2000)) {
    if (
      !isRecord(item) ||
      typeof item.name !== 'string' ||
      !EVENT_NAMES.includes(item.name) ||
      typeof item.time !== 'number' ||
      !Number.isFinite(item.time) ||
      typeof item.session !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(item.session)
    )
      continue;
    const context: Record<string, string> = {};
    if (isRecord(item.context))
      for (const name of ['tab', 'document', 'target']) {
        const alias = item.context[name];
        if (typeof alias === 'string' && /^[a-f0-9]{16}$/.test(alias)) context[name] = alias;
      }
    events.push({
      time: item.time,
      session: item.session,
      name: item.name,
      fields: sanitizeDiagnosticFields(item.fields),
      context,
    });
  }
  return events;
}

const STORAGE_KEY = 'diagnosticHistory';
const EVENT_NAMES = [
  'worker.start',
  'worker.build',
  'worker.ready',
  'worker.error',
  'message.begin',
  'message.end',
  'message.stalled',
  'message.rejected',
  'api.begin',
  'api.headers',
  'api.end',
  'storage.begin',
  'storage.end',
  'queue.enter',
  'queue.start',
  'queue.end',
  'service.phase',
  'service.state',
  'context.begin',
  'context.end',
  'notify.begin',
  'notify.end',
  'ui.boot',
  'ui.route',
  'ui.prState',
  'ui.control',
  'ui.refresh.begin',
  'ui.refresh.end',
  'ui.refresh.ignored',
  'ui.stalled',
  'ui.approval.begin',
  'ui.approval.end',
  'ui.context',
  'ui.exception',
  'ui.visibility',
  'ui.snapshot',
];
const NUMBER_FIELDS = [
  'durationMs',
  'waitMs',
  'count',
  'pending',
  'page',
  'status',
  'generation',
  'request',
  'suppressed',
  'discarded',
  'rateRemaining',
  'retryAfterSeconds',
  'line',
  'column',
  'diagnosticFailures',
];
const BOOLEAN_FIELDS = [
  'visible',
  'online',
  'mounted',
  'anchorFound',
  'pendingRefresh',
  'submitting',
  'pageUserPresent',
  'matched',
  'sourceIsExtension',
  'present',
  'invalid',
  'hasAttempt',
  'dirty',
  'enabled',
  'deferredRefresh',
  'watchdogActive',
];
const CHOICE_FIELDS: Record<string, string[]> = {
  file: [
    'background.js',
    'content.js',
    'api.js',
    'service.js',
    'diagnostics.js',
    'options.js',
    'shared.js',
    'watchdog.js',
    'timing.js',
  ],
  op: [
    'state',
    'approve',
    'recheck',
    'resetAttempt',
    'openSettings',
    'status',
    'setToken',
    'removeToken',
  ],
  endpoint: ['user', 'pull', 'reviews', 'approve'],
  state: [
    'loading',
    'busy',
    'setup',
    'invalid',
    'account',
    'error',
    'access',
    'uncertain',
    'changed',
    'canceled',
    'available',
    'approved',
    'merged',
    'closed',
    'own',
    'pending',
    'connected',
  ],
  pageState: ['open', 'draft', 'closed', 'merged', 'unknown'],
  phase: [
    'credential',
    'pull',
    'reviews',
    'attempt',
    'reduce',
    'context',
    'dispatch',
    'notify',
    'parse',
  ],
  area: ['credential', 'attempt', 'access'],
  operation: ['get', 'set', 'remove'],
  outcome: ['ok', 'error', 'timeout', 'superseded', 'rejected', 'unavailable', 'interrupted'],
  reason: [
    'route',
    'page-state',
    'focus',
    'visibility',
    'notification',
    'navigation',
    'initial',
    'deduplicated',
    'unknown',
    'uncaught',
    'unhandled',
    'generation',
    'request',
    'authorized',
    'unauthorized',
  ],
  error: [
    'AbortError',
    'TimeoutError',
    'TypeError',
    'SyntaxError',
    'QuotaExceededError',
    'OtherError',
  ],
};
