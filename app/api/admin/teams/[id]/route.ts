export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

const patchSchema = z.object({
  n: z.number().int().min(3).max(5).optional(),
  withdrawn: z.boolean().optional(),
  qualified: z.boolean().optional(),
}).refine((d) => d.n !== undefined || d.withdrawn !== undefined || d.qualified !== undefined, {
  message: 'At least one of n, withdrawn, or qualified is required',
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { id: teamId } = await params;

  let body: unknown = {};
  const text = await request.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message || 'Validation failed' },
      { status: 400 }
    );
  }

  const { n, withdrawn, qualified } = parsed.data;

  // Handle n (team size) change via RPC
  if (n !== undefined) {
    const { data, error } = await db.rpc('edit_team_n', {
      p_team: teamId,
      p_n: n,
      p_admin_id: session.aid,
    });
    if (error || !data) {
      return NextResponse.json({ ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to update team size' });
    }
    const result = data as { ok: boolean; code?: string; message?: string };
    if (!result.ok) return NextResponse.json(result);
  }

  // Handle withdrawn status change — direct update + admin_log
  if (withdrawn !== undefined) {
    const { data: team } = await db.from('teams').select('withdrawn').eq('id', teamId).single();
    const before = { withdrawn: team?.withdrawn };
    const { error } = await db.from('teams').update({ withdrawn }).eq('id', teamId);
    if (error) {
      return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
    }
    await db.from('admin_log').insert({
      admin_id: session.aid,
      action: 'set_withdrawn',
      target: teamId,
      before: JSON.stringify(before),
      after: JSON.stringify({ withdrawn }),
    });
  }

  // Handle qualified change via RPC
  if (qualified !== undefined) {
    const { data, error } = await db.rpc('set_qualified', {
      p_team: teamId,
      p_qualified: qualified,
      p_admin_id: session.aid,
    });
    if (error || !data) {
      return NextResponse.json({ ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to update qualified status' });
    }
    const result = data as { ok: boolean; code?: string; message?: string };
    if (!result.ok) return NextResponse.json(result);
  }

  return NextResponse.json({ ok: true });
}
