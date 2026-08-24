import {
  env,
  ModelRegistry,
  pipeline,
  TextStreamer,
  type ProgressInfo,
} from '@huggingface/transformers';

import { createDiagnosticError, sanitizeError } from '../shared/errors.ts';
import {
  PROTOCOL_VERSION,
  type BeginJobMessage,
  type ExtensionMessage,
  type JobIdentity,
  type ModelCacheStatus,
} from '../shared/messages.ts';
import {
  createRewriteMessages,
  MAX_RECORDING_SECONDS,
  MIN_RECORDING_SECONDS,
  MODEL_CONFIG,
  ORT_RUNTIME_PATH,
  TARGET_SAMPLE_RATE,
} from '../shared/model-config.ts';
import type { DictationSettings } from '../shared/settings.ts';
import { isExtensionMessage } from '../shared/validation.ts';
import workletUrl from './audio-worklet.js?url&no-inline';

interface AsrPipeline {
  (audio: Float32Array, options: { max_new_tokens: number }): Promise<{ text?: string }>;
  dispose(): Promise<void>;
}

interface NormalizerOutput {
  generated_text?: Array<{ content?: string }>;
}

interface NormalizerPipeline {
  tokenizer: ConstructorParameters<typeof TextStreamer>[0] &
    ((text: string) => { input_ids?: { size?: number; dims?: number[] } });
  (
    messages: ReturnType<typeof createRewriteMessages>,
    options: Record<string, unknown>,
  ): Promise<NormalizerOutput[]>;
  dispose(): Promise<void>;
}

interface Capture {
  identity: JobIdentity;
  settings: DictationSettings;
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  recorder: AudioWorkletNode;
  chunks: Float32Array[];
  sampleRate: number;
  limit: ReturnType<typeof setTimeout>;
}

let transcriber: AsrPipeline | null = null;
let normalizer: NormalizerPipeline | null = null;
let transcriberPromise: Promise<AsrPipeline> | null = null;
let normalizerPromise: Promise<NormalizerPipeline> | null = null;
let capture: Capture | null = null;
let processingStage = 'idle';

env.allowLocalModels = false;
env.useBrowserCache = true;
const wasmBackend = env.backends.onnx.wasm;
if (!wasmBackend) throw new Error('ONNX WASM backend is unavailable.');
wasmBackend.wasmPaths = chrome.runtime.getURL(ORT_RUNTIME_PATH);
wasmBackend.numThreads = 1;
wasmBackend.proxy = false;

if (!wasmBackend.wasmPaths.startsWith('chrome-extension://')) {
  throw new Error('ORT runtime assets must resolve inside the extension package.');
}

function emit(message: ExtensionMessage): void {
  void chrome.runtime.sendMessage(message);
}

function progress(identity: JobIdentity, phase: 'preparing' | 'recording' | 'resampling' | 'transcribing' | 'rewriting', percent?: number): void {
  emit({
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.progress',
    identity,
    phase,
    ...(percent === undefined ? {} : { percent }),
  });
}

type ModelLabel = 'speech recognition' | 'S1-mini';
interface ModelDownloadProgress {
  percent?: number;
  loaded?: number;
  total?: number;
}

function describeThrown(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    if (typeof value === 'object') {
      const properties = Object.fromEntries(
        Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]),
      );
      return JSON.stringify(properties).slice(0, 520);
    }
    return String(value).slice(0, 520);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function modelProgress(
  label: ModelLabel,
  callback: (label: ModelLabel, progress: ModelDownloadProgress) => void,
): (event: ProgressInfo) => void {
  return (event) => {
    if (event.status === 'progress_total') {
      callback(label, {
        percent: event.progress,
        loaded: event.loaded,
        total: event.total,
      });
    }
  };
}

async function loadTranscriber(
  callback: (label: ModelLabel, progress: ModelDownloadProgress) => void,
): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  if (!transcriber) {
    transcriberPromise ??= pipeline(MODEL_CONFIG.asr.task, MODEL_CONFIG.asr.model, {
      revision: MODEL_CONFIG.asr.revision,
      dtype: MODEL_CONFIG.asr.dtype,
      device: MODEL_CONFIG.asr.device,
      progress_callback: modelProgress('speech recognition', callback),
    }) as unknown as Promise<AsrPipeline>;
    try {
      transcriber = await transcriberPromise;
    } finally {
      transcriberPromise = null;
    }
  } else callback('speech recognition', { percent: 100 });
}

