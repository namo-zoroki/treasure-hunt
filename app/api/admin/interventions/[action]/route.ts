export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';
import { cancelRegistration, voidQuestion } from '@/lib/admin-service';

const cancelRegistrationSchema = z.object({
  registrationId: z.coerce.number().int().positive(),
});

const voidQuestionSchema = z.object({
  teamId: z.string().nullable().optional(),
  questionId: z.coerce.number().int().positive(),
  reason: z.string().min(1, 'Reason is required'),
});

const skipTeaserSchema = z.object({
  teamId: z.string().min(1),
  run: z.coerce.number().int().min(1).max(2),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ action: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { action: rawAction } = await params;
  const action = rawAction.toLowerCase();

  let body: any = {};
  if (request.headers.get('content-type')?.includes('application/json')) {
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
    }
  }

  if (action === 'cancel-registration') {
    const parsed = cancelRegistrationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Valid registrationId is required' }, { status: 400 });
    }
    const res = await cancelRegistration(db, parsed.data.registrationId, session.aid);
    return NextResponse.json(res);
  }

  if (action === 'void-question') {
    const parsed = voidQuestionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'questionId and a non-empty reason are required' }, { status: 400 });
    }
    const res = await voidQuestion(
      db,
      parsed.data.teamId ?? null,
      parsed.data.questionId,
      parsed.data.reason,
      session.aid
    );
    return NextResponse.json(res);
  }

  if (action === 'skip-teaser') {
    const parsed = skipTeaserSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'teamId and run are required' }, { status: 400 });
    }
    const { data, error } = await db.rpc('skip_teaser', {
      p_team: parsed.data.teamId,
      p_run: parsed.data.run,
      p_admin_id: session.aid,
    });
    if (error || !data) {
      return NextResponse.json({ ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to skip teaser' });
    }
    return NextResponse.json(data);
  }

  return NextResponse.json({ ok: false, code: 'INVALID_ACTION', message: `Unknown intervention: ${rawAction}` }, { status: 400 });
}
