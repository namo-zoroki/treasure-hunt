export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getPlayerSession } from '@/lib/session';
import { registerScan } from '@/lib/event-service';

const scanSchema = z.object({
  token: z.string().min(1),
});

export async function POST(request: NextRequest) {
  // Identity comes only from the signed player session cookie (Section 0.4 & Section 7.1)
  const session = await getPlayerSession();
  if (!session) {
    return NextResponse.json(
      { ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in to access this.' },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_ERROR', message: 'Valid token is required' },
      { status: 400 }
    );
  }

  const result = await registerScan(db, session.sid, parsed.data.token);
  return NextResponse.json(result);
}
