export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

const optionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const patchSchema = z.object({
  stem: z.string().min(1).optional(),
  qrId: z.number().int().positive().optional(),
  options: z.array(optionSchema).min(2).optional(),
  correctOptionId: z.string().min(1).optional(),
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
  const questionId = parseInt(id);
  if (isNaN(questionId)) {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid question ID' }, { status: 400 });
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

  const { data: question } = await db
    .from('questions')
    .select('id, stem, options, correct_option_id, qr_id')
    .eq('id', questionId)
    .single();

  if (!question) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'Question not found' });
  }

  // Check attempts
  const { count } = await db
    .from('attempts')
    .select('id', { count: 'exact', head: true })
    .eq('question_id', questionId);

  const hasAttempts = (count ?? 0) > 0;
  const { stem, qrId, options, correctOptionId } = parsed.data;

  if (hasAttempts && (options !== undefined || correctOptionId !== undefined)) {
    return NextResponse.json({ ok: false, code: 'CONTENT_LOCKED', message: 'Options and correct answer are locked because attempts exist' });
  }

  const updates: Record<string, unknown> = {};
  if (stem !== undefined) updates.stem = stem;
  if (qrId !== undefined) updates.qr_id = qrId;
  if (!hasAttempts) {
    if (options !== undefined) updates.options = options;
    if (correctOptionId !== undefined) updates.correct_option_id = correctOptionId;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, message: 'Nothing to update' });
  }

  const { error } = await db.from('questions').update(updates).eq('id', questionId);
  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'edit_question',
    target: String(questionId),
    before: JSON.stringify({ stem: question.stem, qr_id: question.qr_id }),
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
  const questionId = parseInt(id);
  if (isNaN(questionId)) {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid question ID' }, { status: 400 });
  }

  // Block if attempts exist
  const { count: attemptCount } = await db
    .from('attempts')
    .select('id', { count: 'exact', head: true })
    .eq('question_id', questionId);

  if ((attemptCount ?? 0) > 0) {
    return NextResponse.json({ ok: false, code: 'CONTENT_LOCKED', message: 'Cannot delete question with existing attempts' });
  }

  // Block if team_questions reference it
  const { count: tqCount } = await db
    .from('team_questions')
    .select('question_id', { count: 'exact', head: true })
    .eq('question_id', questionId);

  if ((tqCount ?? 0) > 0) {
    return NextResponse.json({ ok: false, code: 'CONTENT_LOCKED', message: 'Cannot delete question that is assigned to a team' });
  }

  const { error } = await db.from('questions').delete().eq('id', questionId);
  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'delete_question',
    target: String(questionId),
    before: JSON.stringify({ questionId }),
    after: null,
  });

  return NextResponse.json({ ok: true });
}
