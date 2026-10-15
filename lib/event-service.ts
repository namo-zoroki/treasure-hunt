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
 * Lazy evaluation function advance_event() (Section 4.3), run in Postgres.
 * Called before every mutating RPC, on /api/state, and on admin dashboard polls.
 */
export async function advanceEvent(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc('advance_event');
  if (error) {
    throw new Error(`advance_event failed (${error.code}): ${error.message}. Have the SQL migrations been run?`);
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

  return { ok: false, code: 'RPC_ERROR', message: `Database function missing for "${action}". Run the SQL migrations in supabase/migrations.` };
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

  return { ok: false, code: 'RPC_ERROR', message: 'register_scan is missing in the database. Run the SQL migrations.' };
}
