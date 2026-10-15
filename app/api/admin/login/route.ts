import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signAdminToken, getAdminCookieOptions } from '@/lib/session';
import { getErrorMessage } from '@/lib/messages';

export const runtime = 'nodejs';

const AdminLoginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: 'INVALID_INPUT', message: 'Invalid JSON request body.' },
      { status: 400 }
    );
  }

  const parseResult = AdminLoginSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_ERROR', message: parseResult.error.errors[0]?.message || 'Validation error' },
      { status: 400 }
    );
  }

  const { username, password } = parseResult.data;

  // 1. Fetch admin
  const { data: admin, error: fetchErr } = await db
    .from('admins')
    .select('id, username, password_hash, failed_logins, locked_until')
    .eq('username', username)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: 'Database error.' },
      { status: 500 }
    );
  }

  if (!admin) {
    return NextResponse.json({
      ok: false,
      code: 'INVALID_LOGIN',
      message: getErrorMessage('INVALID_LOGIN'),
    });
  }

  const nowMs = Date.now();

  // 2. Check if locked
  if (admin.locked_until) {
    const lockedUntilMs = new Date(admin.locked_until).getTime();
    if (lockedUntilMs > nowMs) {
      const retryAfterSec = Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000));
      return NextResponse.json({
        ok: false,
        code: 'THROTTLED',
        message: getErrorMessage('THROTTLED', { s: retryAfterSec }),
        retryAfterSec,
      });
    }
  }

  // 3. Verify password
  const isMatch = await bcrypt.compare(password, admin.password_hash);

  if (!isMatch) {
    const newFailures = (admin.failed_logins || 0) + 1;
    let lockedUntil: string | null = null;
    let retryAfterSec = 0;

    if (newFailures >= 5) {
      const lockoutSec = Math.min(2 * Math.pow(2, newFailures - 5), 60);
      retryAfterSec = lockoutSec;
      lockedUntil = new Date(nowMs + lockoutSec * 1000).toISOString();
    }

    await db
      .from('admins')
      .update({
        failed_logins: newFailures,
        locked_until: lockedUntil,
      })
      .eq('id', admin.id);

    if (newFailures >= 5) {
      return NextResponse.json({
        ok: false,
        code: 'THROTTLED',
        message: getErrorMessage('THROTTLED', { s: retryAfterSec }),
        retryAfterSec,
      });
    }

    return NextResponse.json({
      ok: false,
      code: 'INVALID_LOGIN',
      message: getErrorMessage('INVALID_LOGIN'),
    });
  }

  // 4. Success
  await db
    .from('admins')
    .update({
      failed_logins: 0,
      locked_until: null,
    })
    .eq('id', admin.id);

  const token = await signAdminToken(admin.id);
  const cookieOptions = getAdminCookieOptions();

  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieOptions.name, token, cookieOptions);

  return response;
}
