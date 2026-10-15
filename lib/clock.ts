export interface EventClockState {
  paused_at: string | null;
  paused_total_ms: number;
}

/**
 * Pure calculation of the event clock in milliseconds, implementing Section 4.1:
 * event_now_ms = (epoch_ms(now()) - paused_total_ms) - (paused_at is null ? 0 : epoch_ms(now()) - epoch_ms(paused_at))
 *
 * When paused, event_now_ms is completely frozen at (paused_at - paused_total_ms).
 * When resumed, paused_total_ms increases by the paused duration and paused_at becomes null,
 * smoothly continuing from the frozen timestamp.
 */
export function calcEventNowMs(
  wallNowMs: number,
  state: { paused_at: string | null; paused_total_ms: number }
): number {
  const pausedAtMs = state.paused_at ? new Date(state.paused_at).getTime() : null;
  const currentPauseDuration = pausedAtMs === null ? 0 : Math.max(0, wallNowMs - pausedAtMs);
  return wallNowMs - state.paused_total_ms - currentPauseDuration;
}

/**
 * Calculates remaining event time until a given event-time deadline.
 * Returns 0 if already passed.
 */
export function calcRemainingMs(eventNowMs: number, deadlineEventMs: number | null | undefined): number {
  if (deadlineEventMs === null || deadlineEventMs === undefined) return 0;
  return Math.max(0, deadlineEventMs - eventNowMs);
}
