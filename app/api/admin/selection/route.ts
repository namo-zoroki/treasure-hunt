export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  // 1. Get event phase and top_n_r2 setting
  const [{ data: eventState }, { data: settingRow }, { data: standings }, { data: teams }] = await Promise.all([
    db.from('event_state').select('phase').eq('id', 1).single(),
    db.from('settings').select('value').eq('key', 'top_n_r2').single(),
    db.from('r1_standings').select('team_id, points, last_ms'),
    db.from('teams').select('id, name, n, qualified, withdrawn').order('id'),
  ]);

  const topN = settingRow?.value ? Number(settingRow.value) : 25;
  const phase = eventState?.phase || 'setup';

  // 2. Rank teams per Section 5 view ordering: points desc, last_ms asc nulls last
  const teamMap = new Map((teams || []).map((t) => [t.id, t]));
  const standingsRows = (standings || []).map((s) => ({
    teamId: s.team_id,
    name: teamMap.get(s.team_id)?.name || s.team_id,
    n: teamMap.get(s.team_id)?.n || 4,
    points: s.points,
    lastMs: s.last_ms,
    qualified: !!teamMap.get(s.team_id)?.qualified,
    withdrawn: !!teamMap.get(s.team_id)?.withdrawn,
  }));

  standingsRows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const aMs = a.lastMs ?? Number.MAX_SAFE_INTEGER;
    const bMs = b.lastMs ?? Number.MAX_SAFE_INTEGER;
    return aMs - bMs;
  });

  // Calculate ranks with ties
  let currentRank = 1;
  const ranked = standingsRows.map((row, i) => {
    if (i > 0) {
      const prev = standingsRows[i - 1];
      const same = prev.points === row.points && prev.lastMs === row.lastMs;
      if (!same) {
        currentRank = i + 1;
      }
    }
    return {
      rank: currentRank,
      ...row,
    };
  });

  return NextResponse.json({
    ok: true,
    phase,
    topN,
    teams: ranked,
  });
}

const toggleSchema = z.object({
  teamId: z.string().min(1),
  qualified: z.boolean(),
});

export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const parsed = toggleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Invalid request' }, { status: 400 });
  }

  const { teamId, qualified } = parsed.data;
  const { data, error } = await db.rpc('set_qualified', {
    p_team: teamId,
    p_qualified: qualified,
    p_admin_id: session.aid,
  });

  if (error) {
    return NextResponse.json({ ok: false, code: 'RPC_ERROR', message: error.message }, { status: 200 });
  }

  return NextResponse.json(data);
}
