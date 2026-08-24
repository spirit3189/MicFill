import { createDiagnosticError } from '../shared/errors.ts';
import {
  PROTOCOL_VERSION,
  type BeginJobMessage,
  type ExtensionMessage,
  type JobIdentity,
  type StartJobMessage,
} from '../shared/messages.ts';
import { isExtensionMessage, isJobIdentity } from '../shared/validation.ts';

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let creatingOffscreen: Promise<void> | null = null;
let activeJob: JobIdentity | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });
  if (contexts.length > 0) return;

  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture microphone audio and run local WebGPU dictation models.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function sendToJob(message: ExtensionMessage): Promise<void> {
  if (!('identity' in message) || !message.identity) return;
  const { tabId, frameId, documentId } = message.identity;
  await chrome.tabs.sendMessage(tabId, message, { frameId, documentId }).catch(() => undefined);
}

async function startJob(
  message: StartJobMessage,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionMessage> {
  if (activeJob) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.error',
      origin: message.origin,
      error: createDiagnosticError('DICTATION_BUSY', 'preparing'),
    };
  }
  if (sender.tab?.id === undefined || sender.frameId === undefined || !sender.documentId) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.error',
      origin: message.origin,
      error: createDiagnosticError('TARGET_INVALIDATED', 'preparing'),
    };
  }

  const identity: JobIdentity = Object.freeze({
    ...message.origin,
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
  });
  activeJob = identity;
  await chrome.storage.session.set({ activeJob: { identity, startedAt: Date.now() } });
  await ensureOffscreenDocument();

  const begin: BeginJobMessage = {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.begin',
    identity,
    settings: message.settings,
  };
  void chrome.runtime.sendMessage(begin).catch(async () => {
    await sendToJob({
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.error',
      identity,
      error: createDiagnosticError('INTERNAL', 'preparing'),
    });
    activeJob = null;
    await chrome.storage.session.remove('activeJob');
  });
  return { protocolVersion: PROTOCOL_VERSION, type: 'job.accepted', identity };
}

async function handleMessage(
  raw: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  if (!isExtensionMessage(raw)) return undefined;

  if (raw.type === 'models.prepare') {
    await ensureOffscreenDocument();
    const result = (await chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'models.load',
    })) as { ok?: boolean } | undefined;
    if (!result?.ok) throw new Error('Offscreen model preparation failed.');
    return { ok: true };
  }
  if (raw.type === 'models.status-request' || raw.type === 'models.clear-request') {
    if (raw.type === 'models.clear-request' && activeJob) {
      return { ok: false, error: 'Dictation is active.' };
    }
    await ensureOffscreenDocument();
    return chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: raw.type === 'models.status-request' ? 'models.inspect' : 'models.clear',
    });
  }
  if (raw.type === 'job.start') return startJob(raw, sender);
  if (raw.type === 'job.stop' || raw.type === 'job.cancel') {
    if (activeJob?.jobId !== raw.identity.jobId) return { ok: true };
    // Runtime messages are broadcast to the offscreen document directly.
    if (raw.type === 'job.cancel') {
      activeJob = null;
      await chrome.storage.session.remove('activeJob');
    }
    return { ok: true };
  }
  if (
    raw.type === 'job.progress' ||
    raw.type === 'job.audio-level' ||
    raw.type === 'job.result' ||
    raw.type === 'job.error'
  ) {
    await sendToJob(raw);
    if (raw.type === 'job.result' || raw.type === 'job.error') {
      activeJob = null;
      await chrome.storage.session.remove('activeJob');
    }
    return { ok: true };
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    !isExtensionMessage(message) ||
    ![
      'models.prepare',
      'models.status-request',
      'models.clear-request',
      'job.start',
      'job.stop',
      'job.cancel',
      'job.progress',
      'job.audio-level',
      'job.result',
      'job.error',
    ].includes(message.type)
  ) {
    return false;
  }
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      console.error('Smart Dictation AI routing error', error);
      sendResponse({ ok: false });
    });
  return true;
});

async function cancelActiveJob(): Promise<void> {
  if (!activeJob) return;
  const identity = activeJob;
  activeJob = null;
  await chrome.storage.session.remove('activeJob');
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.cancel',
    identity,
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeJob?.tabId === tabId) void cancelActiveJob();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (activeJob?.tabId === tabId && changeInfo.status === 'loading') {
    void cancelActiveJob();
  }
});

void chrome.storage.session.get('activeJob').then(({ activeJob: stored }) => {
  if (!stored || typeof stored !== 'object') return;
  const record = stored as { identity?: unknown; startedAt?: unknown };
  const age = typeof record.startedAt === 'number' ? Date.now() - record.startedAt : Infinity;
  if (isJobIdentity(record.identity) && age >= 0 && age < 5 * 60_000) {
    activeJob = record.identity;
  } else {
    void chrome.storage.session.remove('activeJob');
  }
});
