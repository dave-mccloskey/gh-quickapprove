import {createApi} from './api.js';
import {createService} from './service.js';
import {parsePrUrl} from './shared.js';

const ready = restrictStorage();
const service = createService({
  extensionId: chrome.runtime.id,
  api: createApi(),
  storage: {
    get: async <T>(key: string): Promise<T | undefined> => {
      const values: Record<string, T> = await chrome.storage.local.get(key);
      return values[key];
    },
    set: async (key, value) => chrome.storage.local.set({[key]: value}),
    remove: async (key) => chrome.storage.local.remove(key),
  },
  verifyContext: async (sender, message) => {
    try {
      if (sender.tab?.id === undefined || !sender.documentId) return false;
      const tab = await chrome.tabs.get(sender.tab.id);
      const current = parsePrUrl(tab.url ?? '');
      const original = parsePrUrl(sender.url ?? '');
      if (!current || current.key !== original?.key) return false;
      const acknowledgment = await chrome.tabs.sendMessage(
        sender.tab?.id,
        {
          op: 'confirmContext',
          generation: message.generation,
          pageUser: message.pageUser,
          sha: message.sha,
        },
        {documentId: sender.documentId},
      );
      return acknowledgment?.current === true;
    } catch {
      // Closed tabs and disconnected documents cannot authorize a write.
      return false;
    }
  },
  notify: async () => {
    const tabs = await chrome.tabs.query({url: 'https://github.com/*'});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          await chrome.tabs.sendMessage(tab.id, {op: 'refreshState'}, {frameId: 0});
        } catch {
          /* A tab may close or navigate between query and notification. */
        }
      }),
    );
  },
  openSettings: async () => chrome.runtime.openOptionsPage(),
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  ready
    .then(() => service.handle(message, sender))
    .then(
      (result) => respond(result),
      () =>
        respond({
          kind: 'error',
          label: 'Quick Approve could not process this request. Reload the extension and try again',
        }),
    );
  return true;
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

async function restrictStorage() {
  if (typeof chrome.storage.local.setAccessLevel !== 'function')
    throw new Error('Trusted storage is unavailable');
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
}
