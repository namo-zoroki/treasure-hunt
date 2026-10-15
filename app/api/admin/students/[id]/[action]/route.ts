export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';
import { markAbsent, unmarkAbsent } from '@/lib/admin-service';

const absentSchema = z.object({
  moveToStudentId: z.string().min(1).optional(),
  moveTo: z.string().min(1).optional(),
  move_to: z.string().min(1).optional(),
}).refine(data => data.moveToStudentId || data.moveTo || data.move_to, {
  message: 'moveToStudentId or moveTo is required',
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { id: studentId, action: rawAction } = await params;
  const action = rawAction.toLowerCase();

  let body: any = {};
  const text = await request.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
    }
  }

  if (action === 'absent') {
    const parsed = absentSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Target teammate is required' }, { status: 400 });
    }
    const target = parsed.data.moveToStudentId || parsed.data.moveTo || parsed.data.move_to!;
    const res = await markAbsent(db, studentId, target, session.aid);
    return NextResponse.json(res);
  }

  if (action === 'unabsent') {
    const res = await unmarkAbsent(db, studentId, session.aid);
    return NextResponse.json(res);
  }

  return NextResponse.json({ ok: false, code: 'INVALID_ACTION', message: `Unknown student action: ${rawAction}` }, { status: 400 });
}
