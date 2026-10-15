export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getPlayerSession } from '@/lib/session';
import { claimRound3 } from '@/lib/game-service';

const schema = z.object({
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const session = await getPlayerSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in to access this.' },
      { status: 401 }
    );
  }

  const text = await request.text();
  let body: unknown = {};
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_ERROR', message: 'Password is required' },
      { status: 400 }
    );
  }

  const result = await claimRound3(db, session.sid, parsed.data.password);
  return NextResponse.json(result);
}
