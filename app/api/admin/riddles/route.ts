export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

const optionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});

const createRiddleSchema = z.object({
  position: z.number().int().min(1),
  text: z.string().min(1),
  options: z.array(optionSchema).min(2),
  correctOptionId: z.string().min(1),
});

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { data: riddles, error } = await db
    .from('riddles')
    .select('id, position, text, options, correct_option_id')
    .order('position');

  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  // Check which riddles have attempts
  const { data: attempted } = await db
    .from('attempts')
    .select('riddle_id')
    .not('riddle_id', 'is', null);

  const attemptedIds = new Set((attempted || []).map((a) => a.riddle_id));

  return NextResponse.json({
    ok: true,
    riddles: (riddles || []).map((r) => ({
      id: r.id,
      position: r.position,
      text: r.text,
      options: r.options,
      correctOptionId: r.correct_option_id,
      hasAttempts: attemptedIds.has(r.id),
    })),
  });
}

export async function POST(request: NextRequest) {
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

  const parsed = createRiddleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message || 'Validation failed' }, { status: 400 });
  }

  const { position, text: stem, options, correctOptionId } = parsed.data;

  // Validate correctOptionId is in options
  if (!options.find((o) => o.id === correctOptionId)) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'correctOptionId must match one of the option IDs' }, { status: 400 });
  }

  const { data: riddle, error } = await db
    .from('riddles')
    .insert({ position, text: stem, options, correct_option_id: correctOptionId })
    .select('id')
    .single();

  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'create_riddle',
    target: String(riddle.id),
    before: null,
    after: JSON.stringify({ position, text: stem }),
  });

  return NextResponse.json({ ok: true, id: riddle.id });
}
