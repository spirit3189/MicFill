import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PROTOCOL_VERSION } from '../../src/shared/messages.ts';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.ts';

describe('background job lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('cancels and clears a job when its source tab navigates', async () => {
    let messageListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | undefined;
    let tabUpdatedListener: Parameters<typeof chrome.tabs.onUpdated.addListener>[0] | undefined;
    const sessionSet = vi.fn(async () => undefined);
    const sessionRemove = vi.fn(async () => undefined);
    const runtimeSend = vi.fn(async () => ({ ok: true }));

    vi.stubGlobal('chrome', {
      runtime: {
        ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
        getURL: (path: string) => `chrome-extension://test/${path}`,
        getContexts: vi.fn(async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }]),
        sendMessage: runtimeSend,
        onMessage: { addListener: (listener: typeof messageListener) => (messageListener = listener) },
      },
      offscreen: {
        Reason: { USER_MEDIA: 'USER_MEDIA' },
        createDocument: vi.fn(async () => undefined),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({})),
          set: sessionSet,
          remove: sessionRemove,
        },
      },
      tabs: {
        sendMessage: vi.fn(async () => undefined),
        onRemoved: { addListener: vi.fn() },
        onUpdated: {
          addListener: (listener: typeof tabUpdatedListener) => (tabUpdatedListener = listener),
        },
      },
    });

    await import('../../src/background/index.ts');
    expect(messageListener).toBeTypeOf('function');
    expect(tabUpdatedListener).toBeTypeOf('function');

    const response = await new Promise<unknown>((resolve) => {
      messageListener?.(
        {
          protocolVersion: PROTOCOL_VERSION,
          type: 'job.start',
          origin: { jobId: 'job-1', documentId: 'document-1', fieldId: 'field-1' },
          settings: { ...DEFAULT_SETTINGS },
        },
        { tab: { id: 42 } as chrome.tabs.Tab, frameId: 0, documentId: 'document-1' },
        resolve,
      );
    });

    expect(response).toMatchObject({ type: 'job.accepted' });
    expect(sessionSet).toHaveBeenCalledWith({
      activeJob: {
        identity: expect.objectContaining({ jobId: 'job-1', tabId: 42 }),
        startedAt: expect.any(Number),
      },
    });

    tabUpdatedListener?.(42, { status: 'loading' }, { id: 42 } as chrome.tabs.Tab);
    await vi.waitFor(() => expect(sessionRemove).toHaveBeenCalledWith('activeJob'));
    await vi.waitFor(() =>
      expect(runtimeSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'job.cancel',
          identity: expect.objectContaining({ jobId: 'job-1' }),
        }),
      ),
    );
  });
});
