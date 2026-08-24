import { isDiagnosticError } from './errors.ts';
import {
  PROTOCOL_VERSION,
  type ExtensionMessage,
  type JobIdentity,
  type PageJobKey,
} from './messages.ts';
import { JOB_PHASES } from './state.ts';
import { parseSettings } from './settings.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPageJobKey(value: unknown): value is PageJobKey {
  return (
    isRecord(value) &&
    isNonEmptyString(value.jobId) &&
    isNonEmptyString(value.documentId) &&
    isNonEmptyString(value.fieldId)
  );
}

export function isJobIdentity(value: unknown): value is JobIdentity {
  return (
    isPageJobKey(value) &&
    'tabId' in value &&
    Number.isInteger(value.tabId) &&
    Number(value.tabId) >= 0 &&
    'frameId' in value &&
    Number.isInteger(value.frameId) &&
    Number(value.frameId) >= 0
  );
}

function hasProtocolEnvelope(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.protocolVersion === PROTOCOL_VERSION &&
    isNonEmptyString(value.type)
  );
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!hasProtocolEnvelope(value)) return false;

  switch (value.type) {
    case 'job.start':
      return isPageJobKey(value.origin) && parseSettings(value.settings).ok;
    case 'job.begin':
      return isJobIdentity(value.identity) && parseSettings(value.settings).ok;
    case 'job.accepted':
    case 'job.stop':
    case 'job.cancel':
      return isJobIdentity(value.identity);
    case 'job.progress':
      return (
        isJobIdentity(value.identity) &&
        JOB_PHASES.includes(value.phase as (typeof JOB_PHASES)[number]) &&
        (value.percent === undefined ||
          (typeof value.percent === 'number' && value.percent >= 0 && value.percent <= 100))
      );
    case 'job.audio-level':
      return (
        isJobIdentity(value.identity) &&
        typeof value.level === 'number' &&
        Number.isFinite(value.level) &&
        value.level >= 0 &&
        value.level <= 1
      );
    case 'job.result':
      return (
        isJobIdentity(value.identity) &&
        typeof value.rawText === 'string' &&
        typeof value.cleanText === 'string'
      );
    case 'job.error':
      return (
        isDiagnosticError(value.error) &&
        (value.identity === undefined || isJobIdentity(value.identity)) &&
        (value.origin === undefined || isPageJobKey(value.origin)) &&
        (value.identity !== undefined || value.origin !== undefined) &&
        (value.detail === undefined ||
          (typeof value.detail === 'string' && value.detail.length > 0 && value.detail.length <= 600))
      );
    case 'models.prepare':
    case 'models.load':
    case 'models.ready':
    case 'models.status-request':
    case 'models.inspect':
    case 'models.clear-request':
    case 'models.clear':
      return true;
    case 'models.progress':
      return (
        (value.model === 'speech recognition' || value.model === 'S1-mini') &&
        (value.percent === undefined ||
          (typeof value.percent === 'number' && value.percent >= 0 && value.percent <= 100)) &&
        ((value.loaded === undefined && value.total === undefined) ||
          (typeof value.loaded === 'number' &&
            Number.isFinite(value.loaded) &&
            value.loaded >= 0 &&
            typeof value.total === 'number' &&
            Number.isFinite(value.total) &&
            value.total >= value.loaded))
      );
    case 'models.error':
      return (
        isDiagnosticError(value.error) &&
        (value.detail === undefined ||
          (typeof value.detail === 'string' && value.detail.length > 0 && value.detail.length <= 600))
      );
    default:
      return false;
  }
}
