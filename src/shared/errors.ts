export const ERROR_CODES = [
  'WEBGPU_UNAVAILABLE',
  'MICROPHONE_DENIED',
  'MICROPHONE_UNAVAILABLE',
  'MODEL_DOWNLOAD_FAILED',
  'STORAGE_QUOTA',
  'TARGET_INVALIDATED',
  'DICTATION_BUSY',
  'AUDIO_TOO_SHORT',
  'CANCELLED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DiagnosticError {
  code: ErrorCode;
  phase: string;
  retryable: boolean;
  userMessage: string;
}

const ERROR_PRESENTATION: Readonly<Record<ErrorCode, Omit<DiagnosticError, 'code' | 'phase'>>> =
  Object.freeze({
    WEBGPU_UNAVAILABLE: {
      retryable: false,
      userMessage: 'WebGPU is unavailable. Use a supported Chrome device with WebGPU enabled.',
    },
    MICROPHONE_DENIED: {
      retryable: true,
      userMessage: 'Microphone access was denied. Open the extension popup, allow microphone access, and try again.',
    },
    MICROPHONE_UNAVAILABLE: {
      retryable: true,
      userMessage: 'No usable microphone is available.',
    },
    MODEL_DOWNLOAD_FAILED: {
      retryable: true,
      userMessage: 'The local AI models could not be prepared. Check your connection and retry.',
    },
    STORAGE_QUOTA: {
      retryable: true,
      userMessage: 'There is not enough browser storage for the local AI models.',
    },
    TARGET_INVALIDATED: {
      retryable: false,
      userMessage: 'The original editor changed before dictation completed.',
    },
    DICTATION_BUSY: {
      retryable: true,
      userMessage: 'Dictation is already active in another tab.',
    },
    AUDIO_TOO_SHORT: {
      retryable: true,
      userMessage: 'That recording was too short. Try speaking for a little longer.',
    },
    CANCELLED: {
      retryable: true,
      userMessage: 'Dictation was cancelled.',
    },
    INTERNAL: {
      retryable: true,
      userMessage: 'Smart Dictation AI could not complete this request.',
    },
  });

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : '';
}

function errorMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String(error.message).toLowerCase()
    : '';
}

export function classifyError(error: unknown): ErrorCode {
  const name = errorName(error);
  const message = errorMessage(error);

  if (name === 'NotAllowedError' || message.includes('permission denied')) {
    return 'MICROPHONE_DENIED';
  }
  if (name === 'NotFoundError' || message.includes('no microphone')) {
    return 'MICROPHONE_UNAVAILABLE';
  }
  if (name === 'QuotaExceededError' || message.includes('quota')) return 'STORAGE_QUOTA';
  if (message.includes('webgpu') || message.includes('navigator.gpu')) return 'WEBGPU_UNAVAILABLE';
  if (message.includes('download') || message.includes('fetch')) return 'MODEL_DOWNLOAD_FAILED';
  if (message.includes('too short')) return 'AUDIO_TOO_SHORT';
  return 'INTERNAL';
}

export function createDiagnosticError(code: ErrorCode, phase: string): DiagnosticError {
  return { code, phase, ...ERROR_PRESENTATION[code] };
}

export function isDiagnosticError(value: unknown): value is DiagnosticError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DiagnosticError>;
  if (!candidate.code || !ERROR_CODES.includes(candidate.code)) return false;
  const presentation = ERROR_PRESENTATION[candidate.code];
  return (
    typeof candidate.phase === 'string' &&
    candidate.phase.length > 0 &&
    candidate.retryable === presentation.retryable &&
    candidate.userMessage === presentation.userMessage
  );
}

export function sanitizeError(error: unknown, phase: string): DiagnosticError {
  return createDiagnosticError(classifyError(error), phase);
}
