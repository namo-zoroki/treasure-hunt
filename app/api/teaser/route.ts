export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getPlayerSession } from '@/lib/session';
import { solveTeaser } from '@/lib/game-service';

const schema = z.object({ answer: z.string().max(200), requestId: z.string().uuid() });

export async function POST(request: NextRequest) {
  const session = await getPlayerSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in to access this.' }, { status: 401 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Invalid request' }, { status: 400 });
  }
  return NextResponse.json(await solveTeaser(db, session.sid, parsed.data.answer));
}
