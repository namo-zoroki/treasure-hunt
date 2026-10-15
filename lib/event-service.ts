import type { SupabaseClient } from '@supabase/supabase-js';
import { calcEventNowMs } from './clock';

export interface EventStateRow {
  id: number;
  mode: 'test' | 'live';
  phase: 'setup' | 'r1_running' | 'r1_closed' | 'r2_running' | 'r2_break' | 'r3_open' | 'ended';
  paused_at: string | null;
  paused_total_ms: number;
  r1_end_ms: number | null;
  r2_start_ms: number | null;
  run2_open_ms: number | null;
  r2_hard_end_ms: number | null;
  break_end_ms: number | null;
}

export interface ClockInfo {
  serverNowMs: number;
  eventNowMs: number;
  paused: boolean;
  pausedAt: string | null;
  pausedTotalMs: number;
}

export type EventAction =
  | 'start-r1'
  | 'end-r1'
  | 'start-r2'
  | 'end-r2'
  | 'open-r3'
  | 'end-event'
  | 'pause'
  | 'resume'
  | 'add-time'
  | 'go-live'
  | 'reset';

/**
 * Helper to get a setting value as integer.
 */
async function getSettingNumber(client: SupabaseClient, key: string, fallback: number): Promise<number> {
  const { data } = await client.from('settings').select('value').eq('key', key).maybeSingle();
  if (!data || data.value === undefined || data.value === null) return fallback;
  const num = Number(data.value);
  return isNaN(num) ? fallback : num;
}

/**
 * Lazy evaluation function advance_event() (Section 4.3).
 * Must be called before every mutating RPC, on /api/state, and on admin dashboard polls.
 */
export async function advanceEvent(client: SupabaseClient): Promise<void> {
  // Try Postgres RPC first
  const { error } = await client.rpc('advance_event');
  if (!error) return;

  // Fallback to direct table queries if RPC is not deployed yet
  if (error.code === 'PGRST202') {
    const { data: state } = await client.from('event_state').select('*').eq('id', 1).single();
    if (!state) return;

    const wallNow = Date.now();
    const eventNow = calcEventNowMs(wallNow, state);

    // 1. If r1_running and event_now >= r1_end_ms: set r1_closed
    if (state.phase === 'r1_running' && state.r1_end_ms && eventNow >= state.r1_end_ms) {
      await client.from('event_state').update({ phase: 'r1_closed' }).eq('id', 1);
      state.phase = 'r1_closed';
    }

    // 2. If r2_running and event_now >= r2_hard_end_ms: set r2_break and break_end_ms
    if (state.phase === 'r2_running' && state.r2_hard_end_ms && eventNow >= state.r2_hard_end_ms) {
      const breakMin = await getSettingNumber(client, 'break_minutes', 3);
      const breakEndMs = state.r2_hard_end_ms + breakMin * 60000;
      await client.from('event_state').update({
        phase: 'r2_break',
        break_end_ms: breakEndMs,
      }).eq('id', 1);
      state.phase = 'r2_break';
      state.break_end_ms = breakEndMs;
    }

    // 3. If r2_running and event_now >= run2_open_ms: insert run 2 for qualified teams
    if (state.phase === 'r2_running' && state.run2_open_ms && eventNow >= state.run2_open_ms) {
      const capMin = await getSettingNumber(client, 'run_cap_minutes', 30);
      const capMs = capMin * 60000;
      const hardEnd = state.r2_hard_end_ms;

      const { data: teams } = await client
        .from('teams')
        .select('id')
        .eq('qualified', true)
        .eq('withdrawn', false);

      if (teams && teams.length > 0) {
        for (const team of teams) {
          const { data: existingRun } = await client
            .from('team_run')
            .select('run')
            .eq('team_id', team.id)
            .eq('run', 2)
            .maybeSingle();

          if (!existingRun) {
            const deadline = hardEnd && (state.run2_open_ms + capMs) > hardEnd
              ? hardEnd
              : state.run2_open_ms + capMs;

            await client.from('team_run').insert({
              team_id: team.id,
              run: 2,
              opens_ms: state.run2_open_ms,
              deadline_ms: deadline,
            });
          }
        }
      }
    }
  }
}

