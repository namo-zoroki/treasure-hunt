import { NextResponse } from 'next/server';
import { PLAYER_COOKIE_NAME } from '@/lib/session';

export const runtime = 'nodejs';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(PLAYER_COOKIE_NAME);
  return response;
}
