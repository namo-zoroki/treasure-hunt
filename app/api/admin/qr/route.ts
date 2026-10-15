export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

const createQrSchema = z.object({
  name: z.string().min(1).trim(),
  capacity: z.number().int().positive().optional().default(12),
});

export async function GET() {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { data: qrs, error } = await db
    .from('qr_locations')
    .select('id, name, token, capacity, active')
    .order('id');

  if (error) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message }, { status: 500 });
  }

  // Count live registrations per run
  const { data: registrations } = await db
    .from('registrations')
    .select('qr_id, run');

  const counts: Record<number, { run1: number; run2: number }> = {};
  if (qrs) {
    for (const qr of qrs) {
      counts[qr.id] = { run1: 0, run2: 0 };
    }
  }
  if (registrations) {
    for (const reg of registrations) {
      if (counts[reg.qr_id]) {
        if (reg.run === 1) counts[reg.qr_id].run1++;
        if (reg.run === 2) counts[reg.qr_id].run2++;
      }
    }
  }

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  const items = (qrs || []).map((qr) => ({
    ...qr,
    link: `${baseUrl}/s/${qr.token}`,
    run1Count: counts[qr.id]?.run1 || 0,
    run2Count: counts[qr.id]?.run2 || 0,
  }));

  return NextResponse.json({ ok: true, qrs: items });
}

export async function POST(request: NextRequest) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = createQrSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Name is required' }, { status: 400 });
  }

  // Generate 16 bytes base64url token (Section 9)
  const token = crypto.randomBytes(16).toString('base64url');

  const { data: qr, error } = await db
    .from('qr_locations')
    .insert({
      name: parsed.data.name,
      capacity: parsed.data.capacity,
      token,
      active: true,
    })
    .select()
    .single();

  if (error || !qr) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error?.message || 'Failed to create QR' }, { status: 500 });
  }

  // Record admin_log
  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'create-qr',
    target: `qr_locations:${qr.id}`,
    before: null,
    after: qr,
  });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  return NextResponse.json({
    ok: true,
    qr: {
      ...qr,
      link: `${baseUrl}/s/${qr.token}`,
    },
  });
}
