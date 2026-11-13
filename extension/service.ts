import type {
  Attempt,
  Credential,
  ExtensionMessage,
  MessageSender,
  PrTarget,
  ServiceDependencies,
  ViewState,
  ReviewAction,
} from './model.js';
import {parsePrUrl, reduceState, pendingReviewAction, reviewStates} from './shared.js';
import {emitDiagnostic} from './diagnostics.js';

/** Owns credentials and serializes approvals across content-script requests. */
export function createService({
  storage,
  api,
  verifyContext,
  notify,
  openSettings,
  extensionId,
  trace,
}: ServiceDependencies) {
  const operations = new Map<string, Promise<ViewState>>();
  const queued = new Map<string, number>();
  let credentialRevision = 0;
  let preferenceRevision = 0;
  let preferenceWrites = 0;
  let credentialQueue = Promise.resolve();

  async function handle(message: ExtensionMessage, sender: MessageSender): Promise<ViewState> {
    const target = authorize(message, sender, extensionId);
    if (!target) {
      if (message.op === 'getPreferences' || message.op === 'setPreferences') {
        if (message.op === 'setPreferences') {
          preferenceRevision++;
          preferenceWrites++;
          try {
            await storage.set('pendingReviewAction', message.action);
          } finally {
            preferenceWrites--;
            preferenceRevision++;
          }
          await notify();
        }
        return {
          kind: 'preferences',
          label: 'Review preference saved',
          action: pendingReviewAction(await storage.get('pendingReviewAction')),
        };
      }
      return manageCredential(message);
    }
    if (message.op === 'openSettings') {
      await openSettings();
      return {kind: 'setup', label: 'Set up Quick Approve'};
    }
    const previous = operations.get(target.key);
    const queueSpan = crypto.randomUUID();
    const entered = performance.now();
    const depth = (queued.get(target.key) ?? 0) + 1;
    queued.set(target.key, depth);
    emitDiagnostic(
      trace,
      'queue.enter',
      {spanId: queueSpan, traceId: message.traceId, op: message.op, pending: depth},
      target.key,
    );
    const operation = (
      previous
        ? previous.then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve()
    ).then(() => {
      emitDiagnostic(
        trace,
        'queue.start',
        {
          spanId: queueSpan,
          traceId: message.traceId,
          op: message.op,
          waitMs: performance.now() - entered,
        },
        target.key,
      );
      return handlePr(message, sender, target);
    });
    operations.set(target.key, operation);
    try {
      return await operation;
    } finally {
      queued.set(target.key, Math.max(0, (queued.get(target.key) ?? 1) - 1));
      if (queued.get(target.key) === 0) queued.delete(target.key);
      emitDiagnostic(
        trace,
        'queue.end',
        {traceId: message.traceId, op: message.op, durationMs: performance.now() - entered},
        target.key,
      );
      if (operations.get(target.key) === operation) operations.delete(target.key);
      if (message.op === 'approve') await notify();
    }
  }

  async function handlePr(
    message: ExtensionMessage,
    sender: MessageSender,
    target: PrTarget,
  ): Promise<ViewState> {
    let credential: Credential | undefined;
    const revision = credentialRevision;
    const preference = preferenceRevision;
    try {
      credential = await storage.get<Credential>('credential');
      emitDiagnostic(
        trace,
        'service.phase',
        {
          traceId: message.traceId,
          phase: 'credential',
          present: Boolean(credential),
          invalid: Boolean(credential?.invalid),
        },
        target.key,
      );
      if (!credential) return {kind: 'setup', label: 'Set up Quick Approve'};
      if (credential.invalid)
        return {kind: 'invalid', label: 'GitHub token expired or invalid. Update token'};
      const snapshot = await load(target, credential, message.pageUser, message.traceId);
      if (message.op === 'resetAttempt') {
        if (!(await verifyContext(sender, message))) return canceled();
        await storage.remove(snapshot.attemptKey);
        return reduceState({...snapshot, pageUser: message.pageUser});
      }
      if (message.op !== 'approve' || snapshot.state.kind !== 'available') return snapshot.state;
      const action: ReviewAction =
        message.action === 'changes' || message.action === 'comment' ? message.action : 'approve';
      if (
        action !== (snapshot.state.action ?? 'approve') ||
        message.reviewId !== snapshot.state.reviewId
      )
        return canceled();
      if (!message.sha || message.sha !== snapshot.pr.head.sha) {
        return {
          kind: 'changed',
          label: 'New commits arrived. Review the changes before submitting',
          sha: snapshot.pr.head.sha,
        };
      }
      if (!(await verifyContext(sender, message))) return canceled();
      if (!(await sameCredential(credential))) return canceled();
      const attempt = {
        id: crypto.randomUUID(),
        accountId: credential.user.id,
        prId: snapshot.pr.id,
        target,
        sha: message.sha,
        reviewIds: snapshot.reviews.map((review) => review.id),
        action,
        ...(message.reviewId ? {reviewId: message.reviewId} : {}),
      };
      await storage.set(snapshot.attemptKey, attempt);
      // Storage and acknowledgment can yield; repeat both checks at the dispatch boundary.
      if (
        (message.reviewId &&
          action !== pendingReviewAction(await storage.get('pendingReviewAction'))) ||
        !(await sameCredential(credential)) ||
        !(await verifyContext(sender, message)) ||
        revision !== credentialRevision ||
        (message.reviewId && (preference !== preferenceRevision || preferenceWrites > 0))
      ) {
        await storage.remove(snapshot.attemptKey);
        return canceled();
      }
      if (message.reviewId) {
        // Unlike creating an approval, submitting a pending review has no commitOID input.
        // Refresh the head immediately before dispatch, then re-confirm the local context.
        let current;
        try {
          current = await api.pull(target, credential.token, message.traceId);
        } catch (error) {
          await storage.remove(snapshot.attemptKey);
          throw error;
        }
        if (current.head.sha !== message.sha) {
          await storage.remove(snapshot.attemptKey);
          return {
            kind: 'changed',
            label: 'New commits arrived. Review the changes before submitting',
            sha: current.head.sha,
          };
        }
        if (
          current.state !== 'open' ||
          current.merged ||
          current.user.id === credential.user.id ||
          action !== pendingReviewAction(await storage.get('pendingReviewAction')) ||
          !(await sameCredential(credential)) ||
          !(await verifyContext(sender, message)) ||
          revision !== credentialRevision ||
          preference !== preferenceRevision ||
          preferenceWrites > 0
        ) {
          await storage.remove(snapshot.attemptKey);
          return canceled();
        }
      }
      try {
        emitDiagnostic(
          trace,
          'service.phase',
          {traceId: message.traceId, phase: 'dispatch'},
          target.key,
        );
        const review = message.reviewId
          ? await api.submitReview(message.reviewId, action, credential.token, message.traceId)
          : await api.approve(snapshot.pr.nodeId, message.sha, credential.token, message.traceId);
        const pendingReview = snapshot.reviews.find((item) => item.nodeId === message.reviewId);
        if (
          !Number.isSafeInteger(review.id) ||
          review.state !== reviewStates[action] ||
          (message.reviewId && review.id !== pendingReview?.id)
        )
          return uncertain(message.sha);
        await storage.remove(snapshot.attemptKey);
        return {
          kind:
            action === 'approve'
              ? 'approved'
              : action === 'changes'
                ? 'changes-requested'
                : 'commented',
          label:
            action === 'approve'
              ? 'You approved this PR'
              : action === 'changes'
                ? 'You requested changes on this PR'
                : 'You submitted your review comments',
          sha: message.sha,
        };
      } catch (error) {
        if (isDefinitiveRejection(error)) {
          await storage.remove(snapshot.attemptKey);
          return await failure(error, credential);
        }
        return uncertain(message.sha);
      }
    } catch (error) {
      return failure(error, credential);
    }
  }

  async function manageCredential(message: ExtensionMessage): Promise<ViewState> {
    if (message.op === 'status') {
      const credential = await storage.get<Credential>('credential');
      return credential
        ? {
            kind: credential.invalid ? 'invalid' : 'connected',
            login: credential.user.login,
            label: 'Token status',
          }
        : {kind: 'setup', label: 'Set up Quick Approve'};
    }
    const revision = ++credentialRevision;
    if (message.op === 'removeToken') {
      await persistCredential(revision);
      await notify();
      return {kind: 'setup', label: 'Set up Quick Approve'};
    }
    const token = (message.token ?? '').trim();
    if (!token || token.length > 512 || /\s/.test(token))
      return {kind: 'invalid', label: 'Enter a valid GitHub token'};
    try {
      const user = await api.user(token, message.traceId);
      if (!Number.isSafeInteger(user.id) || typeof user.login !== 'string' || !user.login)
        throw new Error('Invalid identity');
      if (revision !== credentialRevision) return canceled();
      if (
        !(await persistCredential(revision, {
          token,
          user: {id: user.id, login: user.login},
          generation: crypto.randomUUID(),
          invalid: false,
        }))
      )
        return canceled();
      await notify();
      return {kind: 'connected', login: user.login, label: 'Connected'};
    } catch (error) {
      return errorState(error);
    }
  }

  function persistCredential(
    revision: number,
    credential?: Credential,
    expectedGeneration?: string,
  ): Promise<boolean> {
    const operation = credentialQueue.then(async () => {
      if (revision !== credentialRevision) return false;
      if (expectedGeneration) {
        const active = await storage.get<Credential>('credential');
        if (active?.generation !== expectedGeneration || revision !== credentialRevision)
          return false;
      }
      if (credential) await storage.set('credential', credential);
      else await storage.remove('credential');
      if (revision !== credentialRevision) {
        await storage.remove('credential');
        return false;
      }
      return true;
    });
    // A failed storage operation must not prevent a later removal or replacement.
    credentialQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async function load(
    target: PrTarget,
    credential: Credential,
    pageUser?: string,
    traceId?: string,
  ) {
    emitDiagnostic(trace, 'service.phase', {traceId, phase: 'pull'}, target.key);
    const pr = await api.pull(target, credential.token, traceId);
    if (
      !Number.isSafeInteger(pr.id) ||
      !Number.isSafeInteger(pr.user?.id) ||
      typeof pr.head?.sha !== 'string'
    )
      throw new Error('Invalid PR');
    emitDiagnostic(trace, 'service.phase', {traceId, phase: 'reviews'}, target.key);
    const reviews = await api.reviews(target, credential.token, credential.user.login, traceId);
    const attemptKey = `attempt:${credential.user.id}:${pr.id}`;
    let attempt = await storage.get<Attempt>(attemptKey);
    emitDiagnostic(
      trace,
      'service.phase',
      {traceId, phase: 'attempt', hasAttempt: Boolean(attempt)},
      target.key,
    );
    const pending = attempt;
    // A submitted pending review retains its ID; a new approval receives a new ID.
    // Without commit access, a changed head requires an explicit review of the unknown result.
    if (
      pending &&
      pr.head.sha === pending.sha &&
      reviews.some(
        (review) =>
          review.user?.id === credential.user.id &&
          review.state === reviewStates[pending.action ?? 'approve'] &&
          (pending.reviewId
            ? review.nodeId === pending.reviewId
            : !pending.reviewIds.includes(review.id)),
      )
    ) {
      await storage.remove(attemptKey);
      attempt = undefined;
    }
    const snapshot = {
      pr,
      reviews,
      user: credential.user,
      attemptKey,
      pendingReviewAction: pendingReviewAction(await storage.get('pendingReviewAction')),
    };
    const state = reduceState({...snapshot, pageUser, pendingAttempt: Boolean(attempt)});
    emitDiagnostic(
      trace,
      'service.state',
      {
        traceId,
        state: state.kind,
        pageUserPresent: Boolean(pageUser),
        hasAttempt: Boolean(attempt),
      },
      target.key,
    );
    return {
      ...snapshot,
      state,
    };
  }

  async function sameCredential(credential: Credential) {
    const current = await storage.get<Credential>('credential');
    return current && !current.invalid && current.generation === credential.generation;
  }

  async function failure(error: unknown, credential?: Credential): Promise<ViewState> {
    const revision = credentialRevision;
    if (statusOf(error) === 401 && credential && (await sameCredential(credential))) {
      await persistCredential(revision, {...credential, invalid: true}, credential.generation);
    }
    return errorState(error);
  }

  return {handle};
}

function authorize(message: ExtensionMessage, sender: MessageSender, extensionId: string) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    sender.id !== extensionId
  )
    throw new Error('Unauthorized request');
  if (
    message.traceId !== undefined &&
    (typeof message.traceId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(message.traceId))
  )
    throw new Error('Invalid trace ID');
  const credentialOps = ['status', 'setToken', 'removeToken', 'getPreferences', 'setPreferences'];
  if (credentialOps.includes(message.op)) {
    if (sender.url !== `chrome-extension://${extensionId}/options.html`)
      throw new Error('Unauthorized credential request');
    const allowed =
      message.op === 'setToken'
        ? ['op', 'token', 'traceId']
        : message.op === 'setPreferences'
          ? ['op', 'action', 'traceId']
          : ['op', 'traceId'];
    if (
      Object.keys(message).some((key) => !allowed.includes(key)) ||
      (message.op === 'setToken' && typeof message.token !== 'string') ||
      (message.op === 'setPreferences' &&
        !['lock', 'changes', 'comment', 'approve'].includes(message.action ?? ''))
    )
      throw new Error('Malformed request');
    return null;
  }
  if (
    !['state', 'approve', 'recheck', 'resetAttempt', 'openSettings'].includes(message.op) ||
    sender.frameId !== 0 ||
    !Number.isInteger(sender.tab?.id) ||
    !sender.documentId
  )
    throw new Error('Unauthorized PR request');
  // Chrome retains the document's original sender.url after same-document navigation.
  const target = parsePrUrl(sender.tab?.url ?? sender.url ?? '');
  if (
    !target ||
    typeof message.pageUser !== 'string' ||
    message.pageUser.length > 39 ||
    !Number.isSafeInteger(message.generation) ||
    (message.generation ?? -1) < 0
  )
    throw new Error('Malformed PR request');
  const allowed = [
    'op',
    'pageUser',
    'generation',
    'traceId',
    ...(message.op === 'approve' ? ['sha', 'action', 'reviewId'] : []),
  ];
  if (Object.keys(message).some((key) => !allowed.includes(key)))
    throw new Error('Unexpected request field');
  if (message.op === 'approve' && !/^[a-f\d]{40,64}$/i.test(message.sha ?? ''))
    throw new Error('Invalid commit');
  if (
    message.op === 'approve' &&
    ((message.action !== undefined &&
      !['changes', 'comment', 'approve'].includes(message.action)) ||
      (message.reviewId !== undefined &&
        (typeof message.reviewId !== 'string' ||
          !/^[A-Za-z0-9_=-]{1,200}$/.test(message.reviewId))))
  )
    throw new Error('Invalid review action');
  return target;
}

