export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

const updateQrSchema = z.object({
  name: z.string().min(1).trim().optional(),
  capacity: z.number().int().positive().optional(),
  active: z.boolean().optional(),
  regenerateToken: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { id: rawId } = await params;
  const qrId = parseInt(rawId, 10);
  if (isNaN(qrId)) {
    return NextResponse.json({ ok: false, code: 'INVALID_ID', message: 'QR ID must be an integer' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, code: 'BAD_REQUEST', message: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = updateQrSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: 'VALIDATION_ERROR', message: 'Invalid update fields' }, { status: 400 });
  }

  const { data: existing, error: findError } = await db
    .from('qr_locations')
    .select('*')
    .eq('id', qrId)
    .single();

  if (findError || !existing) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'QR location not found' }, { status: 404 });
  }

  const updates: Record<string, any> = {};
  if (parsed.data.name !== undefined) updates.name = parsed.data.name;
  if (parsed.data.capacity !== undefined) updates.capacity = parsed.data.capacity;
  if (parsed.data.active !== undefined) updates.active = parsed.data.active;
  if (parsed.data.regenerateToken) {
    updates.token = crypto.randomBytes(16).toString('base64url');
  }

  const { data: updated, error: updateError } = await db
    .from('qr_locations')
    .update(updates)
    .eq('id', qrId)
    .select()
    .single();

  if (updateError || !updated) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: updateError?.message || 'Update failed' }, { status: 500 });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'update-qr',
    target: `qr_locations:${qrId}`,
    before: existing,
    after: updated,
  });

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  return NextResponse.json({
    ok: true,
    qr: {
      ...updated,
      link: `${baseUrl}/s/${updated.token}`,
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { id: rawId } = await params;
  const qrId = parseInt(rawId, 10);
  if (isNaN(qrId)) {
    return NextResponse.json({ ok: false, code: 'INVALID_ID', message: 'QR ID must be an integer' }, { status: 400 });
  }

  // Check if any question points to this QR (Section 9)
  const { data: questions } = await db
    .from('questions')
    .select('id')
    .eq('qr_id', qrId)
    .limit(1);

  if (questions && questions.length > 0) {
    return NextResponse.json({
      ok: false,
      code: 'QR_REFERENCED',
      message: 'Cannot delete this QR location because questions are currently assigned to it.',
    });
  }

  const { data: existing } = await db
    .from('qr_locations')
    .select('*')
    .eq('id', qrId)
    .single();

  if (!existing) {
    return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: 'QR location not found' }, { status: 404 });
  }

  const { error: deleteError } = await db
    .from('qr_locations')
    .delete()
    .eq('id', qrId);

  if (deleteError) {
    return NextResponse.json({ ok: false, code: 'DB_ERROR', message: deleteError.message }, { status: 500 });
  }

  await db.from('admin_log').insert({
    admin_id: session.aid,
    action: 'delete-qr',
    target: `qr_locations:${qrId}`,
    before: existing,
    after: null,
  });

  return NextResponse.json({ ok: true });
}
