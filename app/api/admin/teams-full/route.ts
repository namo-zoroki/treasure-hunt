export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const [{ data: teams }, { data: students }] = await Promise.all([
    db.from('teams').select('id, name, n, qualified, withdrawn, r3_eligible').order('id'),
    db
      .from('students')
      .select('id, name, team_id, is_captain, absent, failed_logins, locked_until')
      .order('team_id')
      .order('name'),
  ]);

  const membersByTeam: Record<string, typeof students> = {};
  for (const s of students || []) {
    if (!membersByTeam[s.team_id]) membersByTeam[s.team_id] = [];
    membersByTeam[s.team_id]!.push(s);
  }

  return NextResponse.json({
    ok: true,
    teams: (teams || []).map((t) => ({
      id: t.id,
      name: t.name,
      n: t.n,
      qualified: t.qualified,
      withdrawn: t.withdrawn,
      r3Eligible: t.r3_eligible,
      members: (membersByTeam[t.id] || []).map((s) => ({
        id: s.id,
        name: s.name,
        isCaptain: s.is_captain,
        absent: s.absent,
        failedLogins: s.failed_logins,
        lockedUntil: s.locked_until,
      })),
    })),
  });
}
