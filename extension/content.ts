declare const quickApproveBuildId: string;
declare const quickApproveTiming: typeof import('./timing.js').timing;

(() => {
  let controller = initialController();
  const root = document.createElement('span');
  const button = document.createElement('button');
  const tooltip = document.createElement('span');
  let panel: HTMLDivElement | undefined;
  let scheduled = false;
  const clientId = crypto.randomUUID();
  let stateSince = performance.now();
  let lastRenderedState = '';
  let suppressed = 0;
  let discarded = 0;
  let diagnosticFailures = 0;
  const stallWatchdog = createStallWatchdog(quickApproveTiming.uiStallMs, () => {
    if (
      root.isConnected &&
      (controller.view.kind === 'loading' || controller.phase === 'approving')
    )
      recordDiagnostic('ui.stalled', diagnosticSnapshot());
    else stallWatchdog.stop();
  });

  function start() {
    createControl();
    recordDiagnostic('ui.boot', {
      buildId: typeof quickApproveBuildId === 'string' ? quickApproveBuildId : undefined,
    });
    window.addEventListener('error', (event) => {
      if (event.filename.startsWith(chrome.runtime.getURL('')))
        recordDiagnostic('ui.exception', {
          reason: 'uncaught',
          file: event.filename.split('/').pop(),
          line: event.lineno,
          column: event.colno,
        });
    });
    window.addEventListener('unhandledrejection', () =>
      recordDiagnostic('ui.exception', {reason: 'unhandled'}),
    );
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== chrome.runtime.id) return;
      if (message.op === 'diagnosticsSnapshot') {
        respond(diagnosticSnapshot());
      } else if (message.op === 'confirmContext') {
        reconcile();
        respond({
          current:
            controller.epoch === message.generation &&
            pageUser() === message.pageUser &&
            (!message.sha || controller.view.sha === message.sha) &&
            Boolean(prRoute()),
        });
      } else if (message.op === 'refreshState' && controller.phase !== 'approving') {
        void refresh('state', true, 'notification');
      }
    });
    new MutationObserver((records) => {
      if (
        records.some((record) => !root.contains(record.target) && !panel?.contains(record.target))
      )
        schedule();
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['content', 'href', 'aria-label'],
    });
    for (const event of ['turbo:load', 'turbo:render', 'pjax:end'])
      document.addEventListener(event, () => schedule());
    window.addEventListener('popstate', () => schedule());
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      // Cached documents can retain a runtime message whose reply was lost while frozen.
      void dispatch({type: 'reset', now: performance.now()});
      stallWatchdog.stop();
      reconcile();
    });
    window.addEventListener('scroll', () => hideTooltip(), true);
    window.addEventListener('resize', () => hideTooltip());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideTooltip();
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          !event.isTrusted ||
          event.defaultPrevented ||
          event.isComposing ||
          event.repeat ||
          !event.shiftKey ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.key.toLowerCase() !== 'l' ||
          controller.view.shortcutEnabled !== true ||
          !root.isConnected ||
          !button.getClientRects().length ||
          button.getAttribute('aria-disabled') === 'true'
        )
          return;
        if (
          event
            .composedPath()
            .some(
              (target) =>
                target instanceof HTMLElement &&
                (target.isContentEditable ||
                  target.matches(
                    'input, textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"]',
                  )),
            )
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void activate();
      },
      true,
    );
    window.addEventListener('focus', () => {
      recordDiagnostic('ui.visibility', {visible: !document.hidden});
      if (controller.phase !== 'approving') void refresh('state', false, 'focus');
    });
    document.addEventListener('visibilitychange', () => {
      recordDiagnostic('ui.visibility', {visible: !document.hidden});
      if (!document.hidden && controller.phase !== 'approving')
        void refresh('state', false, 'visibility');
    });
    window.navigation?.addEventListener('navigate', () => {
      recordDiagnostic('ui.route', {reason: 'navigation', generation: controller.epoch});
      void dispatch({type: 'reset', now: performance.now()});
      schedule();
    });
    window.navigation?.addEventListener('currententrychange', () => schedule());
    reconcile();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      reconcile();
    });
  }

  function reconcile() {
    const next = prRoute();
    const context = next ? {route: next, pageUser: pageUser()} : null;
    const changed =
      context?.route !== controller.context?.route ||
      context?.pageUser !== controller.context?.pageUser;
    const status = pageState();
    const statusChanged = Boolean(status && status !== controller.pageState);
    if (statusChanged)
      recordDiagnostic('ui.prState', {pageState: status, generation: controller.epoch});
    void dispatch(
      {type: 'observe', context, pageState: status, now: performance.now()},
      statusChanged && !changed ? 'page-state' : 'route',
    );
    if (changed) {
      recordDiagnostic('ui.route', {
        reason: 'route',
        generation: controller.epoch,
        pageUserPresent: Boolean(pageUser()),
      });
    }
    if (!next) {
      root?.remove();
      return;
    }
    const anchor = findAnchor();
    if (!anchor) {
      root?.remove();
      return;
    }
    for (const duplicate of document.querySelectorAll('[data-quickapprove-root]')) {
      if (duplicate !== root) duplicate.remove();
    }
    if (anchor.nextElementSibling !== root) {
      anchor.after(root);
      const gap =
        Number.parseFloat(getComputedStyle(anchor.parentElement ?? anchor).columnGap) || 0;
      root.style.marginInlineStart = `${Math.max(0, 8 - gap)}px`;
    }
    render();
  }

  function findAnchor() {
    const buttons = [...document.querySelectorAll('button')].filter(
      (candidate) =>
        !candidate.closest('[role="dialog"], dialog, [data-quickapprove-root]') &&
        candidate.getClientRects().length,
    );
    return (
      buttons.find((candidate) => candidate.className.includes('ReviewMenuButton')) ??
      buttons.find((candidate) => /^Submit review\b/i.test(candidate.textContent.trim())) ??
      buttons.find((candidate) => /^Merge status$/i.test(candidate.textContent.trim()))
    );
  }

  function createControl() {
    root.dataset.quickapproveRoot = '';
    root.className = 'qa-root';
    button.type = 'button';
    button.className = 'qa-button';
    button.addEventListener('click', (event) => {
      if (event.isTrusted) void activate();
    });
    tooltip.id = 'quickapprove-tooltip';
    tooltip.role = 'tooltip';
    tooltip.className = 'qa-tooltip';
    tooltip.setAttribute('popover', 'manual');
    button.addEventListener('pointerenter', () => showTooltip());
    button.addEventListener('pointerleave', () => {
      if (!button.matches(':focus-visible')) hideTooltip();
    });
    button.addEventListener('focus', () => showTooltip());
    button.addEventListener('blur', () => hideTooltip());
    button.setAttribute('aria-describedby', tooltip.id);
    root.append(button, tooltip);
  }

  function refresh(op: ControllerRead = 'state', force = false, reason = 'unknown') {
    const previous = controller;
    const result = dispatch({type: 'refresh', op, force, now: performance.now()}, reason);
    if (controller === previous && controller.phase === 'reading') suppressed++;
    return result;
  }

  function activeToken(token: ControllerToken) {
    return (
      (controller.phase === 'reading' || controller.phase === 'approving') &&
      controller.operation.epoch === token.epoch &&
      controller.operation.number === token.number
    );
  }

  function dispatch(event: ControllerEvent, reason = 'unknown'): Promise<void> {
    const previous = controller;
    controller = transitionController(controller, event);
    if (controller === previous) return Promise.resolve();
    if (controller.epoch !== previous.epoch) {
      closePanel();
      hideTooltip();
    }
    render();
    if (
      (controller.phase === 'reading' || controller.phase === 'approving') &&
      (!(previous.phase === 'reading' || previous.phase === 'approving') ||
        previous.operation.number !== controller.operation.number ||
        previous.operation.epoch !== controller.operation.epoch)
    )
      return runOperation(controller, reason);
    return Promise.resolve();
  }

  async function runOperation(
    operation: Extract<ControllerState, {phase: 'reading' | 'approving'}>,
    reason: string,
  ) {
    const approval = operation.phase === 'approving';
    const op = approval ? 'approve' : operation.op;
    const token = operation.operation;
    const traceId = crypto.randomUUID();
    const name = approval ? 'ui.approval' : 'ui.refresh';
    const fields = {generation: token.epoch, request: token.number, op};
    recordDiagnostic(`${name}.begin`, {...fields, reason, spanId: traceId, traceId});
    let outcome = 'ok';
    let view: ControllerView;
    try {
      view = await send(
        {
          op,
          generation: token.epoch,
          pageUser: operation.context.pageUser,
          ...(approval
            ? {
                sha: operation.sha,
                ...(operation.action ? {action: operation.action} : {}),
                ...(operation.reviewId ? {reviewId: operation.reviewId} : {}),
              }
            : {}),
        },
        traceId,
      );
    } catch {
      outcome = 'error';
      view = approval
        ? {
            kind: 'uncertain',
            label: 'Review result unknown. Reload the page to check its review history',
            sha: operation.sha,
          }
        : {kind: 'error', label: 'Quick Approve disconnected. Reload this page to reconnect'};
    }
    // Effects return through the same guarded transition as every other event.
    // A deferred refresh is issued by that transition, after approval has finished.
    const accepted = activeToken(token);
    if (!accepted) {
      outcome = 'superseded';
      discarded++;
    }
    const completion = dispatch(
      {type: 'complete', token, view, now: performance.now()},
      'deferred',
    );
    recordDiagnostic(`${name}.end`, {
      ...fields,
      spanId: traceId,
      traceId,
      outcome,
      state: controller.view.kind,
      durationMs: performance.now() - token.started,
    });
    await completion;
    if (
      accepted &&
      approval &&
      operation.reviewId &&
      ['approved', 'changes-requested', 'commented'].includes(view.kind) &&
      controller.epoch === token.epoch &&
      prRoute() === operation.context.route &&
      pageUser() === operation.context.pageUser
    ) {
      // GitHub owns the pending-comment count and review editor state. Re-fetch them
      // after confirmed submission rather than cosmetically changing its DOM.
      location.reload();
    }
  }

  async function activate() {
    reconcile();
    if (['setup', 'invalid', 'account'].includes(controller.view.kind)) {
      await send({op: 'openSettings', generation: controller.epoch, pageUser: pageUser()});
      return;
    }
    if (['error', 'access', 'uncertain', 'changed', 'canceled'].includes(controller.view.kind)) {
      showPanel();
      return;
    }
    const epoch = controller.epoch;
    await dispatch({type: 'approve', now: performance.now()}, 'activation');
    if (
      epoch === controller.epoch &&
      ['error', 'access', 'uncertain', 'changed', 'canceled'].includes(controller.view.kind)
    )
      showPanel();
  }

  function render() {
    if (!button) return;
    const kind = controller.phase === 'approving' ? 'busy' : controller.view.kind;
    if (kind !== lastRenderedState) {
      lastRenderedState = kind;
      stateSince = performance.now();
      stallWatchdog.stop();
      recordDiagnostic('ui.control', {
        state: kind,
        generation: controller.epoch,
        mounted: root.isConnected,
      });
    }
    if ((kind === 'loading' || kind === 'busy') && root.isConnected && !stallWatchdog.active) {
      stateSince = performance.now();
      stallWatchdog.start();
    }
    const label =
      controller.phase === 'approving'
        ? controller.reviewId
          ? 'Submitting review…'
          : 'Approving…'
        : controller.view.label;
    const disabled = [
      'loading',
      'busy',
      'approved',
      'changes-requested',
      'commented',
      'merged',
      'closed',
      'own',
      'pending',
      'account',
    ].includes(kind);
    button.dataset.state = kind;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-disabled', String(disabled));
    if (controller.view.shortcutEnabled === true && !disabled)
      button.setAttribute('aria-keyshortcuts', 'Shift+L');
    else button.removeAttribute('aria-keyshortcuts');
    button.setAttribute('aria-busy', String(['loading', 'busy'].includes(kind)));
    const iconName =
      kind === 'available' && controller.view.reviewId
        ? controller.view.action === 'approve'
          ? 'approve-review'
          : (controller.view.action ?? 'available')
        : ['setup', 'invalid'].includes(kind)
          ? 'key'
          : ['loading', 'busy'].includes(kind)
            ? 'spinner'
            : ['own', 'pending', 'account', 'access'].includes(kind)
              ? 'lock'
              : ['error', 'uncertain', 'changed', 'canceled'].includes(kind)
                ? 'alert'
                : kind;
    if (button.dataset.icon !== iconName) {
      button.dataset.icon = iconName;
      button.replaceChildren(makeIcon(iconName));
    }
    const tooltipLabel =
      controller.view.shortcutEnabled === true && !disabled ? `${label} (Shift+L)` : label;
    if (tooltip.textContent !== tooltipLabel) tooltip.textContent = tooltipLabel;
    if (tooltip.matches(':popover-open')) positionTooltip();
  }

  function showTooltip() {
    if (!root.isConnected || panel?.isConnected) return;
    if (!tooltip.matches(':popover-open')) tooltip.showPopover();
    positionTooltip();
  }

  function positionTooltip() {
    const anchor = button.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
    tooltip.style.top = `${anchor.bottom + bounds.height + 16 <= innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - bounds.height - 8)}px`;
  }

  function hideTooltip() {
    if (tooltip.matches(':popover-open')) tooltip.hidePopover();
  }

  function makeIcon(name: string) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    if (['approved', 'changes-requested', 'commented'].includes(name)) {
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('fill-rule', 'evenodd');
      svg.setAttribute('stroke', 'none');
    }
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const paths: Record<string, string[]> = {
      available: ['M3 8l3 3 7-7'],
      approved: [
        'M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm3.78-9.72a.751.751 0 0 0-.018-1.042.751.751 0 0 0-1.042-.018L6.75 9.19 5.28 7.72a.751.751 0 0 0-1.042.018.751.751 0 0 0-.018 1.042l2 2a.75.75 0 0 0 1.06 0Z',
      ],
      merged: [
        'M4 4.5v7',
        'M5.5 5.5C6 8 8 9 11 9',
        'M5.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
        'M5.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
        'M14 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
      ],
      closed: [
        'M4 4.5v7',
        'M5.5 3a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
        'M5.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
        'M10 5l4 6m0-6-4 6',
      ],
      lock: ['M4 7V5a4 4 0 0 1 8 0v2', 'M3 7h10v7H3z'],
      changes: ['M4 5h8', 'M8 2v6', 'M4 12h8'],
      'changes-requested': ['M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16ZM4 7.25h8v1.5H4z'],
      comment: ['M2 2h12v9H7l-4 3v-3H2z'],
      commented: ['M2 2h12v9H7l-4 3v-3H2z'],
      'approve-review': ['M3 8l3 3 7-7'],
      key: ['M8.5 5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0', 'M8 7.5l6.5 6.5m-2-2 2-2m-4 0 2-2'],
      spinner: ['M14 8a6 6 0 1 1-4-5.66'],
      alert: ['M8 1.5 15 14H1z', 'M8 6v3.5', 'M8 12v.1'],
    };
    for (const d of paths[name] ?? paths.lock) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function showPanel() {
    hideTooltip();
    closePanel();
    panel = document.createElement('div');
    panel.className = 'qa-panel';
    panel.setAttribute('popover', 'manual');
    panel.role = 'alert';
    const activePanel = panel;
    const panelGeneration = controller.epoch;
    const text = document.createElement('p');
    text.textContent = controller.view.label;
    panel.append(text);
    if (controller.view.kind === 'uncertain') {
      const warning = document.createElement('p');
      warning.textContent =
        'Allowing another attempt may create a duplicate review. Check GitHub first.';
      panel.append(warning);
      const history = document.createElement('a');
      history.href = `https://github.com${prRoute()}`;
      history.target = '_blank';
      history.rel = 'noopener noreferrer';
      history.textContent = 'Open review history';
      panel.append(history);
      panelAction('Recheck', async () => {
        await refresh('recheck');
        if (panel === activePanel && controller.epoch === panelGeneration) showPanel();
      });
      panelAction('Allow another attempt', async () => {
        await refresh('resetAttempt');
        if (panel === activePanel && controller.epoch === panelGeneration) closePanel();
      });
    } else {
      panelAction('Retry', async () => {
        closePanel();
        await refresh();
      });
      panelAction('Settings', async () => {
        await send({op: 'openSettings', generation: controller.epoch, pageUser: pageUser()});
      });
    }
    panelAction('Dismiss', async () => closePanel());
    document.body.append(panel);
    const rect = button.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.right - 320, innerWidth - 328))}px`;
    panel.style.top = `${Math.min(rect.bottom + 8, innerHeight - 220)}px`;
    panel.showPopover();
  }

  function panelAction(label: string, action: () => Promise<void>) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    control.addEventListener('click', (event) => {
      if (event.isTrusted) void action();
    });
    panel?.append(control);
  }

  function closePanel() {
    panel?.remove();
    panel = undefined;
  }

  function pageUser() {
    return document.querySelector<HTMLMetaElement>('meta[name="user-login"]')?.content ?? '';
  }

  function pageState() {
    // The badge invalidates API-derived state; it does not establish approval eligibility.
    const badges = document.querySelectorAll(
      '[class^="prc-StateLabel-StateLabel"], [aria-label^="Pull request state:"]',
    );
    for (const badge of badges) {
      if (!badge.getClientRects().length) continue;
      const label = (badge.getAttribute('aria-label') ?? badge.textContent)
        .replace(/^Pull request state:\s*/i, '')
        .trim()
        .toLowerCase();
      if (['open', 'draft', 'closed', 'merged'].includes(label)) return label;
    }
    return '';
  }

  function prRoute() {
    const match = location.pathname.match(/^\/[a-z\d-]+\/[a-z\d_.-]+\/pull\/[1-9]\d*(?=\/|$)/i);
    return match?.[0] ?? '';
  }

  function diagnosticSnapshot() {
    return {
      clientId,
      buildId: typeof quickApproveBuildId === 'string' ? quickApproveBuildId : undefined,
      state: controller.phase === 'approving' ? 'busy' : controller.view.kind,
      pageState: controller.pageState || 'unknown',
      generation: controller.epoch,
      request: controller.sequence,
      pendingRefresh: controller.phase === 'reading',
      submitting: controller.phase === 'approving',
      durationMs: performance.now() - stateSince,
      waitMs: controller.phase === 'reading' ? performance.now() - controller.operation.started : 0,
      suppressed,
      discarded,
      diagnosticFailures,
      deferredRefresh: controller.phase === 'approving' && controller.deferredRefresh,
      watchdogActive: stallWatchdog.active,
      visible: !document.hidden,
      online: navigator.onLine,
      mounted: root.isConnected,
      anchorFound: Boolean(findAnchor()),
      count: document.querySelectorAll('[data-quickapprove-root]').length,
      pageUserPresent: Boolean(pageUser()),
    };
  }

  function recordDiagnostic(name: string, fields: Record<string, unknown> = {}) {
    try {
      void chrome.runtime
        .sendMessage({op: 'diagnosticsEvent', name, fields: {clientId, ...fields}})
        .then(
          (result) => {
            if (result?.ok !== true) diagnosticFailures++;
          },
          () => {
            diagnosticFailures++;
          },
        );
    } catch {
      diagnosticFailures++;
      /* A disconnected content script cannot record to its former worker. */
    }
  }

  async function send(message: Record<string, unknown>, traceId = crypto.randomUUID()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage({...message, traceId}),
        new Promise<never>((resolve, reject) => {
          void resolve;
          timer = setTimeout(
            () => reject(new Error('Quick Approve request timed out')),
            quickApproveTiming.messageRequestMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  start();
})();
