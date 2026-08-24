import { describe, expect, it } from 'vitest';

import { createDiagnosticError, sanitizeError } from '../../../src/shared/errors.ts';
import {
  createRewriteMessages,
  MODEL_CONFIG,
  NORMALIZER_SYSTEM_PROMPT,
  ORT_RUNTIME_PATH,
  TARGET_SAMPLE_RATE,
} from '../../../src/shared/model-config.ts';
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  parseSettings,
} from '../../../src/shared/settings.ts';

describe('settings schema', () => {
  it('supplies the approved defaults for an empty store', () => {
    expect(migrateSettings(undefined)).toEqual({ ok: true, value: { ...DEFAULT_SETTINGS } });
  });

  it('migrates the versionless initial shape', () => {
    expect(
      migrateSettings({ mode: 'raw', styling: 'formal', structure: 'lists', context: 'email' }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        mode: 'raw',
        styling: 'formal',
        structure: 'lists',
        context: 'email',
      },
    });
  });

  it.each([
    'invalid',
    {},
    { ...DEFAULT_SETTINGS, schemaVersion: 2 },
    { ...DEFAULT_SETTINGS, mode: 'cloud' },
    { ...DEFAULT_SETTINGS, styling: 'legalese' },
  ])('rejects malformed settings %#', (value) => {
    expect(parseSettings(value).ok).toBe(false);
  });
});

describe('model and rewrite configuration', () => {
  it('pins the exact approved runtime and model values', () => {
    expect(MODEL_CONFIG).toMatchObject({
      transformersVersion: '4.2.0',
      asr: {
        model: 'onnx-community/moonshine-base-ONNX',
        revision: 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
        dtype: 'fp32',
        device: 'webgpu',
      },
      normalizer: {
        model: 'onnx-community/s1-mini-ONNX',
        revision: '545466fa40a4c79f4063cf5359df037dee8f2c8d',
        dtype: 'q4f16',
        device: 'webgpu',
        doSample: false,
        enableThinking: false,
      },
    });
    expect(ORT_RUNTIME_PATH).toBe('ort/');
    expect(TARGET_SAMPLE_RATE).toBe(16_000);
    expect(Object.isFrozen(MODEL_CONFIG)).toBe(true);
  });

  it('serializes the exact rewrite control message without retaining external state', () => {
    const raw = 'hello um this is a test';
    const messages = createRewriteMessages(raw, { ...DEFAULT_SETTINGS });

    expect(messages).toEqual([
      { role: 'system', content: NORMALIZER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: '[Styling: semi-formal] [Structure: prose] [Context: general]\n' + raw,
      },
    ]);
    expect(Object.isFrozen(messages)).toBe(true);
  });
});

describe('sanitized diagnostics', () => {
  it('maps known browser errors without echoing their message', () => {
    const secret = 'SECRET_TRANSCRIPT_SENTINEL';
    const diagnostic = sanitizeError(
      Object.assign(new Error(`Permission denied ${secret}`), { name: 'NotAllowedError' }),
      'recording',
    );

    expect(diagnostic.code).toBe('MICROPHONE_DENIED');
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });

  it('uses a stable generic error for unknown failures', () => {
    expect(sanitizeError(new Error('private field content'), 'rewriting')).toEqual(
      createDiagnosticError('INTERNAL', 'rewriting'),
    );
  });
});
