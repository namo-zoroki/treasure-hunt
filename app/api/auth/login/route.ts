import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db';
import { signPlayerToken, getPlayerCookieOptions } from '@/lib/session';
import { getErrorMessage } from '@/lib/messages';

export const runtime = 'nodejs';

const LoginSchema = z.object({
  studentId: z.string().trim().min(1, 'Student ID is required'),
  code: z.string().trim().min(1, 'Code is required'),
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

  const parseResult = LoginSchema.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { ok: false, code: 'VALIDATION_ERROR', message: parseResult.error.errors[0]?.message || 'Validation error' },
      { status: 400 }
    );
  }

  const { studentId, code } = parseResult.data;

  // 1. Fetch student
  const { data: student, error: fetchErr } = await db
    .from('students')
    .select('id, name, code_hash, failed_logins, locked_until')
    .eq('id', studentId)
    .maybeSingle();

  if (fetchErr) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: 'Database error.' },
      { status: 500 }
    );
  }

  if (!student) {
    return NextResponse.json({
      ok: false,
      code: 'INVALID_LOGIN',
      message: getErrorMessage('INVALID_LOGIN'),
    });
  }

  const nowMs = Date.now();

  // 2. Check if throttled/locked
  if (student.locked_until) {
    const lockedUntilMs = new Date(student.locked_until).getTime();
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

  // 3. Verify code (case-insensitive per Section 10)
  const isMatch = await bcrypt.compare(code.toUpperCase(), student.code_hash);

  if (!isMatch) {
    const newFailures = (student.failed_logins || 0) + 1;
    let lockedUntil: string | null = null;
    let retryAfterSec = 0;

    if (newFailures >= 5) {
      // Formula: now + min(2 * 2^(failed_logins - 5), 60)
      const lockoutSec = Math.min(2 * Math.pow(2, newFailures - 5), 60);
      retryAfterSec = lockoutSec;
      lockedUntil = new Date(nowMs + lockoutSec * 1000).toISOString();
    }

    await db
      .from('students')
      .update({
        failed_logins: newFailures,
        locked_until: lockedUntil,
      })
      .eq('id', student.id);

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

  // 4. Success: reset throttle and set session cookie
  await db
    .from('students')
    .update({
      failed_logins: 0,
      locked_until: null,
    })
    .eq('id', student.id);

  const token = await signPlayerToken(student.id);
  const cookieOptions = getPlayerCookieOptions();

  const response = NextResponse.json({ ok: true });
  response.cookies.set(cookieOptions.name, token, cookieOptions);

  return response;
}
