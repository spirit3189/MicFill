import type { DiagnosticError } from './errors.ts';
import type { DictationSettings } from './settings.ts';
import type { JobPhase } from './state.ts';

export const PROTOCOL_VERSION = 1 as const;

export interface PageJobKey {
  jobId: string;
  documentId: string;
  fieldId: string;
}

export interface JobIdentity extends PageJobKey {
  tabId: number;
  frameId: number;
}

interface ProtocolMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface StartJobMessage extends ProtocolMessage {
  type: 'job.start';
  origin: PageJobKey;
  settings: DictationSettings;
}

export interface AcceptedJobMessage extends ProtocolMessage {
  type: 'job.accepted';
  identity: JobIdentity;
}

export interface BeginJobMessage extends ProtocolMessage {
  type: 'job.begin';
  identity: JobIdentity;
  settings: DictationSettings;
}

export interface StopJobMessage extends ProtocolMessage {
  type: 'job.stop';
  identity: JobIdentity;
}

export interface CancelJobMessage extends ProtocolMessage {
  type: 'job.cancel';
  identity: JobIdentity;
}

export interface JobProgressMessage extends ProtocolMessage {
  type: 'job.progress';
  identity: JobIdentity;
  phase: JobPhase;
  percent?: number;
}

export interface JobAudioLevelMessage extends ProtocolMessage {
  type: 'job.audio-level';
  identity: JobIdentity;
  level: number;
}

export interface JobResultMessage extends ProtocolMessage {
  type: 'job.result';
  identity: JobIdentity;
  rawText: string;
  cleanText: string;
}

export interface JobErrorMessage extends ProtocolMessage {
  type: 'job.error';
  identity?: JobIdentity;
  origin?: PageJobKey;
  error: DiagnosticError;
  detail?: string;
}

export interface PrepareModelsMessage extends ProtocolMessage {
  type: 'models.prepare';
}

export interface LoadModelsMessage extends ProtocolMessage {
  type: 'models.load';
}

export interface ModelProgressMessage extends ProtocolMessage {
  type: 'models.progress';
  model: 'speech recognition' | 'S1-mini';
  percent?: number;
  loaded?: number;
  total?: number;
}

export interface ModelsReadyMessage extends ProtocolMessage {
  type: 'models.ready';
}

export interface ModelsErrorMessage extends ProtocolMessage {
  type: 'models.error';
  error: DiagnosticError;
  detail?: string;
}

export interface ModelCacheStatus {
  model: 'speech recognition' | 'S1-mini';
  modelId: string;
  cached: boolean;
  totalBytes: number;
  cachedFiles: number;
  totalFiles: number;
}

export interface ModelsStatusRequestMessage extends ProtocolMessage {
  type: 'models.status-request';
}

export interface ModelsInspectMessage extends ProtocolMessage {
  type: 'models.inspect';
}

export interface ModelsClearRequestMessage extends ProtocolMessage {
  type: 'models.clear-request';
}

export interface ModelsClearMessage extends ProtocolMessage {
  type: 'models.clear';
}

export type ExtensionMessage =
  | StartJobMessage
  | BeginJobMessage
  | AcceptedJobMessage
  | StopJobMessage
  | CancelJobMessage
  | JobProgressMessage
  | JobAudioLevelMessage
  | JobResultMessage
  | JobErrorMessage
  | PrepareModelsMessage
  | LoadModelsMessage
  | ModelProgressMessage
  | ModelsReadyMessage
  | ModelsErrorMessage
  | ModelsStatusRequestMessage
  | ModelsInspectMessage
  | ModelsClearRequestMessage
  | ModelsClearMessage;
