export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getPlayerSession } from '@/lib/session';
import { getRawPlayerState } from '@/lib/game-service';
import { buildState } from '@/lib/state';

export async function GET() {
  const session = await getPlayerSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in to access this.' }, { status: 401 });
  }
  const raw = await getRawPlayerState(db, session.sid);
  if (!raw) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in to access this.' }, { status: 401 });
  }
  return NextResponse.json({ ok: true, ...buildState(raw) }, { headers: { 'Cache-Control': 'no-store' } });
}
