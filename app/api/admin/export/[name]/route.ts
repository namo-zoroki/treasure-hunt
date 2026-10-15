export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

function toCSV(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const escape = (v: string | number | boolean | null | undefined): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const lines = [headers.join(','), ...rows.map((r) => r.map(escape).join(','))];
  return lines.join('\n');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({ ok: false, code: 'UNAUTHORIZED', message: 'Admin session required' }, { status: 401 });
  }

  const { name } = await params;

  if (name === 'registrations') {
    const { data, error } = await db
      .from('registrations')
      .select('id, run, team_id, student_id, qr_id, slot_no, created_ms, qr_locations(name)')
      .order('id');

    if (error) {
      return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
    }

    const csv = toCSV(
      ['id', 'run', 'team_id', 'student_id', 'qr_id', 'qr_name', 'slot_no', 'created_ms'],
      (data || []).map((r: any) => [r.id, r.run, r.team_id, r.student_id, r.qr_id, r.qr_locations?.name ?? '', r.slot_no, r.created_ms])
    );

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="registrations.csv"',
      },
    });
  }

  if (name === 'attempts') {
    const { data, error } = await db
      .from('attempts')
      .select('id, request_id, team_id, student_id, riddle_id, question_id, option_id, try_no, correct, points, created_ms')
      .order('id');

    if (error) {
      return NextResponse.json({ ok: false, code: 'DB_ERROR', message: error.message });
    }

    const csv = toCSV(
      ['id', 'request_id', 'team_id', 'student_id', 'item_type', 'item_id', 'option_id', 'try_no', 'correct', 'points', 'created_ms'],
      (data || []).map((a: any) => [
        a.id,
        a.request_id,
        a.team_id,
        a.student_id,
        a.riddle_id != null ? 'r1' : 'r2',
        a.riddle_id ?? a.question_id,
        a.option_id,
        a.try_no,
        a.correct,
        a.points,
        a.created_ms,
      ])
    );

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="attempts.csv"',
      },
    });
  }

  if (name === 'standings') {
    const [{ data: r1 }, { data: r2 }] = await Promise.all([
      db.from('r1_standings').select('team_id, points, last_ms').order('points', { ascending: false }),
      db.from('r2_standings').select('team_id, points, last_ms').order('points', { ascending: false }),
    ]);

    // Compute rank with ties
    function rankRows(rows: { team_id: string; points: number; last_ms: number | null }[]) {
      const sorted = [...rows].sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        const aMs = a.last_ms ?? Number.MAX_SAFE_INTEGER;
        const bMs = b.last_ms ?? Number.MAX_SAFE_INTEGER;
        return aMs - bMs;
      });
      let rank = 1;
      return sorted.map((row, i) => {
        if (i > 0) {
          const prev = sorted[i - 1];
          const sameRank = prev.points === row.points && prev.last_ms === row.last_ms;
          if (!sameRank) rank = i + 1;
        }
        return { rank, ...row };
      });
    }

    const r1Ranked = rankRows(r1 || []);
    const r2Ranked = rankRows(r2 || []);

    const lines: string[] = [
      '# R1 Standings',
      'rank,team_id,points,last_ms',
      ...r1Ranked.map((r) => `${r.rank},${r.team_id},${r.points},${r.last_ms ?? ''}`),
      '',
      '# R2 Standings',
      'rank,team_id,points,last_ms',
      ...r2Ranked.map((r) => `${r.rank},${r.team_id},${r.points},${r.last_ms ?? ''}`),
    ];

    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="standings.csv"',
      },
    });
  }

  return NextResponse.json({ ok: false, code: 'NOT_FOUND', message: `Unknown export: ${name}` }, { status: 404 });
}
