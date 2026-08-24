import { describe, expect, it } from 'vitest';

import { createDiagnosticError } from '../../../src/shared/errors.ts';
import { PROTOCOL_VERSION, type ExtensionMessage } from '../../../src/shared/messages.ts';
import { DEFAULT_SETTINGS } from '../../../src/shared/settings.ts';
import { isExtensionMessage } from '../../../src/shared/validation.ts';

const identity = {
  jobId: 'job-1',
  tabId: 7,
  frameId: 2,
  documentId: 'document-1',
  fieldId: 'field-1',
};

const validMessages: readonly ExtensionMessage[] = [
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.start',
    origin: {
      jobId: identity.jobId,
      documentId: identity.documentId,
      fieldId: identity.fieldId,
    },
    settings: { ...DEFAULT_SETTINGS },
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.begin',
    identity,
    settings: { ...DEFAULT_SETTINGS },
  },
  { protocolVersion: PROTOCOL_VERSION, type: 'job.accepted', identity },
  { protocolVersion: PROTOCOL_VERSION, type: 'job.stop', identity },
  { protocolVersion: PROTOCOL_VERSION, type: 'job.cancel', identity },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.progress',
    identity,
    phase: 'transcribing',
    percent: 50,
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.audio-level',
    identity,
    level: 0.42,
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.result',
    identity,
    rawText: 'raw',
    cleanText: 'clean',
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'job.error',
    identity,
    error: createDiagnosticError('INTERNAL', 'transcribing'),
  },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.prepare' },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.load' },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'models.progress',
    model: 'speech recognition',
    percent: 42,
    loaded: 42,
    total: 100,
  },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.ready' },
  {
    protocolVersion: PROTOCOL_VERSION,
    type: 'models.error',
    error: createDiagnosticError('MODEL_DOWNLOAD_FAILED', 'preparing'),
  },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.status-request' },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.inspect' },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.clear-request' },
  { protocolVersion: PROTOCOL_VERSION, type: 'models.clear' },
];

describe('extension message validation', () => {
  it.each(validMessages.map((message) => [message.type, message] as const))(
    'accepts %s',
    (_type, message) => {
      expect(isExtensionMessage(message)).toBe(true);
    },
  );

  it.each([
    null,
    {},
    { protocolVersion: 2, type: 'models.ready' },
    { protocolVersion: PROTOCOL_VERSION, type: 'unknown' },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.accepted',
      identity: { ...identity, tabId: -1 },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.progress',
      identity,
      phase: 'transcribing',
      percent: 101,
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.audio-level',
      identity,
      level: 1.1,
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.result',
      identity,
      rawText: 42,
      cleanText: 'clean',
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.error',
      identity: undefined,
      origin: undefined,
      error: createDiagnosticError('INTERNAL', 'rewriting'),
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'job.error',
      identity,
      error: {
        ...createDiagnosticError('INTERNAL', 'rewriting'),
        userMessage: 'TRANSCRIPT: SECRET FIELD CONTENT',
      },
    },
    {
      protocolVersion: PROTOCOL_VERSION,
      type: 'models.progress',
      model: 'S1-mini',
      percent: 90,
      loaded: 101,
      total: 100,
    },
  ])('rejects malformed value %#', (value) => {
    expect(isExtensionMessage(value)).toBe(false);
  });
});
