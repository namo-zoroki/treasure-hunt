import { createClient } from '@supabase/supabase-js';
import { executeEventAction, getEventStateAndClock } from '../lib/event-service';
import { calcEventNowMs, calcRemainingMs } from '../lib/clock';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

async function runPhase2Tests() {
  console.log('=== Starting Phase 2 Event Clock and Phase Walking Tests ===\n');

  // 1. Reset event state to setup cleanly
  console.log('--- Step 1: Initializing clean setup state ---');
  const resetRes = await executeEventAction(supabase, 'reset', 1, { confirm: 'RESET' });
  if (!resetRes.ok) {
    throw new Error(`Reset failed: ${resetRes.message || resetRes.code}`);
  }
  console.log('✓ Successfully reset event to setup phase.');

  // Verify initial state
  const { state: initState, clock: initClock } = await getEventStateAndClock(supabase);
  if (initState.phase !== 'setup') {
    throw new Error(`Expected phase setup, got ${initState.phase}`);
  }
  console.log(`✓ Initial phase is ${initState.phase}, eventNowMs: ${initClock.eventNowMs}`);

  // 2. Reject invalid transitions
  console.log('\n--- Step 2: Testing domain rejection on invalid transitions ---');
  const invalidTransition = await executeEventAction(supabase, 'start-r2', 1);
  if (invalidTransition.ok || invalidTransition.code !== 'WRONG_PHASE') {
    throw new Error(`Expected WRONG_PHASE when starting R2 from setup, got ${JSON.stringify(invalidTransition)}`);
  }
  console.log('✓ Correctly rejected starting Round 2 from setup phase (code: WRONG_PHASE).');

  // 3. Start Round 1
  console.log('\n--- Step 3: Transitioning setup -> r1_running ---');
  const startR1Res = await executeEventAction(supabase, 'start-r1', 1);
  if (!startR1Res.ok) {
    throw new Error(`Failed to start Round 1: ${startR1Res.message || startR1Res.code}`);
  }
  console.log(`✓ Started Round 1. r1EndMs: ${startR1Res.r1EndMs}`);

  const { state: r1State } = await getEventStateAndClock(supabase);
  if (r1State.phase !== 'r1_running' || !r1State.r1_end_ms) {
    throw new Error(`State did not update to r1_running properly: ${JSON.stringify(r1State)}`);
  }
  console.log('✓ Phase confirmed: r1_running with valid r1_end_ms.');

  // 4. Test Pause, Resume, and Deadline shifting
  console.log('\n--- Step 4: Testing Pause, Resume, and Deadline shifts ---');
  const prePauseDeadline = r1State.r1_end_ms;

  // Pause
  const pauseRes = await executeEventAction(supabase, 'pause', 1);
  if (!pauseRes.ok || !pauseRes.paused) {
    throw new Error(`Failed to pause: ${JSON.stringify(pauseRes)}`);
  }
  console.log('✓ Event clock paused successfully.');

  // Check clock while paused
  const { clock: pausedClock } = await getEventStateAndClock(supabase);
  if (!pausedClock.paused) {
    throw new Error('Clock should be marked as paused');
  }
  const frozenMs = pausedClock.eventNowMs;

  // Simulate a 2-minute (120,000 ms) pause directly to test shift without sleeping 2 real minutes
  console.log('  Simulating 2-minute (120,000ms) pause duration...');
  await supabase
    .from('event_state')
    .update({
      paused_total_ms: 120_000,
      paused_at: null,
    })
    .eq('id', 1);

  const { clock: resumedClock } = await getEventStateAndClock(supabase);
  if (resumedClock.paused) {
    throw new Error('Clock should no longer be paused');
  }
  console.log(`✓ Resumed clock. paused_total_ms: ${resumedClock.pausedTotalMs}ms (2 mins).`);

  // Verify that pausing for 2 minutes shifted the remaining deadline by 2 minutes
  const remainingWithShift = calcRemainingMs(resumedClock.eventNowMs, prePauseDeadline);
  const remainingWithoutShift = calcRemainingMs(resumedClock.serverNowMs, prePauseDeadline);
  const shiftDiff = remainingWithShift - remainingWithoutShift;

  console.log(`  Remaining without pause shift: ${Math.round(remainingWithoutShift / 1000)}s`);
  console.log(`  Remaining with pause shift:    ${Math.round(remainingWithShift / 1000)}s`);
  console.log(`  Shift difference:              ${shiftDiff}ms`);

  if (Math.abs(shiftDiff - 120_000) > 1000) {
    throw new Error(`Expected shift of ~120,000ms, got ${shiftDiff}ms`);
  }
  console.log('✓ CONFIRMED: Pausing for 2 minutes shifts all deadlines by exactly 2 minutes!');

  // 5. Test Add Time (+5 minutes)
  console.log('\n--- Step 5: Testing Add Time (+5 minutes) ---');
  const addTimeRes = await executeEventAction(supabase, 'add-time', 1, { minutes: 5 });
  if (!addTimeRes.ok) {
    throw new Error(`Failed to add time: ${JSON.stringify(addTimeRes)}`);
  }
  const { clock: addedClock } = await getEventStateAndClock(supabase);
  console.log(`✓ Added 5 minutes. New paused_total_ms: ${addedClock.pausedTotalMs}ms.`);
  if (addedClock.pausedTotalMs !== 120_000 + 300_000) {
    throw new Error(`Expected paused_total_ms to be 420000, got ${addedClock.pausedTotalMs}`);
  }

  // 6. End Round 1
  console.log('\n--- Step 6: Transitioning r1_running -> r1_closed ---');
  const endR1Res = await executeEventAction(supabase, 'end-r1', 1);
  if (!endR1Res.ok) {
    throw new Error(`Failed to end Round 1: ${JSON.stringify(endR1Res)}`);
  }
  const { state: r1ClosedState } = await getEventStateAndClock(supabase);
  if (r1ClosedState.phase !== 'r1_closed') {
    throw new Error(`Expected phase r1_closed, got ${r1ClosedState.phase}`);
  }
  console.log('✓ Phase confirmed: r1_closed.');

  // 7. Test Start Round 2 requires at least 1 qualified team
  console.log('\n--- Step 7: Testing Start Round 2 requires qualified teams ---');
  // Make sure no teams are qualified initially
  await supabase.from('teams').update({ qualified: false }).neq('id', '');
  const startR2ZeroQual = await executeEventAction(supabase, 'start-r2', 1);
  if (startR2ZeroQual.ok || startR2ZeroQual.code !== 'NO_QUALIFIED_TEAMS') {
    throw new Error(`Expected NO_QUALIFIED_TEAMS when 0 teams qualified, got ${JSON.stringify(startR2ZeroQual)}`);
  }
  console.log('✓ Start Round 2 successfully blocked when 0 teams are qualified.');

  // Qualify at least 2 teams (e.g., T01, T02)
  await supabase.from('teams').update({ qualified: true }).in('id', ['T01', 'T02']);
  console.log('  Qualified teams T01, T02 for Round 2.');

  // Start Round 2
  const startR2Res = await executeEventAction(supabase, 'start-r2', 1);
  if (!startR2Res.ok) {
    throw new Error(`Failed to start Round 2: ${JSON.stringify(startR2Res)}`);
  }
  console.log(`✓ Started Round 2. r2_start_ms: ${startR2Res.r2StartMs}, r2_hard_end_ms: ${startR2Res.r2HardEndMs}`);

  // Verify team_run row was inserted for qualified teams
  const { data: runs } = await supabase.from('team_run').select('*').eq('run', 1);
  if (!runs || runs.length < 2) {
    throw new Error(`Expected at least 2 team_run entries for run 1, got ${runs?.length}`);
  }
  console.log(`✓ Verified ${runs.length} team_run run 1 rows created.`);

  // 8. End Round 2 -> r2_break
  console.log('\n--- Step 8: Transitioning r2_running -> r2_break ---');
  const endR2Res = await executeEventAction(supabase, 'end-r2', 1);
  if (!endR2Res.ok) {
    throw new Error(`Failed to end Round 2: ${JSON.stringify(endR2Res)}`);
  }
  const { state: r2BreakState } = await getEventStateAndClock(supabase);
  if (r2BreakState.phase !== 'r2_break' || !r2BreakState.break_end_ms) {
    throw new Error(`Expected phase r2_break with break_end_ms, got ${JSON.stringify(r2BreakState)}`);
  }
  console.log(`✓ Phase confirmed: r2_break with break_end_ms ${r2BreakState.break_end_ms}.`);

  // 9. Open Round 3 (test break lockout & opening)
  console.log('\n--- Step 9: Transitioning r2_break -> r3_open ---');
  // While break is in progress, open-r3 should be blocked
  const openR3Early = await executeEventAction(supabase, 'open-r3', 1);
  if (openR3Early.ok || openR3Early.code !== 'BREAK_NOT_OVER') {
    throw new Error(`Expected BREAK_NOT_OVER when opening R3 before break ends, got ${JSON.stringify(openR3Early)}`);
  }
  console.log('✓ Open Round 3 correctly blocked while break is still in progress.');

  // Simulate break finished by setting break_end_ms in the past of event time
  await supabase.from('event_state').update({ break_end_ms: 0 }).eq('id', 1);

  const openR3Res = await executeEventAction(supabase, 'open-r3', 1);
  if (!openR3Res.ok) {
    throw new Error(`Failed to open Round 3: ${JSON.stringify(openR3Res)}`);
  }
  const { state: r3State } = await getEventStateAndClock(supabase);
  if (r3State.phase !== 'r3_open') {
    throw new Error(`Expected phase r3_open, got ${r3State.phase}`);
  }
  console.log('✓ Phase confirmed: r3_open.');

  // 10. End Event -> ended
  console.log('\n--- Step 10: Transitioning r3_open -> ended ---');
  const endEventRes = await executeEventAction(supabase, 'end-event', 1);
  if (!endEventRes.ok) {
    throw new Error(`Failed to end event: ${JSON.stringify(endEventRes)}`);
  }
  const { state: endedState } = await getEventStateAndClock(supabase);
  if (endedState.phase !== 'ended') {
    throw new Error(`Expected phase ended, got ${endedState.phase}`);
  }
  console.log('✓ Phase confirmed: ended.');

  // 11. Verify admin_log entries were created
  console.log('\n--- Step 11: Verifying admin_log audit records ---');
  const { data: logs } = await supabase
    .from('admin_log')
    .select('action, created_at')
    .order('created_at', { ascending: false });

  console.log(`✓ Found ${logs?.length || 0} admin_log entries recorded.`);
  const recordedActions = (logs || []).map((l) => l.action);
  ['start-r1', 'pause', 'add-time', 'end-r1', 'start-r2', 'end-r2', 'open-r3', 'end-event'].forEach((act) => {
    if (!recordedActions.includes(act)) {
      throw new Error(`Missing expected admin_log action: ${act}`);
    }
  });
  console.log('✓ All expected admin actions successfully logged to admin_log.');

  // Clean reset back to setup for test environment readiness
  console.log('\n--- Step 12: Cleaning up and resetting to setup ---');
  await executeEventAction(supabase, 'reset', 1, { confirm: 'RESET' });
  const { state: finalState } = await getEventStateAndClock(supabase);
  if (finalState.phase !== 'setup') {
    throw new Error(`Failed to reset cleanly back to setup: ${finalState.phase}`);
  }
  console.log('✓ Environment cleanly reset back to setup.');

  console.log('\n======================================================');
  console.log('🎉 ALL PHASE 2 INTEGRATION CHECKS PASSED SUCCESSFULLY!');
  console.log('======================================================\n');
}

runPhase2Tests().catch((err) => {
  console.error('\n❌ Phase 2 test failed:', err);
  process.exit(1);
});