async function loadNormalizer(
  callback: (label: ModelLabel, progress: ModelDownloadProgress) => void,
): Promise<void> {
  if (!navigator.gpu) throw new Error('WebGPU unavailable');
  if (!normalizer) {
    normalizerPromise ??= pipeline(
      MODEL_CONFIG.normalizer.task,
      MODEL_CONFIG.normalizer.model,
      {
        revision: MODEL_CONFIG.normalizer.revision,
        dtype: MODEL_CONFIG.normalizer.dtype,
        device: MODEL_CONFIG.normalizer.device,
        progress_callback: modelProgress('S1-mini', callback),
      },
    ) as unknown as Promise<NormalizerPipeline>;
    try {
      normalizer = await normalizerPromise;
    } finally {
      normalizerPromise = null;
    }
  } else callback('S1-mini', { percent: 100 });
}

async function inspectModel(
  model: ModelCacheStatus['model'],
  config: typeof MODEL_CONFIG.asr | typeof MODEL_CONFIG.normalizer,
): Promise<ModelCacheStatus> {
  const options = {
    revision: config.revision,
    dtype: config.dtype,
    device: config.device,
  } as const;
  const files = await ModelRegistry.get_pipeline_files(config.task, config.model, options);
  const [cacheStatus, metadata] = await Promise.all([
    ModelRegistry.is_pipeline_cached_files(config.task, config.model, options),
    Promise.all(
      files.map((file) =>
        ModelRegistry.get_file_metadata(config.model, file, { revision: config.revision }),
      ),
    ),
  ]);
  return {
    model,
    modelId: config.model,
    cached: cacheStatus.allCached,
    totalBytes: metadata.reduce((total, item) => total + (item.size ?? 0), 0),
    cachedFiles: cacheStatus.files.filter((item) => item.cached).length,
    totalFiles: cacheStatus.files.length,
  };
}

async function inspectModels(): Promise<{ ok: true; models: ModelCacheStatus[] }> {
  const models = await Promise.all([
    inspectModel('speech recognition', MODEL_CONFIG.asr),
    inspectModel('S1-mini', MODEL_CONFIG.normalizer),
  ]);
  return { ok: true, models };
}

async function clearModels(): Promise<{ ok: true }> {
  await transcriber?.dispose();
  await normalizer?.dispose();
  transcriber = null;
  normalizer = null;
  transcriberPromise = null;
  normalizerPromise = null;
  await Promise.all([
    ModelRegistry.clear_pipeline_cache(MODEL_CONFIG.asr.task, MODEL_CONFIG.asr.model, {
      revision: MODEL_CONFIG.asr.revision,
      dtype: MODEL_CONFIG.asr.dtype,
      device: MODEL_CONFIG.asr.device,
    }),
    ModelRegistry.clear_pipeline_cache(
      MODEL_CONFIG.normalizer.task,
      MODEL_CONFIG.normalizer.model,
      {
        revision: MODEL_CONFIG.normalizer.revision,
        dtype: MODEL_CONFIG.normalizer.dtype,
        device: MODEL_CONFIG.normalizer.device,
      },
    ),
  ]);
  return { ok: true };
}

async function prepareModels(): Promise<void> {
  let stage = 'Moonshine pipeline creation';
  try {
    const report = (model: ModelLabel, download: ModelDownloadProgress): void => {
      emit({
        protocolVersion: PROTOCOL_VERSION,
        type: 'models.progress',
        model,
        ...download,
      });
    };
    // Warm each pipeline independently so all remote files enter Cache Storage
    // without retaining both large GPU sessions at the same time.
    await loadTranscriber(report);
    stage = 'Moonshine pipeline disposal';
    await transcriber?.dispose();
    transcriber = null;
    stage = 'S1-mini pipeline creation';
    await loadNormalizer(report);
    stage = 'S1-mini pipeline disposal';
    await normalizer?.dispose();
    normalizer = null;
    emit({ protocolVersion: PROTOCOL_VERSION, type: 'models.ready' });
  } catch (error) {
    const detail = `[${stage}] ${describeThrown(error)}`.slice(0, 600);
    console.error('[Smart Dictation AI] model preparation failed', detail);
    emit({
      protocolVersion: PROTOCOL_VERSION,
      type: 'models.error',
      error: createDiagnosticError('MODEL_DOWNLOAD_FAILED', 'preparing'),
      detail,
    });
    throw error;
  }
}

