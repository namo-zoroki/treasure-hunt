export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));
  const offset = (page - 1) * limit;

  const { data: logs, error, count } = await db
    .from('admin_log')
    .select('id, admin_id, action, target, before, after, created_at, admins(username)', { count: 'exact' })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  return NextResponse.json({
    ok: true,
    logs: (logs || []).map((l: any) => ({
      id: l.id,
      adminId: l.admin_id,
      adminUsername: l.admins?.username ?? null,
      action: l.action,
      target: l.target,
      before: l.before,
      after: l.after,
      createdAt: l.created_at,
    })),
    total: count ?? 0,
    page,
    limit,
  });
}
