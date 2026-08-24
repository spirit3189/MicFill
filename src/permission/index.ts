interface UserMediaControl extends HTMLElement {
  readonly stream?: MediaStream;
  readonly error?: DOMException;
  setConstraints(constraints: MediaStreamConstraints): void;
}

const control = document.querySelector<UserMediaControl>('#media-control');
const allowButton = document.querySelector<HTMLButtonElement>('#allow');
const status = document.querySelector<HTMLElement>('#status');
const supportsUserMediaControl = 'HTMLUserMediaElement' in window && Boolean(control?.setConstraints);

async function complete(stream: MediaStream): Promise<void> {
  stream.getTracks().forEach((track) => track.stop());
  await chrome.storage.local.set({ microphonePermissionReady: true });
  if (status) status.textContent = 'Microphone access is ready. You can close this tab.';
  if (allowButton) {
    allowButton.textContent = 'Microphone ready';
    allowButton.disabled = true;
  }
}

async function fallbackRequest(): Promise<void> {
  if (status) status.textContent = 'Waiting for Chrome’s microphone prompt…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    await complete(stream);
  } catch (error) {
    if (status) {
      status.textContent =
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'Access is blocked. Open chrome://settings/content/microphone, remove Smart Dictation AI from the blocked list, then retry.'
          : 'Chrome could not access a microphone on this device.';
    }
  }
}

if (supportsUserMediaControl && control) {
  control.setConstraints({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  control.addEventListener('stream', () => {
    if (control.stream) void complete(control.stream);
  });
  control.addEventListener('error', () => {
    if (status) status.textContent = `Chrome could not grant microphone access${control.error?.name ? `: ${control.error.name}` : '.'}`;
  });
  control.addEventListener('cancel', () => {
    if (status) status.textContent = 'The microphone request was dismissed. Click Allow microphone to retry.';
  });
} else {
  allowButton?.addEventListener('click', () => void fallbackRequest());
}
