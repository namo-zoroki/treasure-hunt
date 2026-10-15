export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

function normalizeAnswer(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

const patchSchema = z.object({
  pieces: z.array(z.string().min(1)).optional(),
  answerNorm: z.string().min(1).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { id } = await params;
  const teaserId = parseInt(id);
  if (isNaN(teaserId)) {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid teaser ID' }, { status: 400 });
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message || 'Validation failed' }, { status: 400 });
  }

  const { data: teaser } = await db
    .from('teaser_puzzles')
    .select('id, size, pieces, answer_norm')
    .eq('id', teaserId)
    .single();

  if (!teaser) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Teaser not found' });
  }

  const updates: Record<string, unknown> = {};
  const { pieces, answerNorm } = parsed.data;

  if (pieces !== undefined) {
    if (pieces.length !== teaser.size) {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: `pieces array must have exactly ${teaser.size} items` });
    }
    updates.pieces = pieces;
  }
  if (answerNorm !== undefined) updates.answer_norm = normalizeAnswer(answerNorm);

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, message: 'Nothing to update' });
  }

  const { error } = await db.from('teaser_puzzles').update(updates).eq('id', teaserId);
  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'edit_teaser',
    target: String(teaserId),
    before: JSON.stringify({ answer_norm: teaser.answer_norm }),
    after: JSON.stringify(updates),
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { id } = await params;
  const teaserId = parseInt(id);
  if (isNaN(teaserId)) {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid teaser ID' }, { status: 400 });
  }

  const { error } = await db.from('teaser_puzzles').delete().eq('id', teaserId);
  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'delete_teaser',
    target: String(teaserId),
    before: JSON.stringify({ teaserId }),
    after: null,
  });

  return NextResponse.json({ ok: true });
}