async function begin(message: BeginJobMessage): Promise<void> {
  if (capture) throw new Error('Dictation busy');
  processingStage = 'Moonshine preparation and microphone startup';
  progress(message.identity, 'preparing');
  await loadTranscriber((_model, download) =>
    progress(message.identity, 'preparing', download.percent),
  );
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const recorder = new AudioWorkletNode(context, 'smart-dictation-pcm', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
  });
  const chunks: Float32Array[] = [];
  let lastLevelAt = 0;
  recorder.port.onmessage = ({ data }: MessageEvent<{ type: string; samples?: Float32Array }>) => {
    if (data.type === 'chunk' && data.samples) {
      chunks.push(data.samples);
      const now = performance.now();
      if (now - lastLevelAt >= 65) {
        let energy = 0;
        for (const sample of data.samples) energy += sample * sample;
        const rms = Math.sqrt(energy / Math.max(1, data.samples.length));
        emit({
          protocolVersion: PROTOCOL_VERSION,
          type: 'job.audio-level',
          identity: message.identity,
          level: Math.min(1, rms * 7.5),
        });
        lastLevelAt = now;
      }
    }
  };
  source.connect(recorder);
  recorder.connect(context.destination);
  capture = {
    identity: message.identity,
    settings: message.settings,
    stream,
    context,
    source,
    recorder,
    chunks,
    sampleRate: context.sampleRate,
    limit: setTimeout(() => void stop(message.identity), MAX_RECORDING_SECONDS * 1000),
  };
  processingStage = 'recording';
  progress(message.identity, 'recording');
}

async function finishCapture(discard: boolean): Promise<{ audio: Float32Array; capture: Capture } | null> {
  const current = capture;
  if (!current) return null;
  capture = null;
  clearTimeout(current.limit);

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 200);
    const prior = current.recorder.port.onmessage;
    current.recorder.port.onmessage = (event) => {
      prior?.call(current.recorder.port, event);
      if ((event.data as { type?: string }).type === 'flushed') {
        clearTimeout(timeout);
        resolve();
      }
    };
    current.recorder.port.postMessage('flush');
  });

  current.source.disconnect();
  current.recorder.disconnect();
  current.stream.getTracks().forEach((track) => track.stop());
  await current.context.close();
  if (discard) return null;

  const length = current.chunks.reduce((total, chunk) => total + chunk.length, 0);
  const nativeAudio = new Float32Array(length);
  let offset = 0;
  for (const chunk of current.chunks) {
    nativeAudio.set(chunk, offset);
    offset += chunk.length;
  }
  return { audio: await resample(nativeAudio, current.sampleRate), capture: current };
}

