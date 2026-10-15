export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

function normalizePassword(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

const putSchema = z.object({
  clueText: z.string().optional(),
  passwordNorm: z.string().optional(),
  keyInfo: z.string().optional(),
  room: z.string().optional(),
});

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const [{ data: r3, error }, { data: eligibleTeams }, { data: claim }, { data: state }] = await Promise.all([
    db.from('round3').select('clue_text, password_norm, key_info, room').eq('id', 1).single(),
    db.from('teams').select('id, name, n, r3_eligible, withdrawn').eq('r3_eligible', true).order('id'),
    db.from('round3_claim').select('id, team_id, student_id, created_ms').eq('id', 1).maybeSingle(),
    db.from('event_state').select('phase').eq('id', 1).single(),
  ]);

  if (error || !r3) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error?.message || 'Round 3 config not found' });
  }

  let winnerDetails = null;
  if (claim) {
    const [{ data: wTeam }, { data: wStudent }] = await Promise.all([
      db.from('teams').select('id, name').eq('id', claim.team_id).single(),
      db.from('students').select('id, name').eq('id', claim.student_id).single(),
    ]);
    winnerDetails = {
      teamId: claim.team_id,
      teamName: wTeam?.name || claim.team_id,
      studentId: claim.student_id,
      studentName: wStudent?.name || claim.student_id,
      createdMs: claim.created_ms,
    };
  }

  return NextResponse.json({
    ok: true,
    phase: state?.phase || 'setup',
    clueText: r3.clue_text,
    passwordNorm: r3.password_norm,
    keyInfo: r3.key_info,
    room: r3.room,
    eligibleTeams: eligibleTeams || [],
    winner: winnerDetails,
  });
}

export async function PUT(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  let body: unknown = {};
  const text = await request.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message || 'Validation failed' }, { status: 400 });
  }

  const { clueText, passwordNorm, keyInfo, room } = parsed.data;

  const { data: before } = await db.from('round3').select('clue_text, password_norm, key_info, room').eq('id', 1).single();

  const updates: Record<string, string> = {};
  if (clueText !== undefined) updates.clue_text = clueText;
  if (passwordNorm !== undefined) updates.password_norm = normalizePassword(passwordNorm);
  if (keyInfo !== undefined) updates.key_info = keyInfo;
  if (room !== undefined) updates.room = room;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, message: 'Nothing to update' });
  }

  const { error } = await db.from('round3').update(updates).eq('id', 1);
  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'edit_round3',
    target: '1',
    before: JSON.stringify(before),
    after: JSON.stringify(updates),
  });

  return NextResponse.json({ ok: true });
}
