import contentScriptFile from '../content/index.ts?script&iife';
import { PROTOCOL_VERSION, type ModelCacheStatus } from '../shared/messages.ts';
import { DEFAULT_SETTINGS, migrateSettings } from '../shared/settings.ts';
import { isExtensionMessage } from '../shared/validation.ts';

const enableButton = document.querySelector<HTMLButtonElement>('#enable');
const status = document.querySelector<HTMLElement>('#status');
const mode = document.querySelector<HTMLSelectElement>('#mode');
const styling = document.querySelector<HTMLSelectElement>('#styling');
const microphoneButton = document.querySelector<HTMLButtonElement>('#microphone');
const modelList = document.querySelector<HTMLElement>('#model-list');
const clearCacheButton = document.querySelector<HTMLButtonElement>('#clear-cache');

let activeTab: chrome.tabs.Tab | undefined;
let originPattern: string | undefined;
let modelPreparationFailed = false;
let microphoneReady = false;
let cachedModelStatus: ModelCacheStatus[] = [];
const activeDownloads = new Map<
  ModelCacheStatus['model'],
  { percent?: number; loaded?: number; total?: number }
>();
let observedTotals: Partial<Record<ModelCacheStatus['model'], number>> = {};

function renderMicrophoneState(state: PermissionState | 'unknown'): void {
  microphoneReady = state === 'granted';
  if (!microphoneButton) return;
  microphoneButton.disabled = microphoneReady;
  microphoneButton.textContent = microphoneReady
    ? 'Microphone ready'
    : state === 'denied'
      ? 'Microphone blocked — retry'
      : 'Allow microphone';
}

async function refreshMicrophonePermission(): Promise<void> {
  const stored = await chrome.storage.local.get('microphonePermissionReady');
  try {
    const permission = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    renderMicrophoneState(
      permission.state === 'granted' ||
        (permission.state === 'prompt' && stored.microphonePermissionReady === true)
        ? 'granted'
        : permission.state,
    );
    permission.addEventListener('change', () => renderMicrophoneState(permission.state));
  } catch {
    renderMicrophoneState(stored.microphonePermissionReady === true ? 'granted' : 'unknown');
  }
}

async function openMicrophoneOnboarding(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL('src/permission/permission.html') });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'size unavailable';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** power;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[power]}`;
}

function renderModelStatus(models: ModelCacheStatus[]): void {
  if (!modelList) return;
  cachedModelStatus = models;
  modelList.replaceChildren(
    ...models.map((model) => {
      const row = document.createElement('div');
      row.className = 'model';
      const name = document.createElement('span');
      name.textContent = model.model === 'speech recognition' ? 'Moonshine' : 'S1-mini';
      const state = document.createElement('span');
      const live = activeDownloads.get(model.model);
      const totalBytes = observedTotals[model.model] ?? model.totalBytes;
      if (live && live.percent !== undefined && !model.cached) {
        state.textContent =
          live.percent >= 100
            ? `Finalizing cache · ${formatBytes(live.total ?? totalBytes)}`
            : live.loaded !== undefined && live.total !== undefined
              ? `${formatBytes(live.loaded)} / ${formatBytes(live.total)} · ${Math.round(live.percent)}%`
              : `${Math.round(live.percent)}%`;
      } else if (model.cached) {
        state.textContent = `Cached · ${formatBytes(totalBytes)}`;
      } else if (model.cachedFiles > 1) {
        state.textContent = `Partially cached · ${formatBytes(totalBytes)} total`;
      } else {
        state.textContent = `Not downloaded · ${formatBytes(totalBytes)}`;
      }
      row.append(name, state);
      return row;
    }),
  );
  if (clearCacheButton) clearCacheButton.disabled = !models.some((model) => model.cachedFiles > 0);
}

async function refreshModelStatus(): Promise<void> {
  if (modelList) modelList.textContent = 'Checking cache…';
  const response = (await chrome.runtime.sendMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: 'models.status-request',
  })) as { ok?: boolean; models?: ModelCacheStatus[] } | undefined;
  if (response?.ok && response.models) {
    for (const model of response.models) {
      if (model.cached) activeDownloads.delete(model.model);
    }
    renderModelStatus(response.models);
  }
  else if (modelList) modelList.textContent = 'Cache status unavailable';
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (!status || !isExtensionMessage(raw)) return false;
  if (raw.type === 'models.progress') {
    activeDownloads.set(raw.model, {
      ...(raw.percent === undefined ? {} : { percent: raw.percent }),
      ...(raw.loaded === undefined ? {} : { loaded: raw.loaded }),
      ...(raw.total === undefined ? {} : { total: raw.total }),
    });
    if (raw.total !== undefined && raw.total > 0) {
      observedTotals[raw.model] = raw.total;
      if ((raw.percent ?? 0) >= 99.99) {
        void chrome.storage.local.set({ modelDownloadTotals: observedTotals });
      }
    }
    const percentage = raw.percent === undefined ? '' : ` · ${Math.round(raw.percent)}%`;
    const bytes =
      raw.loaded === undefined || raw.total === undefined
        ? ''
        : ` · ${formatBytes(raw.loaded)} / ${formatBytes(raw.total)}`;
    status.textContent = `Downloading ${raw.model}${percentage}${bytes}…`;
    renderModelStatus(cachedModelStatus);
  }
  if (raw.type === 'models.ready') {
    status.textContent = 'Models ready. Focus a text field and click its microphone.';
    void refreshModelStatus();
  }
  if (raw.type === 'models.error') {
    modelPreparationFailed = true;
    status.textContent = raw.detail
      ? `${raw.error.userMessage} ${raw.detail}`
      : raw.error.userMessage;
  }
  return false;
});

async function load(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.url) {
    const url = new URL(activeTab.url);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      originPattern = `${url.protocol}//${url.host}/*`;
    }
  }
  const stored = await chrome.storage.local.get('settings');
  const storedTotals = await chrome.storage.local.get('modelDownloadTotals');
  if (storedTotals.modelDownloadTotals && typeof storedTotals.modelDownloadTotals === 'object') {
    observedTotals = storedTotals.modelDownloadTotals as Partial<
      Record<ModelCacheStatus['model'], number>
    >;
  }
  const parsed = migrateSettings(stored.settings);
  const settings = parsed.ok ? parsed.value : { ...DEFAULT_SETTINGS };
  if (mode) mode.value = settings.mode;
  if (styling) styling.value = settings.styling;
  if (!originPattern && enableButton) enableButton.disabled = true;
  await refreshMicrophonePermission();
  await refreshModelStatus();
}

