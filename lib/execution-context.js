export function assertHumanRecoveryContext() {
  if (process.env.RECOVERABLE_DELETE_CONTEXT === 'agent' || process.env.DSH_SHELL === '1') {
    const error = new Error('Recovery mutations must run from the human DSH-Recovery menu outside the agent shell. No recovery target was written.');
    error.code = 'RECOVERY_HUMAN_REQUIRED';
    throw error;
  }
}
