import type {ExtensionMessage, ViewState} from './model.js';

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
  return chrome.runtime.sendMessage(message);
}

function requiredElement<T extends HTMLElement>(id: string, type: {new (): T}): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`Missing settings element: ${id}`);
  return element;
}
