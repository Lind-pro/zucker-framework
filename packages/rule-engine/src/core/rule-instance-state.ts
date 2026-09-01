/**
 * Rule instance lifecycle states — mirrors jetlinks RuleInstanceState.
 */
export enum RuleInstanceState {
  /** Rule is started and actively processing. */
  STARTED = 'started',
  /** Rule is disabled / stopped. */
  DISABLED = 'disabled',
  /** Rule is paused (can be resumed without re-init). */
  PAUSED = 'paused',
}
