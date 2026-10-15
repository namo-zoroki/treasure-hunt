import type { SupabaseClient } from '@supabase/supabase-js';

export interface AdminActionResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export async function markAbsent(
  client: SupabaseClient,
  studentId: string,
  moveToStudentId: string,
  adminId: number | null = null
): Promise<AdminActionResult> {
  const { data, error } = await client.rpc('mark_absent', {
    p_student: studentId,
    p_move_to: moveToStudentId,
    p_admin_id: adminId,
  });

  if (error || !data) {
    return { ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to mark student absent' };
  }
  return data as AdminActionResult;
}

export async function unmarkAbsent(
  client: SupabaseClient,
  studentId: string,
  adminId: number | null = null
): Promise<AdminActionResult> {
  const { data, error } = await client.rpc('unmark_absent', {
    p_student: studentId,
    p_admin_id: adminId,
  });

  if (error || !data) {
    return { ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to unmark student absent' };
  }
  return data as AdminActionResult;
}

export async function cancelRegistration(
  client: SupabaseClient,
  registrationId: number,
  adminId: number | null = null
): Promise<AdminActionResult> {
  const { data, error } = await client.rpc('cancel_registration', {
    p_registration_id: registrationId,
    p_admin_id: adminId,
  });

  if (error || !data) {
    return { ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to cancel registration' };
  }
  return data as AdminActionResult;
}

export async function voidQuestion(
  client: SupabaseClient,
  teamId: string | null,
  questionId: number,
  reason: string,
  adminId: number | null = null
): Promise<AdminActionResult> {
  const { data, error } = await client.rpc('void_question', {
    p_team: teamId,
    p_question_id: questionId,
    p_reason: reason,
    p_admin_id: adminId,
  });

  if (error || !data) {
    return { ok: false, code: error?.code || 'RPC_ERROR', message: error?.message || 'Failed to void question' };
  }
  return data as AdminActionResult;
}
