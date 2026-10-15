export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';
import { getEventStateAndClock } from '@/lib/event-service';

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  // advance_event is called inside getEventStateAndClock
  const { state, clock } = await getEventStateAndClock(db);

  // Teams overview
  const { data: teams } = await db
    .from('teams')
    .select('id, name, n, qualified, withdrawn, r3_eligible')
    .order('id');

  // Team runs
  const { data: teamRuns } = await db
    .from('team_run')
    .select('team_id, run, opens_ms, deadline_ms, teaser_done_ms, teaser_skipped, finished_ms');

  // QR locations & registrations count
  const { data: qrs } = await db
    .from('qr_locations')
    .select('id, name, capacity, active')
    .order('id');

  const { data: registrations } = await db
    .from('registrations')
    .select('qr_id, run');

  const qrCounts: Record<string, { run1: number; run2: number }> = {};
  if (qrs) {
    for (const qr of qrs) {
      qrCounts[qr.id] = { run1: 0, run2: 0 };
    }
  }
  if (registrations) {
    for (const reg of registrations) {
      if (qrCounts[reg.qr_id]) {
        if (reg.run === 1) qrCounts[reg.qr_id].run1++;
        if (reg.run === 2) qrCounts[reg.qr_id].run2++;
      }
    }
  }

  // Count qualified teams
  const qualifiedCount = teams?.filter(t => t.qualified && !t.withdrawn).length || 0;

  // Determine allowed phase transition action
  let primaryAction: { action: string; label: string; enabled: boolean; reason?: string } | null = null;

  switch (state.phase) {
    case 'setup':
      primaryAction = { action: 'start-r1', label: 'Start Round 1', enabled: true };
      break;
    case 'r1_running':
      primaryAction = { action: 'end-r1', label: 'End Round 1', enabled: true };
      break;
    case 'r1_closed':
      primaryAction = {
        action: 'start-r2',
        label: 'Start Round 2',
        enabled: qualifiedCount > 0,
        reason: qualifiedCount === 0 ? 'Need at least 1 qualified team' : undefined,
      };
      break;
    case 'r2_running':
      primaryAction = { action: 'end-r2', label: 'End Round 2', enabled: true };
      break;
    case 'r2_break':
      const breakOver = !state.break_end_ms || clock.eventNowMs >= state.break_end_ms;
      primaryAction = {
        action: 'open-r3',
        label: 'Open Round 3',
        enabled: breakOver,
        reason: !breakOver ? 'Break in progress' : undefined,
      };
      break;
    case 'r3_open':
      primaryAction = { action: 'end-event', label: 'End Event', enabled: true };
      break;
    case 'ended':
      primaryAction = null;
      break;
  }

  return NextResponse.json({
    ok: true,
    clock,
    state: {
      mode: state.mode,
      phase: state.phase,
      pausedAt: state.paused_at,
      pausedTotalMs: state.paused_total_ms,
      r1EndMs: state.r1_end_ms,
      r2StartMs: state.r2_start_ms,
      run2OpenMs: state.run2_open_ms,
      r2HardEndMs: state.r2_hard_end_ms,
      breakEndMs: state.break_end_ms,
    },
    primaryAction,
    stats: {
      totalTeams: teams?.length || 0,
      qualifiedTeams: qualifiedCount,
      activeQRs: qrs?.filter(q => q.active).length || 0,
    },
    teams: (teams || []).map(t => {
      const runs = (teamRuns || []).filter(r => r.team_id === t.id);
      return {
        ...t,
        runs,
      };
    }),
    qrs: (qrs || []).map(q => ({
      ...q,
      run1Count: qrCounts[q.id]?.run1 || 0,
      run2Count: qrCounts[q.id]?.run2 || 0,
    })),
  });
}