function errorState(error: unknown): ViewState {
  if (statusOf(error) === 401)
    return {kind: 'invalid', label: 'GitHub token expired or invalid. Update token'};
  if (error instanceof Error && 'rateLimited' in error && error.rateLimited === true)
    return {kind: 'error', label: 'GitHub rate limit reached. Wait before retrying'};
  if (statusOf(error) === 403 || statusOf(error) === 404)
    return {
      kind: 'access',
      label: 'GitHub access denied. Check repository permissions and organization authorization',
    };
  if (statusOf(error) === 422)
    return {
      kind: 'error',
      label: "GitHub couldn't accept this review. Check for a pending review or changed PR state",
    };
  return {
    kind: 'error',
    label: "Couldn't complete the request. Check your connection and try again",
  };
}

function isDefinitiveRejection(error: unknown) {
  return [400, 401, 403, 404, 409, 410, 422, 429].includes(statusOf(error) ?? 0);
}

function canceled(): ViewState {
  return {
    kind: 'canceled',
    label: 'The page or token changed. Check the current PR before submitting',
  };
}

function uncertain(sha: string): ViewState {
  return {
    kind: 'uncertain',
    label: 'Review result unknown. Check the review history before retrying',
    sha,
  };
}

function statusOf(error: unknown): number | undefined {
  return error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined;
}
