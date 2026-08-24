export const SETTINGS_SCHEMA_VERSION = 1 as const;

export const STYLING_VALUES = ['casual', 'semi-casual', 'semi-formal', 'formal'] as const;
export const STRUCTURE_VALUES = ['prose', 'lists'] as const;
export const CONTEXT_VALUES = ['general', 'email'] as const;
export const DICTATION_MODE_VALUES = ['clean', 'raw'] as const;

export type Styling = (typeof STYLING_VALUES)[number];
export type Structure = (typeof STRUCTURE_VALUES)[number];
export type DictationContext = (typeof CONTEXT_VALUES)[number];
export type DictationMode = (typeof DICTATION_MODE_VALUES)[number];

export interface DictationSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION;
  mode: DictationMode;
  styling: Styling;
  structure: Structure;
  context: DictationContext;
}

export const DEFAULT_SETTINGS: Readonly<DictationSettings> = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  mode: 'clean',
  styling: 'semi-formal',
  structure: 'prose',
  context: 'general',
});

export type SettingsParseResult =
  | { ok: true; value: DictationSettings }
  | { ok: false; issues: readonly string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMember<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

export function parseSettings(value: unknown): SettingsParseResult {
  if (!isRecord(value)) {
    return { ok: false, issues: ['settings must be an object'] };
  }

  const issues: string[] = [];
  if (value.schemaVersion !== SETTINGS_SCHEMA_VERSION) issues.push('unsupported schemaVersion');
  if (!isMember(DICTATION_MODE_VALUES, value.mode)) issues.push('invalid mode');
  if (!isMember(STYLING_VALUES, value.styling)) issues.push('invalid styling');
  if (!isMember(STRUCTURE_VALUES, value.structure)) issues.push('invalid structure');
  if (!isMember(CONTEXT_VALUES, value.context)) issues.push('invalid context');

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      mode: value.mode as DictationMode,
      styling: value.styling as Styling,
      structure: value.structure as Structure,
      context: value.context as DictationContext,
    },
  };
}

export function migrateSettings(value: unknown): SettingsParseResult {
  if (value === undefined || value === null) {
    return { ok: true, value: { ...DEFAULT_SETTINGS } };
  }

  if (isRecord(value) && value.schemaVersion === undefined) {
    return parseSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, ...value });
  }

  return parseSettings(value);
}