/**
 * Gets the current event state and clock information.
 */
export async function getEventStateAndClock(client: SupabaseClient): Promise<{
  state: EventStateRow;
  clock: ClockInfo;
}> {
  await advanceEvent(client);

  const { data: state, error } = await client
    .from('event_state')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !state) {
    throw new Error(`Failed to load event_state: ${error?.message || 'Not found'}`);
  }

  const serverNowMs = Date.now();
  const eventNowMs = calcEventNowMs(serverNowMs, state);

  return {
    state: state as EventStateRow,
    clock: {
      serverNowMs,
      eventNowMs,
      paused: !!state.paused_at,
      pausedAt: state.paused_at,
      pausedTotalMs: state.paused_total_ms,
    },
  };
}

/**
 * Executes an event action (RPC with fallback to client queries).
 */
export async function executeEventAction(
  client: SupabaseClient,
  action: EventAction,
  adminId: number | null,
  payload?: any
): Promise<{ ok: boolean; code?: string; message?: string; [key: string]: any }> {
  // 1. Try Postgres RPC
  const rpcMap: Record<EventAction, string> = {
    'start-r1': 'start_round1',
    'end-r1': 'end_round1',
    'start-r2': 'start_round2',
    'end-r2': 'end_round2',
    'open-r3': 'open_round3',
    'end-event': 'end_event',
    'pause': 'pause_event',
    'resume': 'resume_event',
    'add-time': 'add_time',
    'go-live': 'go_live',
    'reset': 'reset_event_data',
  };

  const rpcName = rpcMap[action];
  if (rpcName) {
    let rpcArgs: any = { p_admin_id: adminId };
    if (action === 'add-time') {
      rpcArgs = { p_admin_id: adminId, p_minutes: payload?.minutes };
    } else if (action === 'go-live') {
      rpcArgs = { p_admin_id: adminId, p_confirm: payload?.confirm };
    } else if (action === 'reset') {
      rpcArgs = { p_admin_id: adminId, p_confirm: payload?.confirm };
    }

    const { data, error } = await client.rpc(rpcName, rpcArgs);
    if (!error && data) {
      return data;
    }
    // If error is not PGRST202 (function not found), return the error
    if (error && error.code !== 'PGRST202') {
      return { ok: false, code: 'RPC_ERROR', message: error.message };
    }
  }

  // 2. Direct database execution fallback
  await advanceEvent(client);
  const { data: state } = await client.from('event_state').select('*').eq('id', 1).single();
  if (!state) return { ok: false, code: 'STATE_NOT_FOUND', message: 'event_state row missing' };

  const before = { ...state };
  const wallNow = Date.now();
  const eventNow = calcEventNowMs(wallNow, state);

  switch (action) {
    case 'start-r1': {
      if (state.phase !== 'setup') {
        return { ok: false, code: 'WRONG_PHASE', message: 'Can only start Round 1 from setup phase' };
      }
      const r1Minutes = await getSettingNumber(client, 'r1_minutes', 30);
      const r1EndMs = eventNow + r1Minutes * 60000;
      const { data: after } = await client
        .from('event_state')
        .update({ phase: 'r1_running', r1_end_ms: r1EndMs })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'start-r1',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, phase: 'r1_running', r1EndMs };
    }

    case 'end-r1': {
      if (state.phase !== 'r1_running') {
        return { ok: false, code: 'WRONG_PHASE', message: 'Can only end Round 1 while running' };
      }
      const { data: after } = await client
        .from('event_state')
        .update({ phase: 'r1_closed' })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'end-r1',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, phase: 'r1_closed' };
    }

    case 'start-r2': {
      if (state.phase !== 'r1_closed') {
        return { ok: false, code: 'WRONG_PHASE', message: 'Can only start Round 2 from r1_closed phase' };
      }
      const { data: qualifiedTeams } = await client
        .from('teams')
        .select('id')
        .eq('qualified', true)
        .eq('withdrawn', false);

      if (!qualifiedTeams || qualifiedTeams.length === 0) {
        return { ok: false, code: 'NO_QUALIFIED_TEAMS', message: 'At least 1 qualified team is required to start Round 2' };
      }

      const r2Minutes = await getSettingNumber(client, 'r2_minutes', 60);
      const capMinutes = await getSettingNumber(client, 'run_cap_minutes', 30);
      const r2StartMs = eventNow;
      const run2OpenMs = eventNow + capMinutes * 60000;
      const r2HardEndMs = eventNow + r2Minutes * 60000;

      const { data: after } = await client
        .from('event_state')
        .update({
          phase: 'r2_running',
          r2_start_ms: r2StartMs,
          run2_open_ms: run2OpenMs,
          r2_hard_end_ms: r2HardEndMs,
        })
        .eq('id', 1)
        .select()
        .single();

      const capMs = capMinutes * 60000;
      for (const team of qualifiedTeams) {
        const deadline = Math.min(eventNow + capMs, r2HardEndMs);
        await client.from('team_run').insert({
          team_id: team.id,
          run: 1,
          opens_ms: eventNow,
          deadline_ms: deadline,
        });
      }

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'start-r2',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, phase: 'r2_running', r2StartMs, r2HardEndMs };
    }

    case 'end-r2': {
      if (state.phase !== 'r2_running') {
        return { ok: false, code: 'WRONG_PHASE', message: 'Can only end Round 2 while running' };
      }
      const breakMinutes = await getSettingNumber(client, 'break_minutes', 3);
      const r2HardEndMs = eventNow;
      const breakEndMs = eventNow + breakMinutes * 60000;

      const { data: after } = await client
        .from('event_state')
        .update({
          phase: 'r2_break',
          r2_hard_end_ms: r2HardEndMs,
          break_end_ms: breakEndMs,
        })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'end-r2',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, phase: 'r2_break', breakEndMs };
    }

    case 'open-r3': {
      if (state.phase !== 'r2_break') {
        return { ok: false, code: 'WRONG_PHASE', message: 'Can only open Round 3 from r2_break phase' };
      }
      if (state.break_end_ms && eventNow < state.break_end_ms) {
        return { ok: false, code: 'BREAK_NOT_OVER', message: 'Break has not ended yet' };
      }

      const topNR3 = await getSettingNumber(client, 'top_n_r3', 5);

      const { data: after } = await client
        .from('event_state')
        .update({ phase: 'r3_open' })
        .eq('id', 1)
        .select()
        .single();

      // Set r3_eligible
      await client.from('teams').update({ r3_eligible: false }).neq('id', '');
      const { data: standings } = await client
        .from('r2_standings')
        .select('team_id, points, last_ms')
        .order('points', { ascending: false })
        .order('last_ms', { ascending: true, nullsFirst: false });

      if (standings && standings.length > 0) {
        // Calculate dense/rank ties
        let currentRank = 1;
        for (let i = 0; i < standings.length; i++) {
          if (i > 0) {
            const prev = standings[i - 1];
            const curr = standings[i];
            if (curr.points !== prev.points || curr.last_ms !== prev.last_ms) {
              currentRank = i + 1;
            }
          }
          if (currentRank <= topNR3) {
            await client.from('teams').update({ r3_eligible: true }).eq('id', standings[i].team_id);
          }
        }
      }

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'open-r3',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, phase: 'r3_open' };
    }

    case 'end-event': {
      if (state.phase !== 'r3_open') {
        return { ok: false, code: 'WRONG_PHASE', message: 'Can only end event from r3_open phase' };
      }
      const { data: after } = await client
        .from('event_state')
        .update({ phase: 'ended' })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'end-event',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, phase: 'ended' };
    }

    case 'pause': {
      if (!['r1_running', 'r2_running', 'r2_break', 'r3_open'].includes(state.phase)) {
        return { ok: false, code: 'WRONG_PHASE', message: 'Cannot pause in current phase' };
      }
      if (state.paused_at) {
        return { ok: true, already: true, paused: true };
      }

      const pauseDate = new Date().toISOString();
      const { data: after } = await client
        .from('event_state')
        .update({ paused_at: pauseDate })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'pause',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, paused: true, pausedAt: pauseDate };
    }

    case 'resume': {
      if (!state.paused_at) {
        return { ok: true, already: true, paused: false };
      }

      const pausedAtMs = new Date(state.paused_at).getTime();
      const delta = Math.max(0, wallNow - pausedAtMs);
      const newTotal = (state.paused_total_ms || 0) + delta;

      const { data: after } = await client
        .from('event_state')
        .update({
          paused_total_ms: newTotal,
          paused_at: null,
        })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'resume',
        target: 'event_state',
        before,
        after,
      });

      await advanceEvent(client);

      return { ok: true, paused: false, pausedTotalMs: newTotal };
    }

    case 'add-time': {
      const minutes = Number(payload?.minutes);
      if (!minutes || minutes <= 0) {
        return { ok: false, code: 'INVALID_PARAMS', message: 'Minutes must be greater than zero' };
      }

      const addMs = minutes * 60000;
      const newTotal = (state.paused_total_ms || 0) + addMs;

      const { data: after } = await client
        .from('event_state')
        .update({ paused_total_ms: newTotal })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'add-time',
        target: 'event_state',
        before,
        after,
      });

      await advanceEvent(client);

      return { ok: true, addedMinutes: minutes, pausedTotalMs: newTotal };
    }

    case 'go-live': {
      if (payload?.confirm !== 'LIVE') {
        return { ok: false, code: 'INVALID_CONFIRM', message: 'Confirmation text must be LIVE' };
      }
      if (state.mode === 'live') {
        return { ok: true, already: true, mode: 'live' };
      }

      const { data: after } = await client
        .from('event_state')
        .update({ mode: 'live' })
        .eq('id', 1)
        .select()
        .single();

      await client.from('admin_log').insert({
        admin_id: adminId,
        action: 'go-live',
        target: 'event_state',
        before,
        after,
      });

      return { ok: true, mode: 'live' };
    }

    case 'reset': {
      if (state.mode !== 'test') {
        return { ok: false, code: 'LIVE_MODE', message: 'Cannot reset data in live mode' };
      }
      if (payload?.confirm !== 'RESET') {
        return { ok: false, code: 'INVALID_CONFIRM', message: 'Confirmation text must be RESET' };
      }

      // Clear operational tables
      await client.from('registrations').delete().neq('id', 0);
      await client.from('piece_assignments').delete().neq('run', 0);
      await client.from('team_run').delete().neq('run', 0);
      await client.from('team_questions').delete().neq('run', 0);
      await client.from('attempts').delete().neq('id', 0);
      await client.from('score_adjustments').delete().neq('id', 0);
      await client.from('round3_claim').delete().neq('id', 0);

      // Reset event_state
      await client.from('event_state').update({
        phase: 'setup',
        paused_at: null,
        paused_total_ms: 0,
        r1_end_ms: null,
        r2_start_ms: null,
        run2_open_ms: null,
        r2_hard_end_ms: null,
        break_end_ms: null,
      }).eq('id', 1);

      // Reset teams and students
      await client.from('teams').update({
        qualified: false,
        r3_eligible: false,
        pw_wrong: 0,
        pw_blocked_until: null,
      }).neq('id', '');

      await client.from('students').update({
        absent: false,
        failed_logins: 0,
        locked_until: null,
      }).neq('id', '');

      return { ok: true };
    }

    default:
      return { ok: false, code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` };
  }
}

/**
 * Atomic registration for a QR scan (Section 6.1).
 */
export async function registerScan(
  client: SupabaseClient,
  studentId: string,
  token: string
): Promise<{
  ok: boolean;
  code?: string;
  message?: string;
  already?: boolean;
  run?: number;
  piece_no?: number;
  qr_name?: string;
  n?: number;
}> {
  // 1. Try Postgres RPC first
  const { data, error } = await client.rpc('register_scan', {
    p_student: studentId,
    p_token: token,
  });

  if (!error && data) {
    return data;
  }

  if (error && error.code !== 'PGRST202') {
    return { ok: false, code: 'RPC_ERROR', message: error.message };
  }

  // 2. Direct database execution fallback
  await advanceEvent(client);

  const { data: state } = await client.from('event_state').select('*').eq('id', 1).single();
  if (state?.paused_at) {
    return { ok: false, code: 'PAUSED', message: 'The event is paused. Hang tight.' };
  }
  if (state?.phase !== 'r2_running') {
    return { ok: false, code: 'WRONG_PHASE', message: 'That is not open right now.' };
  }

  // 1. Load student and team
  const { data: student } = await client
    .from('students')
    .select('id, name, absent, team_id')
    .eq('id', studentId)
    .single();

  if (!student) {
    return { ok: false, code: 'INVALID_LOGIN', message: 'Student ID or code is wrong.' };
  }
  if (student.absent) {
    return { ok: false, code: 'ABSENT', message: 'You are marked absent. Ask an organiser.' };
  }

  const { data: team } = await client
    .from('teams')
    .select('id, name, n, qualified, withdrawn')
    .eq('id', student.team_id)
    .single();

  if (!team || !team.qualified || team.withdrawn) {
    return { ok: false, code: 'NOT_IN_ROUND', message: 'Your team is not in this round.' };
  }

  // 2. Find QR by token
  const { data: qr } = await client
    .from('qr_locations')
    .select('id, name, token, capacity, active')
    .eq('token', token)
    .maybeSingle();

  if (!qr) {
    return { ok: false, code: 'INVALID_QR', message: 'This QR code is not valid.' };
  }
  if (!qr.active) {
    return { ok: false, code: 'QR_INACTIVE', message: 'This location is closed. Find another location.' };
  }

  // 3. Determine current run: highest run in team_run where opens_ms <= eventNow
  const wallNow = Date.now();
  const eventNow = calcEventNowMs(wallNow, state);

  const { data: runRows } = await client
    .from('team_run')
    .select('run, opens_ms, deadline_ms, finished_ms')
    .eq('team_id', team.id)
    .lte('opens_ms', eventNow)
    .order('run', { ascending: false })
    .limit(1);

  const currentRun = runRows?.[0];
  if (!currentRun || currentRun.finished_ms !== null || eventNow >= currentRun.deadline_ms) {
    return { ok: false, code: 'WRONG_PHASE', message: 'That is not open right now.' };
  }

  const runNo = currentRun.run;

  // 5. If this student already has a registration for this run
  const { data: studentReg } = await client
    .from('registrations')
    .select('qr_id')
    .eq('student_id', student.id)
    .eq('run', runNo)
    .maybeSingle();

  if (studentReg) {
    if (studentReg.qr_id === qr.id) {
      const { data: pa } = await client
        .from('piece_assignments')
        .select('piece_no')
        .eq('team_id', team.id)
        .eq('run', runNo)
        .eq('student_id', student.id)
        .maybeSingle();

      return {
        ok: true,
        already: true,
        run: runNo,
        piece_no: pa?.piece_no || 1,
        qr_name: qr.name,
        n: team.n,
      };
    } else {
      return { ok: false, code: 'ALREADY_REGISTERED', message: 'You are already registered for this run.' };
    }
  }

  // 6. If the team already has a registration at this QR for this run
  const { data: teamAtQr } = await client
    .from('registrations')
    .select('id')
    .eq('team_id', team.id)
    .eq('qr_id', qr.id)
    .eq('run', runNo)
    .maybeSingle();

  if (teamAtQr) {
    return { ok: false, code: 'TEAMMATE_HERE', message: 'A teammate already registered here. Find another location.' };
  }

  // 7. If this student has a registration at this QR in any run
  const { data: studentUsedBefore } = await client
    .from('registrations')
    .select('id')
    .eq('student_id', student.id)
    .eq('qr_id', qr.id)
    .maybeSingle();

  if (studentUsedBefore) {
    return { ok: false, code: 'QR_USED_BEFORE', message: 'You used this location before. Find another location.' };
  }

  // 8. If the team's piece assignments for this run already number N
  const { data: teamPieces } = await client
    .from('piece_assignments')
    .select('piece_no')
    .eq('team_id', team.id)
    .eq('run', runNo);

  if (teamPieces && teamPieces.length >= team.n) {
    return { ok: false, code: 'TEAM_COMPLETE', message: 'Your team is already complete.' };
  }

  // 9. If registrations at this QR for this run are at or above capacity
  const { data: qrRegs } = await client
    .from('registrations')
    .select('slot_no')
    .eq('qr_id', qr.id)
    .eq('run', runNo);

  if (qrRegs && qrRegs.length >= qr.capacity) {
    return { ok: false, code: 'QR_FULL', message: 'This location is full. Find another location.' };
  }

  // 10. Smallest free slot_no from 1 to capacity
  const occupiedSlots = new Set((qrRegs || []).map((r) => r.slot_no));
  let freeSlot: number | null = null;
  for (let s = 1; s <= qr.capacity; s++) {
    if (!occupiedSlots.has(s)) {
      freeSlot = s;
      break;
    }
  }
  if (!freeSlot) {
    return { ok: false, code: 'QR_FULL', message: 'This location is full. Find another location.' };
  }

  // Smallest free piece_no from 1 to N
  const occupiedPieces = new Set((teamPieces || []).map((p) => p.piece_no));
  let freePiece: number | null = null;
  for (let p = 1; p <= team.n; p++) {
    if (!occupiedPieces.has(p)) {
      freePiece = p;
      break;
    }
  }
  if (!freePiece) {
    return { ok: false, code: 'TEAM_COMPLETE', message: 'Your team is already complete.' };
  }

  // Insert registration and piece assignment
  const { error: regError } = await client.from('registrations').insert({
    run: runNo,
    team_id: team.id,
    student_id: student.id,
    qr_id: qr.id,
    slot_no: freeSlot,
    created_ms: eventNow,
  });

  if (regError) {
    if (regError.code === '23505' || regError.message?.includes('duplicate key value')) {
      const errStr = (regError.message + ' ' + ((regError as any).details || '')).toLowerCase();
      if (errStr.includes('team_id') || errStr.includes('teammate')) {
        return { ok: false, code: 'TEAMMATE_HERE', message: 'A teammate already registered here. Find another location.' };
      }
      if (errStr.includes('student_id') && errStr.includes('qr_id')) {
        return { ok: false, code: 'QR_USED_BEFORE', message: 'You used this location before. Find another location.' };
      }
      if (errStr.includes('student_id') && errStr.includes('run')) {
        return { ok: false, code: 'ALREADY_REGISTERED', message: 'You are already registered for this run.' };
      }
      return { ok: false, code: 'QR_FULL', message: 'This location is full. Find another location.' };
    }
    return { ok: false, code: 'DB_ERROR', message: regError.message };
  }

  await client.from('piece_assignments').insert({
    run: runNo,
    team_id: team.id,
    piece_no: freePiece,
    student_id: student.id,
    via: 'scan',
  });

  return {
    ok: true,
    run: runNo,
    piece_no: freePiece,
    qr_name: qr.name,
    n: team.n,
  };
}

