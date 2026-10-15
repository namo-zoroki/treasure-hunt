import { NextRequest, NextResponse } from 'next/server';
import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';

export const runtime = 'nodejs';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateStudentCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    const idx = crypto.randomInt(0, CODE_CHARS.length);
    code += CODE_CHARS[idx];
  }
  return code;
}

interface CsvRow {
  student_id?: string;
  name?: string;
  team_id?: string;
  team_name?: string;
  is_captain?: string | boolean;
}

export async function POST(req: NextRequest) {
  // 1. Verify admin session
  const adminSession = await getAdminSession();
  if (!adminSession) {
    return NextResponse.json(
      { ok: false, code: 'UNAUTHORIZED', message: 'You must be logged in as an admin.' },
      { status: 401 }
    );
  }

  // 2. Verify phase is 'setup'
  const { data: eventState, error: stateErr } = await db
    .from('event_state')
    .select('phase')
    .eq('id', 1)
    .single();

  if (stateErr || !eventState) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: 'Could not fetch event state.' },
      { status: 500 }
    );
  }

  if (eventState.phase !== 'setup') {
    return NextResponse.json({
      ok: false,
      code: 'WRONG_PHASE',
      message: 'Participant import is only allowed during the setup phase.',
    });
  }

  // 3. Extract CSV text
  let csvText = '';
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    try {
      const formData = await req.formData();
      const file = formData.get('file') || formData.get('csv');
      if (!file || typeof file === 'string') {
        return NextResponse.json(
          { ok: false, code: 'INVALID_INPUT', message: 'No file uploaded in form data.' },
          { status: 400 }
        );
      }
      csvText = await (file as File).text();
    } catch {
      return NextResponse.json(
        { ok: false, code: 'INVALID_INPUT', message: 'Error reading form data file.' },
        { status: 400 }
      );
    }
  } else if (contentType.includes('application/json')) {
    try {
      const json = await req.json();
      csvText = json.csv || '';
    } catch {
      return NextResponse.json(
        { ok: false, code: 'INVALID_INPUT', message: 'Invalid JSON body.' },
        { status: 400 }
      );
    }
  } else {
    csvText = await req.text();
  }

  if (!csvText || !csvText.trim()) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_INPUT', message: 'CSV content is empty.' },
      { status: 400 }
    );
  }

  // 4. Parse CSV
  let records: CsvRow[];
  try {
    records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'CSV parsing failed';
    return NextResponse.json(
      { ok: false, code: 'PARSE_ERROR', message: `Invalid CSV format: ${msg}` },
      { status: 400 }
    );
  }

  if (!records.length) {
    return NextResponse.json(
      { ok: false, code: 'INVALID_INPUT', message: 'CSV contains no participant rows.' },
      { status: 400 }
    );
  }

  // 5. Validate rows and team constraints
  const seenStudentIds = new Set<string>();
  const teamsMap = new Map<
    string,
    {
      teamName: string;
      members: Array<{
        studentId: string;
        name: string;
        isCaptain: boolean;
      }>;
    }
  >();

  for (let idx = 0; idx < records.length; idx++) {
    const row = records[idx];
    const lineNum = idx + 2;

    const studentId = row.student_id?.trim();
    const name = row.name?.trim();
    const teamId = row.team_id?.trim();
    const teamName = row.team_name?.trim();
    const captainRaw = String(row.is_captain ?? '').trim().toLowerCase();
    const isCaptain = captainRaw === 'true' || captainRaw === '1' || captainRaw === 'yes';

    if (!studentId || !name || !teamId || !teamName) {
      return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Line ${lineNum}: Missing required fields (student_id, name, team_id, team_name).`,
        },
        { status: 400 }
      );
    }

    if (seenStudentIds.has(studentId)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Duplicate student_id "${studentId}" at line ${lineNum}.`,
        },
        { status: 400 }
      );
    }
    seenStudentIds.add(studentId);

    if (!teamsMap.has(teamId)) {
      teamsMap.set(teamId, {
        teamName,
        members: [],
      });
    }

    const team = teamsMap.get(teamId)!;
    if (team.teamName !== teamName) {
      return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Conflicting team names for team "${teamId}": "${team.teamName}" vs "${teamName}" at line ${lineNum}.`,
        },
        { status: 400 }
      );
    }

    team.members.push({ studentId, name, isCaptain });
  }

  // Validate team constraints: 3-5 members, exactly 1 captain
  for (const [teamId, team] of teamsMap.entries()) {
    const memberCount = team.members.length;
    if (memberCount < 3 || memberCount > 5) {
      return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Team "${teamId}" has ${memberCount} members. Each team must have between 3 and 5 members.`,
        },
        { status: 400 }
      );
    }

    const captains = team.members.filter((m) => m.isCaptain);
    if (captains.length !== 1) {
      return NextResponse.json(
        {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Team "${teamId}" has ${captains.length} captains. Every team must have exactly 1 captain.`,
        },
        { status: 400 }
      );
    }
  }

  // 6. Generate codes, hash them, and prepare records
  const salt = await bcrypt.genSalt(10);
  const teamRows = [];
  const studentRows = [];
  const codesCsvRows = ['student_id,name,team_id,code'];

  for (const [teamId, team] of teamsMap.entries()) {
    teamRows.push({
      id: teamId,
      name: team.teamName,
      n: team.members.length,
      withdrawn: false,
      qualified: false,
      r3_eligible: false,
    });

    for (const member of team.members) {
      const code = generateStudentCode();
      const codeHash = await bcrypt.hash(code.toUpperCase(), salt);

      studentRows.push({
        id: member.studentId,
        name: member.name,
        team_id: teamId,
        is_captain: member.isCaptain,
        absent: false,
        code_hash: codeHash,
        failed_logins: 0,
        locked_until: null,
      });

      codesCsvRows.push(`${member.studentId},"${member.name.replace(/"/g, '""')}",${teamId},${code}`);
    }
  }

  // 7. Write to database: clean existing test participants then insert new ones
  // Delete existing students and teams
  const { error: delStudentsErr } = await db.from('students').delete().neq('id', '');
  if (delStudentsErr) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: `Failed to clear old students: ${delStudentsErr.message}` },
      { status: 500 }
    );
  }

  const { error: delTeamsErr } = await db.from('teams').delete().neq('id', '');
  if (delTeamsErr) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: `Failed to clear old teams: ${delTeamsErr.message}` },
      { status: 500 }
    );
  }

  const { error: insertTeamsErr } = await db.from('teams').insert(teamRows);
  if (insertTeamsErr) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: `Failed to insert teams: ${insertTeamsErr.message}` },
      { status: 500 }
    );
  }

  const { error: insertStudentsErr } = await db.from('students').insert(studentRows);
  if (insertStudentsErr) {
    return NextResponse.json(
      { ok: false, code: 'SERVER_ERROR', message: `Failed to insert students: ${insertStudentsErr.message}` },
      { status: 500 }
    );
  }

  // 8. Log admin action
  await db.from('admin_log').insert({
    admin_id: adminSession.aid,
    action: 'import_participants',
    target: 'teams,students',
    before: null,
    after: {
      team_count: teamRows.length,
      student_count: studentRows.length,
    },
  });

  const codesCsv = codesCsvRows.join('\n');

  return NextResponse.json({
    ok: true,
    message: `Imported ${teamRows.length} teams and ${studentRows.length} students successfully.`,
    count: {
      teams: teamRows.length,
      students: studentRows.length,
    },
    csv: codesCsv,
  });
}
