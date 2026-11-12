declare const quickApproveBuildId: string;
declare const quickApproveTiming: typeof import('./timing.js').timing;

(() => {
  let route = '';
  let observedPageState = '';
  let refreshAfterSubmission = false;
  let generation = 0;
  let requestNumber = 0;
  let pendingRefresh: {generation: number; request: number; started: number} | undefined;
  const root = document.createElement('span');
  const button = document.createElement('button');
  const tooltip = document.createElement('span');
  let panel: HTMLDivElement | undefined;
  interface ContentState {
    kind: string;
    label: string;
    sha?: string;
  }
  let current: ContentState = {kind: 'loading', label: 'Checking approval…'};
  let submitting = false;
  let scheduled = false;
  const clientId = crypto.randomUUID();
  let stateSince = performance.now();
  let lastRenderedState = '';
  let suppressed = 0;
  let discarded = 0;
  let diagnosticFailures = 0;
  const stallWatchdog = createStallWatchdog(quickApproveTiming.uiStallMs, () => {
    if (root.isConnected && (current?.kind === 'loading' || submitting))
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
            generation === message.generation &&
            pageUser() === message.pageUser &&
            (!message.sha || current.sha === message.sha) &&
            Boolean(prRoute()),
        });
      } else if (message.op === 'refreshState' && !submitting) {
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
    window.addEventListener('scroll', () => hideTooltip(), true);
    window.addEventListener('resize', () => hideTooltip());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideTooltip();
    });
    window.addEventListener('focus', () => {
      recordDiagnostic('ui.visibility', {visible: !document.hidden});
      if (!submitting) void refresh('state', false, 'focus');
    });
    document.addEventListener('visibilitychange', () => {
      recordDiagnostic('ui.visibility', {visible: !document.hidden});
      if (!document.hidden && !submitting) void refresh('state', false, 'visibility');
    });
    window.navigation?.addEventListener('navigate', () => {
      recordDiagnostic('ui.route', {reason: 'navigation', generation});
      submitting = false;
      route = '';
      generation++;
      requestNumber++;
      current = {kind: 'loading', label: 'Checking approval…'};
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
    const identity = `${next}|${pageUser()}`;
    const changed = identity !== route;
    const status = pageState();
    const statusChanged = Boolean(status && status !== observedPageState);
    if (statusChanged) recordDiagnostic('ui.prState', {pageState: status, generation});
    if (status) observedPageState = status;
    if (changed) {
      route = identity;
      observedPageState = status;
      refreshAfterSubmission = false;
      generation++;
      requestNumber++;
      submitting = false;
      current = {kind: 'loading', label: 'Checking approval…'};
      recordDiagnostic('ui.route', {
        reason: 'route',
        generation,
        pageUserPresent: Boolean(pageUser()),
      });
      closePanel();
      hideTooltip();
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
    if (statusChanged && submitting) refreshAfterSubmission = true;
    render();
    if (changed || statusChanged || current.kind === 'loading')
      void refresh(
        'state',
        statusChanged,
        statusChanged ? 'page-state' : changed ? 'route' : 'initial',
      );
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

  async function refresh(op = 'state', force = false, reason = 'unknown') {
    if (!prRoute() || (submitting && op === 'state')) return;
    // Page mutations must not supersede every slow response and starve the ready state.
    if (!force && op === 'state' && pendingRefresh?.generation === generation) {
      suppressed++;
      return;
    }
    const request = ++requestNumber;
    const capturedGeneration = generation;
    const traceId = crypto.randomUUID();
    const started = performance.now();
    let outcome = 'ok';
    pendingRefresh = {generation, request, started};
    recordDiagnostic('ui.refresh.begin', {
      spanId: traceId,
      traceId,
      op,
      reason,
      generation,
      request,
    });
    try {
      const result = await send({op, generation, pageUser: pageUser()}, traceId);
      if (capturedGeneration !== generation || request !== requestNumber) {
        outcome = 'superseded';
        discarded++;
        return;
      }
      current = result;
    } catch {
      outcome = 'error';
      if (capturedGeneration !== generation || request !== requestNumber) {
        outcome = 'superseded';
        discarded++;
        return;
      }
      current = {kind: 'error', label: 'Quick Approve disconnected. Reload this page to reconnect'};
    } finally {
      if (pendingRefresh?.request === request) pendingRefresh = undefined;
      recordDiagnostic('ui.refresh.end', {
        spanId: traceId,
        traceId,
        op,
        generation,
        request,
        outcome,
        state: current?.kind,
        durationMs: performance.now() - started,
      });
    }
    render();
  }

  async function activate() {
    reconcile();
    if (['setup', 'invalid', 'account'].includes(current.kind)) {
      await send({op: 'openSettings', generation, pageUser: pageUser()});
      return;
    }
    if (['error', 'access', 'uncertain', 'changed', 'canceled'].includes(current.kind)) {
      showPanel();
      return;
    }
    if (current.kind !== 'available' || submitting) return;
    submitting = true;
    const approvalTrace = crypto.randomUUID();
    const approvalStart = performance.now();
    recordDiagnostic('ui.approval.begin', {
      spanId: approvalTrace,
      traceId: approvalTrace,
      generation,
    });
    const capturedGeneration = generation;
    const sha = current.sha;
    render();
    try {
      const result = await send(
        {
          op: 'approve',
          generation,
          pageUser: pageUser(),
          sha,
        },
        approvalTrace,
      );
      if (capturedGeneration !== generation) return;
      current = result;
    } catch {
      current = {
        kind: 'uncertain',
        label: 'Approval result unknown. Reload the page to check its review history',
        sha,
      };
    } finally {
      recordDiagnostic('ui.approval.end', {
        spanId: approvalTrace,
        traceId: approvalTrace,
        generation,
        state: current?.kind,
        durationMs: performance.now() - approvalStart,
      });
      if (capturedGeneration === generation) {
        submitting = false;
        render();
        if (refreshAfterSubmission) {
          refreshAfterSubmission = false;
          void refresh('state', true);
        }
      }
    }
    if (['error', 'access', 'uncertain', 'changed', 'canceled'].includes(current.kind)) showPanel();
  }

  function render() {
    if (!button) return;
    const kind = submitting ? 'busy' : current.kind;
    if (kind !== lastRenderedState) {
      lastRenderedState = kind;
      stateSince = performance.now();
      stallWatchdog.stop();
      recordDiagnostic('ui.control', {state: kind, generation, mounted: root.isConnected});
    }
    if ((kind === 'loading' || kind === 'busy') && root.isConnected && !stallWatchdog.active) {
      stateSince = performance.now();
      stallWatchdog.start();
    }
    const label = submitting ? 'Approving…' : current.label;
    const disabled = [
      'loading',
      'busy',
      'approved',
      'merged',
      'closed',
      'own',
      'pending',
      'account',
    ].includes(kind);
    button.dataset.state = kind;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-disabled', String(disabled));
    button.setAttribute('aria-busy', String(['loading', 'busy'].includes(kind)));
    const iconName = ['setup', 'invalid'].includes(kind)
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
    if (tooltip.textContent !== label) tooltip.textContent = label;
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
    if (name === 'available' || name === 'approved') {
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('stroke', 'none');
    }
    svg.setAttribute('stroke-width', '1.6');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const paths: Record<string, string[]> = {
      available: [
        'M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-8.5C0 1.784.784 1 1.75 1ZM1.5 2.75v8.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Zm5.28 1.72a.75.75 0 0 1 0 1.06L5.31 7l1.47 1.47a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-2-2a.75.75 0 0 1 0-1.06l2-2a.75.75 0 0 1 1.06 0Zm2.44 0a.75.75 0 0 1 1.06 0l2 2a.75.75 0 0 1 0 1.06l-2 2a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L10.69 7 9.22 5.53a.75.75 0 0 1 0-1.06Z',
      ],
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
    const text = document.createElement('p');
    text.textContent = current.label;
    panel.append(text);
    if (current.kind === 'uncertain') {
      const warning = document.createElement('p');
      warning.textContent =
        'Allowing another attempt may create a duplicate approval. Check GitHub first.';
      panel.append(warning);
      const history = document.createElement('a');
      history.href = `https://github.com${prRoute()}`;
      history.target = '_blank';
      history.rel = 'noopener noreferrer';
      history.textContent = 'Open review history';
      panel.append(history);
      panelAction('Recheck', async () => {
        await refresh('recheck');
        showPanel();
      });
      panelAction('Allow another attempt', async () => {
        await refresh('resetAttempt');
        closePanel();
      });
    } else {
      panelAction('Retry', async () => {
        closePanel();
        await refresh();
      });
      panelAction('Settings', async () => {
        await send({op: 'openSettings', generation, pageUser: pageUser()});
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
      state: submitting ? 'busy' : current?.kind,
      pageState: observedPageState || 'unknown',
      generation,
      request: requestNumber,
      pendingRefresh: Boolean(pendingRefresh),
      submitting,
      durationMs: performance.now() - stateSince,
      waitMs: pendingRefresh ? performance.now() - pendingRefresh.started : 0,
      suppressed,
      discarded,
      diagnosticFailures,
      deferredRefresh: refreshAfterSubmission,
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

  function send(message: Record<string, unknown>, traceId = crypto.randomUUID()) {
    return chrome.runtime.sendMessage({...message, traceId});
  }

  start();
})();
