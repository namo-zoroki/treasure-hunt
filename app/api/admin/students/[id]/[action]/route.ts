export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';
import { markAbsent, unmarkAbsent } from '@/lib/admin-service';
import bcrypt from 'bcryptjs';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

const absentSchema = z.object({
  moveToStudentId: z.string().min(1).optional(),
  moveTo: z.string().min(1).optional(),
  move_to: z.string().min(1).optional(),
}).refine((d) => d.moveToStudentId || d.moveTo || d.move_to, {
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

  if (action === 'reset-code') {
    // Generate new 6-char code, hash it, update student
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);

    const { data: student } = await db.from('students').select('name, team_id').eq('id', studentId).single();
    if (!student) {
      return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Student not found' });
    }

    const { error } = await db.from('students').update({ code_hash: codeHash }).eq('id', studentId);
    if (error) {
      return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
    }

    await db.from('admin_log').insert({
      admin_id: session.aid,
      action: 'reset_code',
      target: studentId,
      before: null,
      after: JSON.stringify({ note: 'code reset — not logged for security' }),
    });

    return NextResponse.json({ ok: true, code });
  }

  if (action === 'unlock') {
    const { data: student } = await db.from('students').select('failed_logins, locked_until').eq('id', studentId).single();
    if (!student) {
      return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Student not found' });
    }

    const { error } = await db.from('students').update({ failed_logins: 0, locked_until: null }).eq('id', studentId);
    if (error) {
      return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
    }

    await db.from('admin_log').insert({
      admin_id: session.aid,
      action: 'unlock_student',
      target: studentId,
      before: JSON.stringify({ failed_logins: student.failed_logins, locked_until: student.locked_until }),
      after: JSON.stringify({ failed_logins: 0, locked_until: null }),
    });

    return NextResponse.json({ ok: true });
  }

  if (action === 'make-captain') {
    // Fetch the student's team
    const { data: student } = await db.from('students').select('team_id').eq('id', studentId).single();
    if (!student) {
      return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Student not found' });
    }

    const { data, error } = await db.rpc('set_captain', {
      p_team: student.team_id,
      p_student: studentId,
      p_admin_id: session.aid,
    });

    if (error || !data) {
      return NextResponse.json({ ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to set captain' });
    }
    return NextResponse.json(data);
  }

  return NextResponse.json({ ok: false, code: 'INVALID_ACTION', message: `Unknown student action: ${rawAction}` }, { status: 400 });
}
