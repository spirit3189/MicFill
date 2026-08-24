import { PROTOCOL_VERSION, type JobIdentity, type PageJobKey } from '../shared/messages.ts';
import { DEFAULT_SETTINGS, migrateSettings } from '../shared/settings.ts';
import { isExtensionMessage } from '../shared/validation.ts';

type Editor = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
type RecorderPhase =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'resampling'
  | 'transcribing'
  | 'rewriting'
  | 'done'
  | 'error';

interface Snapshot {
  editor: Editor;
  value: string;
  originalValue: string;
  originalStart: number | null;
  originalEnd: number | null;
  start: number | null;
  end: number | null;
  range: Range | null;
}

const marker = globalThis as typeof globalThis & { __smartDictationAiLoaded?: boolean };
if (!marker.__smartDictationAiLoaded) {
  marker.__smartDictationAiLoaded = true;
  initialize();
}

function initialize(): void {
  const EDITOR_SELECTOR =
    'textarea, input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], [contenteditable="true"]';
  const documentId = crypto.randomUUID();
  const fieldIds = new WeakMap<Editor, string>();
  const fieldButtons = new Map<Editor, { host: HTMLDivElement; button: HTMLButtonElement }>();
  let focused: Editor | null = null;
  let snapshot: Snapshot | null = null;
  let fieldCleared = false;
  let origin: PageJobKey | null = null;
  let identity: JobIdentity | null = null;
  let starting = false;
  let phase: RecorderPhase = 'idle';
  let recordingStartedAt = 0;
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let animationFrame = 0;
  let liveLevel = 0;
  let levels = Array.from({ length: 42 }, () => 0.08);

  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.zIndex = '2147483647';
  host.style.display = 'none';
  host.style.width = '36px';
  host.style.height = '36px';
  document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host{all:initial;color-scheme:dark}
      *{box-sizing:border-box}
      button{font:inherit}
      #launcher{width:36px;height:36px;padding:0;border:1px solid #ffffff38;border-radius:11px;background:#171719;color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 5px 18px #0005;transition:transform .15s ease,background .15s ease}
      #launcher:hover{transform:translateY(-1px);background:#242427}
      #launcher[data-active="true"]{background:#d83a3a;border-color:#ff9a9a}
      #launcher svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
      #panel{position:absolute;right:0;top:44px;width:min(326px,calc(100vw - 24px));padding:14px;border:1px solid #ffffff24;border-radius:16px;background:linear-gradient(180deg,#202023,#151517);color:#f7f7f5;box-shadow:0 18px 50px #0008;font:13px/1.35 system-ui,-apple-system,sans-serif;opacity:0;pointer-events:none;transform:translateY(-5px) scale(.98);transform-origin:top right;transition:opacity .16s ease,transform .16s ease}
      #panel[data-open="true"]{opacity:1;pointer-events:auto;transform:none}
      #panel[data-above="true"]{top:auto;bottom:44px;transform-origin:bottom right}
      .header{display:flex;align-items:center;gap:9px}
      .dot{width:8px;height:8px;border-radius:50%;background:#6f747c;box-shadow:0 0 0 4px #ffffff0b}
      #panel[data-phase="recording"] .dot{background:#ff5555;animation:pulse 1.4s ease-in-out infinite}
      #panel[data-phase="done"] .dot{background:#62d78b}
      #panel[data-phase="error"] .dot{background:#ffb14a}
      #title{font-weight:650;letter-spacing:.01em}
      #timer{margin-left:auto;color:#c6c7ca;font-variant-numeric:tabular-nums;font-size:12px}
      .wave{height:64px;margin:11px 0 7px;border-radius:11px;background:#0d0d0f;overflow:hidden;border:1px solid #ffffff0d}
      canvas{display:block;width:100%;height:100%}
      #detail{min-height:18px;color:#b9bbc0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .footer{display:flex;align-items:center;gap:8px;margin-top:12px}
      .privacy{display:flex;align-items:center;gap:5px;color:#8f9298;font-size:11px;margin-right:auto}
      .privacy svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2}
      .action{border:0;border-radius:9px;padding:7px 11px;cursor:pointer;font:600 12px system-ui}
      #cancel{background:transparent;color:#b8bac0}
      #cancel:hover{color:#fff;background:#ffffff0d}
      #stop{background:#f2f2ef;color:#171719;min-width:64px}
      #stop:disabled{opacity:.45;cursor:default}
      @keyframes pulse{50%{opacity:.42;box-shadow:0 0 0 6px #ff555518}}
      @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    </style>
    <button id="launcher" type="button" title="Start local dictation" aria-label="Start local dictation">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"></path></svg>
    </button>
    <section id="panel" role="dialog" aria-label="Smart Dictation recorder" data-phase="idle">
      <div class="header"><span class="dot"></span><strong id="title">Ready to dictate</strong><span id="timer">00:00</span></div>
      <div class="wave"><canvas id="waveform" aria-hidden="true"></canvas></div>
      <div id="detail" role="status" aria-live="polite">Audio is processed locally on this device.</div>
      <div class="footer">
        <span class="privacy"><svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>Private &amp; local</span>
        <button id="cancel" class="action" type="button">Cancel</button>
        <button id="stop" class="action" type="button" disabled>Stop</button>
      </div>
    </section>`;

  const launcher = shadow.querySelector<HTMLButtonElement>('#launcher');
  const panel = shadow.querySelector<HTMLElement>('#panel');
  const title = shadow.querySelector<HTMLElement>('#title');
  const detail = shadow.querySelector<HTMLElement>('#detail');
  const timer = shadow.querySelector<HTMLElement>('#timer');
  const stopButton = shadow.querySelector<HTMLButtonElement>('#stop');
  const cancelButton = shadow.querySelector<HTMLButtonElement>('#cancel');
  const canvas = shadow.querySelector<HTMLCanvasElement>('#waveform');
  const canvasContext = canvas?.getContext('2d') ?? null;

  function editorValue(editor: Editor): string {
    return editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
      ? editor.value
      : editor.textContent ?? '';
  }

  function eligible(target: EventTarget | null): target is Editor {
    if (target instanceof HTMLTextAreaElement) return !target.disabled && !target.readOnly;
    if (target instanceof HTMLInputElement) {
      return (
        ['text', 'search', 'email', 'url', 'tel'].includes(target.type) &&
        !target.disabled &&
        !target.readOnly
      );
    }
    return target instanceof HTMLElement && target.isContentEditable;
  }

  function selectEditor(target: EventTarget | null): void {
    if (!eligible(target) || phase !== 'idle') return;
    focused = target;
  }

  function editorAnchor(editor: Editor): { left: number; top: number; visible: boolean } {
    const rect = editor.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth;
    const outsideLeft = rect.right + 7;
    const left = outsideLeft + 34 <= window.innerWidth ? outsideLeft : rect.right - 38;
    return {
      left: Math.min(window.innerWidth - 40, Math.max(7, left)),
      top: Math.min(window.innerHeight - 40, Math.max(7, rect.top + 6)),
      visible,
    };
  }

  function position(): void {
    if (!focused || !focused.isConnected) {
      host.style.display = 'none';
      return;
    }
    const rect = focused.getBoundingClientRect();
    const anchor = editorAnchor(focused);
    host.style.left = `${anchor.left}px`;
    host.style.top = `${anchor.top}px`;
    host.style.display = 'block';
    panel?.setAttribute('data-above', String(rect.top > window.innerHeight - 220));
  }

  function addFieldButton(editor: Editor): void {
    if (fieldButtons.has(editor) || !eligible(editor)) return;
    const buttonHost = document.createElement('div');
    buttonHost.style.position = 'fixed';
    buttonHost.style.zIndex = '2147483646';
    buttonHost.style.width = '32px';
    buttonHost.style.height = '32px';
    document.documentElement.append(buttonHost);
    const buttonShadow = buttonHost.attachShadow({ mode: 'closed' });
    buttonShadow.innerHTML = `
      <style>
        button{box-sizing:border-box;width:32px;height:32px;padding:0;border:1px solid #ffffff38;border-radius:10px;background:#171719;color:#fff;display:grid;place-items:center;cursor:pointer;box-shadow:0 4px 14px #0004;transition:transform .15s ease,opacity .15s ease,background .15s ease}
        button:hover{transform:translateY(-1px);background:#29292d}
        button:disabled{cursor:default;opacity:.42;transform:none}
        svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}
        @media(prefers-reduced-motion:reduce){button{transition:none}}
      </style>
      <button type="button" aria-label="Start local dictation" title="Start local dictation">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"></path></svg>
      </button>`;
    const button = buttonShadow.querySelector<HTMLButtonElement>('button');
    if (!button) {
      buttonHost.remove();
      return;
    }
    button.addEventListener('click', () => {
      if (phase !== 'idle') return;
      focused = editor;
      void start();
    });
    fieldButtons.set(editor, { host: buttonHost, button });
  }

  function updateFieldButtons(): void {
    document.querySelectorAll(EDITOR_SELECTOR).forEach((candidate) => {
      if (eligible(candidate)) addFieldButton(candidate);
    });
    for (const [editor, affordance] of fieldButtons) {
      if (!editor.isConnected || !eligible(editor)) {
        affordance.host.remove();
        fieldButtons.delete(editor);
        continue;
      }
      const anchor = editorAnchor(editor);
      affordance.host.style.left = `${anchor.left}px`;
      affordance.host.style.top = `${anchor.top}px`;
      affordance.host.style.display = anchor.visible ? 'block' : 'none';
      affordance.button.disabled = phase !== 'idle';
    }
  }

  function takeSnapshot(editor: Editor): Snapshot {
    const selection = window.getSelection();
    const value = editorValue(editor);
    const start =
      editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
        ? editor.selectionStart
        : null;
    const end =
      editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
        ? editor.selectionEnd
        : null;
    return {
      editor,
      value,
      originalValue: value,
      originalStart: start,
      originalEnd: end,
      start,
      end,
      range: selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null,
    };
  }

  function setEditorText(editor: Editor, value: string, inputType: string): void {
    editor.dispatchEvent(
      new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType, data: null }),
    );
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      const prototype =
        editor instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(editor, value);
      editor.setSelectionRange(value.length, value.length);
    } else {
      editor.textContent = value;
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: null }));
  }

  function clearFieldForRecording(): void {
    if (!snapshot || fieldCleared) return;
    setEditorText(snapshot.editor, '', 'deleteContent');
    const range = document.createRange();
    range.selectNodeContents(snapshot.editor);
    range.collapse(true);
    snapshot = { ...snapshot, value: '', start: 0, end: 0, range };
    fieldCleared = true;
  }

  function restoreClearedField(): void {
    if (!snapshot || !fieldCleared || editorValue(snapshot.editor) !== snapshot.value) return;
    setEditorText(snapshot.editor, snapshot.originalValue, 'insertReplacementText');
    if (
      (snapshot.editor instanceof HTMLInputElement || snapshot.editor instanceof HTMLTextAreaElement) &&
      snapshot.originalStart !== null &&
      snapshot.originalEnd !== null
    ) {
      snapshot.editor.setSelectionRange(snapshot.originalStart, snapshot.originalEnd);
    }
    fieldCleared = false;
  }

  function insertResult(text: string): boolean {
    if (!snapshot?.editor.isConnected || editorValue(snapshot.editor) !== snapshot.value) return false;
    const editor = snapshot.editor;
    if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
      const start = snapshot.start ?? editor.value.length;
      const end = snapshot.end ?? start;
      const next = editor.value.slice(0, start) + text + editor.value.slice(end);
      const prototype =
        editor instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      editor.dispatchEvent(
        new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }),
      );
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(editor, next);
      editor.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
      );
      editor.setSelectionRange(start + text.length, start + text.length);
      return true;
    }
    const range = snapshot.range;
    if (!range) return false;
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
    return true;
  }

  const phaseCopy: Record<RecorderPhase, { title: string; detail: string }> = {
    idle: { title: 'Ready to dictate', detail: 'Audio is processed locally on this device.' },
    preparing: { title: 'Getting ready', detail: 'Preparing the local speech model…' },
    recording: { title: 'Listening', detail: 'Speak naturally. Click Stop when you finish.' },
    resampling: { title: 'Preparing audio', detail: 'Converting audio locally to 16 kHz…' },
    transcribing: { title: 'Transcribing', detail: 'Moonshine is converting your voice to text…' },
    rewriting: { title: 'Polishing', detail: 'S1-mini is cleaning the transcript…' },
    done: { title: 'Inserted', detail: 'Your cleaned dictation is ready.' },
    error: { title: 'Could not finish', detail: 'Try again or check the extension popup.' },
  };

  function setPhase(next: RecorderPhase, detailOverride?: string): void {
    phase = next;
    panel?.setAttribute('data-phase', next);
    panel?.setAttribute('data-open', String(next !== 'idle'));
    launcher?.setAttribute('data-active', String(next === 'recording'));
    if (title) title.textContent = phaseCopy[next].title;
    if (detail) detail.textContent = detailOverride ?? phaseCopy[next].detail;
    if (stopButton) stopButton.disabled = next !== 'recording';
    if (next === 'recording') startTimer();
    else stopTimer();
    if (next !== 'idle') {
      position();
      startWaveform();
    } else {
      host.style.display = 'none';
    }
    updateFieldButtons();
  }

  function startTimer(): void {
    if (recordingStartedAt) return;
    recordingStartedAt = performance.now();
    updateTimer();
    timerHandle = setInterval(updateTimer, 250);
  }

  function stopTimer(): void {
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = null;
    if (phase !== 'recording') recordingStartedAt = 0;
  }

  function updateTimer(): void {
    if (!timer || !recordingStartedAt) return;
    const elapsed = Math.floor((performance.now() - recordingStartedAt) / 1000);
    timer.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(
      elapsed % 60,
    ).padStart(2, '0')}`;
  }

  function startWaveform(): void {
    if (!animationFrame) animationFrame = requestAnimationFrame(drawWaveform);
  }

  function drawWaveform(now: number): void {
    animationFrame = 0;
    if (!canvas || !canvasContext || phase === 'idle') return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * scale));
    const height = Math.max(1, Math.round(rect.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvasContext.setTransform(scale, 0, 0, scale, 0, 0);
    }
    const cssWidth = rect.width;
    const cssHeight = rect.height;
    canvasContext.clearRect(0, 0, cssWidth, cssHeight);
    levels = levels.slice(1);
    const processing = phase === 'preparing' || phase === 'resampling' || phase === 'transcribing' || phase === 'rewriting';
    const target =
      phase === 'recording'
        ? Math.max(0.07, liveLevel)
        : processing
          ? 0.15 + ((Math.sin(now * 0.004) + 1) / 2) * 0.28
          : 0.11;
    levels.push(target);
    liveLevel *= 0.78;
    const gap = cssWidth / levels.length;
    for (let index = 0; index < levels.length; index += 1) {
      const envelope = Math.pow(Math.sin((index / (levels.length - 1)) * Math.PI), 0.55);
      const processingWave = processing ? 0.7 + Math.sin(now * 0.006 - index * 0.35) * 0.25 : 1;
      const barHeight = Math.max(
        3,
        (levels[index] ?? 0.08) * envelope * processingWave * cssHeight * 0.88,
      );
      const barWidth = Math.max(2, Math.min(3.2, gap * 0.46));
      canvasContext.fillStyle =
        phase === 'recording'
          ? `rgba(255,105,105,${0.4 + envelope * 0.55})`
          : `rgba(235,236,239,${0.24 + envelope * 0.55})`;
      canvasContext.beginPath();
      canvasContext.roundRect(
        index * gap + (gap - barWidth) / 2,
        (cssHeight - barHeight) / 2,
        barWidth,
        barHeight,
        barWidth / 2,
      );
      canvasContext.fill();
    }
    startWaveform();
  }

  async function start(): Promise<void> {
    if (!focused || identity || starting) return;
    starting = true;
    setPhase('preparing');
    snapshot = takeSnapshot(focused);
    const fieldId = fieldIds.get(focused) ?? crypto.randomUUID();
    fieldIds.set(focused, fieldId);
    origin = { jobId: crypto.randomUUID(), documentId, fieldId };
    try {
      const stored = await chrome.storage.local.get('settings');
      const parsed = migrateSettings(stored.settings);
      const response: unknown = await chrome.runtime.sendMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'job.start',
        origin,
        settings: parsed.ok ? parsed.value : { ...DEFAULT_SETTINGS },
      });
      if (isExtensionMessage(response) && response.type === 'job.accepted') identity = response.identity;
      if (isExtensionMessage(response) && response.type === 'job.error') {
        setPhase('error', response.error.userMessage);
      }
    } catch {
      setPhase('error', 'The recorder could not start. Reload the extension and try again.');
    } finally {
      starting = false;
    }
  }

  function reset(): void {
    identity = null;
    origin = null;
    liveLevel = 0;
    levels = levels.map(() => 0.08);
    fieldCleared = false;
    snapshot = null;
    if (timer) timer.textContent = '00:00';
    setPhase('idle');
  }

  launcher?.addEventListener('click', () => {
    if (phase === 'idle' || phase === 'done' || phase === 'error') void start();
  });
  stopButton?.addEventListener('click', () => {
    if (!identity) return;
    void chrome.runtime.sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'job.stop', identity });
    setPhase('resampling');
  });
  cancelButton?.addEventListener('click', () => {
    if (identity) {
      void chrome.runtime.sendMessage({ protocolVersion: PROTOCOL_VERSION, type: 'job.cancel', identity });
    }
    restoreClearedField();
    reset();
  });

  document.addEventListener('focusin', (event) => selectEditor(event.target));
  document.addEventListener('pointerover', (event) => selectEditor(event.target));
  window.addEventListener(
    'scroll',
    () => {
      if (phase !== 'idle') position();
      updateFieldButtons();
    },
    true,
  );
  window.addEventListener('resize', () => {
    if (phase !== 'idle') position();
    updateFieldButtons();
  });
  window.addEventListener('pagehide', () => {
    if (identity) {
      void chrome.runtime.sendMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'job.cancel',
        identity,
      });
    }
  });
  const mutationObserver = new MutationObserver(updateFieldButtons);
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'readonly', 'type', 'contenteditable', 'hidden'],
  });
  const initiallyFocused = document.activeElement;
  const firstEditor = document.querySelector(EDITOR_SELECTOR);
  selectEditor(eligible(initiallyFocused) ? initiallyFocused : firstEditor);
  updateFieldButtons();

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'type' in raw &&
      raw.type === 'smart-dictation.ping'
    ) {
      sendResponse({ ready: true });
      return false;
    }
    if (
      !isExtensionMessage(raw) ||
      !origin ||
      !('identity' in raw) ||
      raw.identity?.jobId !== origin.jobId
    ) {
      return false;
    }
    if (raw.type === 'job.audio-level') liveLevel = raw.level;
    if (raw.type === 'job.progress') {
      if (raw.phase === 'recording') {
        clearFieldForRecording();
        setPhase('recording');
      }
      if (raw.phase === 'resampling') setPhase('resampling');
      if (raw.phase === 'transcribing') setPhase('transcribing');
      if (raw.phase === 'rewriting') setPhase('rewriting');
    }
    if (raw.type === 'job.result') {
      const inserted = insertResult(raw.cleanText);
      identity = null;
      if (inserted) {
        snapshot = null;
        fieldCleared = false;
        setPhase('done');
        setTimeout(reset, 1600);
      } else {
        setPhase('error', 'The field changed while processing. Your text was not overwritten.');
      }
    }
    if (raw.type === 'job.error') {
      identity = null;
      restoreClearedField();
      setPhase(
        'error',
        raw.detail ? `${raw.error.userMessage} ${raw.detail}` : raw.error.userMessage,
      );
    }
    return false;
  });
}
