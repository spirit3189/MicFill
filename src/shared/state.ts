export const JOB_PHASES = [
  'idle',
  'preparing',
  'ready',
  'recording',
  'resampling',
  'transcribing',
  'rewriting',
  'inserting',
  'completed',
  'cancelled',
  'failed',
  'target-invalidated',
] as const;

export type JobPhase = (typeof JOB_PHASES)[number];