async function saveSettings(): Promise<void> {
  const parsed = migrateSettings({
    ...DEFAULT_SETTINGS,
    mode: mode?.value,
    styling: styling?.value,
  });
  if (parsed.ok) await chrome.storage.local.set({ settings: parsed.value });
}

async function enableCurrentSite(): Promise<void> {
  if (!activeTab?.id || !originPattern || !status) return;
  if (!microphoneReady) {
    status.textContent = 'Complete microphone setup in the tab that just opened, then return here.';
    await openMicrophoneOnboarding();
    return;
  }
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    status.textContent = 'Site access was not granted.';
    return;
  }
  await saveSettings();

  const id = 'smart-dictation-approved-sites';
  const [registered] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  const matches = [...new Set([...(registered?.matches ?? []), originPattern])];
  const definition: chrome.scripting.RegisteredContentScript = {
    id,
    js: [contentScriptFile],
    matches,
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
    runAt: 'document_idle',
  };
  if (registered) await chrome.scripting.updateContentScripts([definition]);
  else await chrome.scripting.registerContentScripts([definition]);

  await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    files: [contentScriptFile],
  });
  const ping = (await chrome.tabs.sendMessage(activeTab.id, {
    type: 'smart-dictation.ping',
  })) as { ready?: boolean } | undefined;
  if (!ping?.ready) throw new Error('Content script did not initialize.');
  status.textContent = 'Preparing local models…';
  modelPreparationFailed = false;
  const preparation = (await chrome.runtime.sendMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: 'models.prepare',
  })) as { ok?: boolean } | undefined;
  if (!preparation?.ok) throw new Error('Model preparation failed.');
  status.textContent = 'Models ready. Focus a text field and click its microphone.';
}

enableButton?.addEventListener('click', () => {
  enableCurrentSite().catch(() => {
    if (status && !modelPreparationFailed) {
      status.textContent = 'Setup failed. Reload this page and try again.';
    }
  });
});
microphoneButton?.addEventListener('click', () => {
  void openMicrophoneOnboarding();
});
mode?.addEventListener('change', () => void saveSettings());
styling?.addEventListener('change', () => void saveSettings());
clearCacheButton?.addEventListener('click', () => {
  if (!window.confirm('Clear downloaded Moonshine and S1-mini model files?')) return;
  clearCacheButton.disabled = true;
  if (modelList) modelList.textContent = 'Clearing cache…';
  chrome.runtime
    .sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'models.clear-request' })
    .then((response: { ok?: boolean; error?: string } | undefined) => {
      if (!response?.ok) throw new Error(response?.error ?? 'Cache clear failed.');
      activeDownloads.clear();
      observedTotals = {};
      void chrome.storage.local.remove('modelDownloadTotals');
      return refreshModelStatus();
    })
    .catch(() => {
      if (modelList) modelList.textContent = 'Could not clear model cache';
    });
});
void load();
