import {timing} from './timing.js';
import type {ExtensionMessage, ViewState} from './model.js';
import {isRecord} from './diagnostics.js';

const form = requiredElement('token-form', HTMLFormElement);
const input = requiredElement('token', HTMLInputElement);
const save = requiredElement('save', HTMLButtonElement);
const remove = requiredElement('remove', HTMLButtonElement);
const status = requiredElement('connection-status', HTMLElement);
const badge = requiredElement('connection-badge', HTMLElement);
const error = requiredElement('error', HTMLElement);
const returnSection = requiredElement('return', HTMLElement);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveToken();
});
remove.addEventListener('click', () => {
  void removeToken();
});
requiredElement('return-button', HTMLButtonElement).addEventListener('click', () => window.close());
window.addEventListener('pagehide', () => {
  input.value = '';
});
void loadStatus();
const diagnosticToggle = requiredElement('diagnostics-enabled', HTMLInputElement);
const diagnosticExport = requiredElement('diagnostics-export', HTMLButtonElement);
const diagnosticClear = requiredElement('diagnostics-clear', HTMLButtonElement);
const diagnosticStatus = requiredElement('diagnostics-status', HTMLElement);
diagnosticToggle.addEventListener('change', () => {
  void manageDiagnostics('diagnosticsSetEnabled');
});
diagnosticExport.addEventListener('click', () => {
  void manageDiagnostics('diagnosticsExport');
});
diagnosticClear.addEventListener('click', () => {
  void manageDiagnostics('diagnosticsClear');
});
void manageDiagnostics('diagnosticsStatus');

async function manageDiagnostics(op: string) {
  diagnosticToggle.disabled = diagnosticExport.disabled = diagnosticClear.disabled = true;
  diagnosticStatus.textContent =
    op === 'diagnosticsExport' ? 'Collecting the report…' : 'Updating diagnostic settings…';
  try {
    const result = await diagnosticRequest({
      op,
      ...(op === 'diagnosticsSetEnabled' ? {enabled: diagnosticToggle.checked} : {}),
    });
    if (op === 'diagnosticsExport') {
      if (!isRecord(result.report)) throw new Error('Missing report');
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.report, null, 2)], {type: 'application/json'}),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `quick-approve-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), timing.reportUrlLifetimeMs);
      diagnosticStatus.textContent = 'Report downloaded. Attach the JSON file to your bug report.';
    } else {
      const status =
        op === 'diagnosticsStatus' ? result : await diagnosticRequest({op: 'diagnosticsStatus'});
      diagnosticToggle.checked = status.enabled === true;
      diagnosticStatus.textContent = `${status.count ?? 0} events in history.${status.failures || status.persisted !== true || status.available !== true ? ' Some history is not saved. Export before closing; the report includes storage health.' : ''}${op === 'diagnosticsClear' ? ' History cleared; new events may be recorded.' : ''}`;
    }
  } catch {
    diagnosticStatus.textContent =
      'Could not complete this diagnostic action. History may not have been saved. Try again or reload the extension.';
  } finally {
    diagnosticToggle.disabled = diagnosticExport.disabled = diagnosticClear.disabled = false;
  }
}

async function diagnosticRequest(
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: unknown = await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise<never>((resolve, reject) => {
        void resolve;
        timer = setTimeout(
          () => reject(new Error('Diagnostic request timed out')),
          timing.optionsRequestMs,
        );
      }),
    ]);
    if (!isRecord(result) || result.ok !== true) throw new Error('Diagnostic action failed');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function loadStatus() {
  try {
    const result = await send({op: 'status'});
    if (['connected', 'invalid', 'setup'].includes(result.kind)) renderStatus(result);
    else showError(result.label);
  } catch {
    showError('Could not load settings. Reload the extension and try again.');
  }
}

async function saveToken() {
  save.disabled = true;
  save.textContent = 'Checking token…';
  error.hidden = true;
  try {
    const result = await send({op: 'setToken', token: input.value});
    if (result.kind === 'connected') {
      input.value = '';
      renderStatus(result);
    } else {
      showError(result.label);
    }
  } catch {
    showError('Could not save the token. Check your connection and try again.');
  } finally {
    save.disabled = false;
    save.textContent = 'Save token';
  }
}

async function removeToken() {
  remove.disabled = true;
  error.hidden = true;
  try {
    const result = await send({op: 'removeToken'});
    if (result.kind === 'setup') {
      renderStatus(result);
      input.value = '';
    } else showError(result.label);
  } catch {
    showError('Could not remove the token. Try again.');
  } finally {
    remove.disabled = false;
  }
}

function renderStatus(result: ViewState) {
  const connected = result.kind === 'connected';
  status.textContent = connected
    ? `Connected as ${result.login}`
    : result.kind === 'invalid'
      ? 'GitHub token expired or invalid. Add a replacement below.'
      : 'Add a token to get started.';
  badge.textContent = connected
    ? 'Connected'
    : result.kind === 'invalid'
      ? 'Update token'
      : 'Not connected';
  badge.dataset.connected = String(connected);
  remove.hidden = !result.login;
  returnSection.hidden = !connected;
}

function showError(message: string) {
  error.textContent = message;
  error.hidden = false;
}

async function send(message: ExtensionMessage): Promise<ViewState> {
  return chrome.runtime.sendMessage({...message, traceId: crypto.randomUUID()});
}

function requiredElement<T extends HTMLElement>(id: string, type: {new (): T}): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing settings element: ${id}`);
  return element;
}