async function resample(samples: Float32Array, sourceRate: number): Promise<Float32Array> {
  if (sourceRate === TARGET_SAMPLE_RATE) return samples;
  const frameCount = Math.round((samples.length * TARGET_SAMPLE_RATE) / sourceRate);
  const offline = new OfflineAudioContext(1, Math.max(1, frameCount), TARGET_SAMPLE_RATE);
  const buffer = offline.createBuffer(1, samples.length, sourceRate);
  buffer.copyToChannel(new Float32Array(samples), 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

async function stop(identity: JobIdentity): Promise<void> {
  if (capture?.identity.jobId !== identity.jobId) return;
  processingStage = 'audio finalization and 16 kHz resampling';
  progress(identity, 'resampling');
  const completed = await finishCapture(false);
  if (!completed) return;
  const { audio, capture: finished } = completed;
  if (audio.length < TARGET_SAMPLE_RATE * MIN_RECORDING_SECONDS) {
    throw Object.assign(new Error('Audio too short'), { code: 'AUDIO_TOO_SHORT' });
  }

  progress(identity, 'transcribing');
  if (!transcriber) throw new Error('Speech recognition model is not prepared.');
  const maxNewTokens = Math.max(6, Math.floor(audio.length / TARGET_SAMPLE_RATE) * 6);
  processingStage = 'Moonshine inference';
  const rawText = ((await transcriber(audio, { max_new_tokens: maxNewTokens })).text ?? '').trim();
  let cleanText = rawText;

  if (finished.settings.mode === 'clean') {
    processingStage = 'Moonshine disposal';
    await transcriber.dispose();
    transcriber = null;
  }

  if (finished.settings.mode === 'clean' && rawText) {
    progress(identity, 'rewriting');
    processingStage = 'S1-mini pipeline creation from cache';
    await loadNormalizer(() => undefined);
    if (!normalizer) throw new Error('S1-mini model could not be initialized from cache.');
    const activeNormalizer = normalizer;
    let generationSucceeded = false;
    try {
      const input = activeNormalizer.tokenizer(rawText).input_ids;
      const tokens = input?.size ?? input?.dims?.at(-1) ?? 128;
      const maxNewTokens = Math.min(1024, Math.max(64, Math.ceil(tokens * 1.3) + 32));
      const rewriteMessages = createRewriteMessages(rawText, finished.settings);
      let streamed = '';
      const streamer = new TextStreamer(activeNormalizer.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (text) => {
          streamed += text;
        },
      });
      console.debug('[Smart Dictation AI] S1-mini request metadata', {
        model: MODEL_CONFIG.normalizer.model,
        revision: MODEL_CONFIG.normalizer.revision,
        settings: finished.settings,
        inputCharacters: rawText.length,
        messageRoles: rewriteMessages.map((message) => message.role),
        controlLine: rewriteMessages[1]?.content.split('\n', 1)[0] ?? '',
        generation: {
          max_new_tokens: maxNewTokens,
          do_sample: false,
          tokenizer_encode_kwargs: { enable_thinking: false },
          streamer: 'TextStreamer(skip_prompt=true, skip_special_tokens=true)',
        },
      });
      processingStage = 'S1-mini generation';
      const output = await activeNormalizer(rewriteMessages, {
        max_new_tokens: maxNewTokens,
        do_sample: false,
        streamer,
        tokenizer_encode_kwargs: { enable_thinking: false },
      });
      cleanText = (output[0]?.generated_text?.at(-1)?.content ?? streamed).trim();
      generationSucceeded = true;
    } finally {
      if (generationSucceeded) processingStage = 'S1-mini disposal';
      await activeNormalizer.dispose();
      if (normalizer === activeNormalizer) normalizer = null;
    }
  }

  emit({ protocolVersion: PROTOCOL_VERSION, type: 'job.result', identity, rawText, cleanText });
  processingStage = 'idle';
}

async function cancel(identity: JobIdentity): Promise<void> {
  if (capture?.identity.jobId === identity.jobId) await finishCapture(true);
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(raw)) return false;
  const task =
    raw.type === 'models.inspect'
      ? inspectModels()
      : raw.type === 'models.clear'
        ? clearModels()
        : raw.type === 'models.load'
      ? prepareModels()
      : raw.type === 'job.begin'
      ? begin(raw)
      : raw.type === 'job.stop'
        ? stop(raw.identity)
        : raw.type === 'job.cancel'
          ? cancel(raw.identity)
          : null;
  if (!task) return false;

  task
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error: unknown) => {
      const identity = 'identity' in raw ? raw.identity : undefined;
      if (identity) {
        const detail = `[${processingStage}] ${describeThrown(error)}`.slice(0, 600);
        console.error('[Smart Dictation AI] processing failed', detail);
        emit({
          protocolVersion: PROTOCOL_VERSION,
          type: 'job.error',
          identity,
          error: sanitizeError(error, raw.type === 'job.begin' ? 'preparing' : 'processing'),
          detail,
        });
      }
      processingStage = 'idle';
      void finishCapture(true);
      sendResponse({ ok: false });
    });
  return true;
});
