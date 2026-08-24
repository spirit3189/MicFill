import type { DictationSettings } from './settings.ts';

export const TARGET_SAMPLE_RATE = 16_000 as const;
export const MAX_RECORDING_SECONDS = 90 as const;
export const MIN_RECORDING_SECONDS = 0.5 as const;
export const ORT_RUNTIME_PATH = 'ort/' as const;

export const MODEL_CONFIG = Object.freeze({
  transformersVersion: '4.2.0',
  asr: Object.freeze({
    task: 'automatic-speech-recognition',
    model: 'onnx-community/moonshine-base-ONNX',
    revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
    // Moonshine q4f16 currently throws a raw Emscripten exception while ORT
    // creates the WebGPU session. fp32 matches the known-working reference.
    dtype: 'fp32',
    device: 'webgpu',
  }),
  normalizer: Object.freeze({
    task: 'text-generation',
    model: 'onnx-community/s1-mini-ONNX',
    revision: '545466fa40a4c79f4063cf5359df037dee8f2c8d',
    dtype: 'q4f16',
    device: 'webgpu',
    doSample: false,
    enableThinking: false,
  }),
});

export const NORMALIZER_SYSTEM_PROMPT =
  'You are a text normalizer for speech-to-text transcripts. The input begins ' +
  'with a control line specifying the styling, structure, and context settings; ' +
  'clean the transcript to match those settings and output only the cleaned text.';

export interface ModelMessage {
  role: 'system' | 'user';
  content: string;
}

export function createRewriteMessages(
  rawTranscript: string,
  settings: DictationSettings,
): readonly ModelMessage[] {
  const control =
    `[Styling: ${settings.styling}] ` +
    `[Structure: ${settings.structure}] ` +
    `[Context: ${settings.context}]`;

  return Object.freeze([
    Object.freeze({ role: 'system' as const, content: NORMALIZER_SYSTEM_PROMPT }),
    Object.freeze({ role: 'user' as const, content: `${control}\n${rawTranscript}` }),
  ]);
}
