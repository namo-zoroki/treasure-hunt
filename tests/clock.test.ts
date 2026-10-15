import { describe, it, expect } from 'vitest';
import { calcEventNowMs, calcRemainingMs } from '../lib/clock';

describe('Event Clock Formula (Section 4.1 & Section 13.6)', () => {
  const baseTime = 1_700_000_000_000; // arbitrary reference timestamp (ms)

  it('calculates unpaused event clock matching wall clock exactly', () => {
    const state = { paused_at: null, paused_total_ms: 0 };
    expect(calcEventNowMs(baseTime, state)).toBe(baseTime);
    expect(calcEventNowMs(baseTime + 5000, state)).toBe(baseTime + 5000);
  });

  it('accounts for previously accumulated pause duration', () => {
    // 2 minutes (120,000 ms) previously paused
    const state = { paused_at: null, paused_total_ms: 120_000 };
    expect(calcEventNowMs(baseTime, state)).toBe(baseTime - 120_000);
    expect(calcEventNowMs(baseTime + 60_000, state)).toBe(baseTime - 60_000);
  });

  it('freezes event clock completely while actively paused', () => {
    const pauseStart = baseTime + 10_000;
    const state = {
      paused_at: new Date(pauseStart).toISOString(),
      paused_total_ms: 0,
    };

    // At exact moment of pause
    const frozenAt = calcEventNowMs(pauseStart, state);
    expect(frozenAt).toBe(pauseStart);

    // 10 seconds later in wall clock time, event clock MUST be identical
    expect(calcEventNowMs(pauseStart + 10_000, state)).toBe(frozenAt);

    // 2 minutes later in wall clock time, event clock MUST STILL be identical
    expect(calcEventNowMs(pauseStart + 120_000, state)).toBe(frozenAt);

    // 1 hour later, still frozen
    expect(calcEventNowMs(pauseStart + 3_600_000, state)).toBe(frozenAt);
  });

  it('maintains continuous event time when resumed after a 2-minute pause', () => {
    const pauseStart = baseTime + 30_000;
    const pauseDuration = 120_000; // 2 minutes
    const resumeTime = pauseStart + pauseDuration;

    // While paused:
    const pausedState = {
      paused_at: new Date(pauseStart).toISOString(),
      paused_total_ms: 0,
    };
    const frozenEventNow = calcEventNowMs(pauseStart + 60_000, pausedState);
    expect(frozenEventNow).toBe(pauseStart);

    // At resume:
    const resumedState = {
      paused_at: null,
      paused_total_ms: 0 + pauseDuration,
    };

    // At the exact millisecond of resume:
    expect(calcEventNowMs(resumeTime, resumedState)).toBe(frozenEventNow);

    // 10 seconds after resume:
    expect(calcEventNowMs(resumeTime + 10_000, resumedState)).toBe(frozenEventNow + 10_000);
  });

  it('verifies that pausing for 2 minutes shifts all deadlines by 2 minutes in wall clock', () => {
    const r1StartWall = baseTime;
    const r1Duration = 30 * 60 * 1000; // 30 mins
    const r1Deadline = r1StartWall + r1Duration; // stored in event time

    // Scenario A: No pause
    // When wall clock reaches r1StartWall + 30 mins, remaining time is 0
    const noPauseState = { paused_at: null, paused_total_ms: 0 };
    expect(calcRemainingMs(calcEventNowMs(r1StartWall + r1Duration, noPauseState), r1Deadline)).toBe(0);

    // Scenario B: Paused for 2 minutes (120,000 ms) midway through
    const pauseDuration = 120_000;
    const resumedState = { paused_at: null, paused_total_ms: pauseDuration };

    // At original deadline wall time (r1StartWall + 30 min):
    // 2 minutes should still remain!
    const eventNowAtOldWallDeadline = calcEventNowMs(r1StartWall + r1Duration, resumedState);
    expect(calcRemainingMs(eventNowAtOldWallDeadline, r1Deadline)).toBe(pauseDuration);

    // The new wall-clock time when deadline hits is exactly 2 minutes later:
    const eventNowAtNewWallDeadline = calcEventNowMs(r1StartWall + r1Duration + pauseDuration, resumedState);
    expect(calcRemainingMs(eventNowAtNewWallDeadline, r1Deadline)).toBe(0);
  });

  it('add_time(X) pushes all deadlines later by X minutes', () => {
    const deadline = baseTime + 10 * 60 * 1000; // 10 minutes from baseTime
    const normalState = { paused_at: null, paused_total_ms: 0 };

    // At baseTime, 10 minutes remaining
    expect(calcRemainingMs(calcEventNowMs(baseTime, normalState), deadline)).toBe(10 * 60 * 1000);

    // Admin adds 5 minutes (paused_total_ms increases by 5 * 60 * 1000)
    const addedTimeState = { paused_at: null, paused_total_ms: 5 * 60 * 1000 };

    // At baseTime, remaining event time has increased to 15 minutes!
    expect(calcRemainingMs(calcEventNowMs(baseTime, addedTimeState), deadline)).toBe(15 * 60 * 1000);

    // In wall clock time, the deadline is now reached 5 minutes later:
    const wallTimeOldDeadline = baseTime + 10 * 60 * 1000;
    expect(calcRemainingMs(calcEventNowMs(wallTimeOldDeadline, addedTimeState), deadline)).toBe(5 * 60 * 1000);

    const wallTimeNewDeadline = baseTime + 15 * 60 * 1000;
    expect(calcRemainingMs(calcEventNowMs(wallTimeNewDeadline, addedTimeState), deadline)).toBe(0);
  });
});
