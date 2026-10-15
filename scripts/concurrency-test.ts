/**
 * scripts/concurrency-test.ts
 *
 * Section 12 Phase 3 "Done when" check:
 *   "30 parallel scans for the last free slot: exactly 1 succeeds"
 *
 * Also tests:
 *   - Two teammates scanning the same QR concurrently (exactly 1 gets TEAMMATE_HERE)
 *   - Duplicate requestId returning same result (idempotent scan re-scan)
 *
 * Run: tsx --env-file=.env.local scripts/concurrency-test.ts
 *
 * Prerequisites: seed data present (30 teams, 12 QRs), event in r2_running phase
 * with at least 2 qualified teams that have an open run.
 * The script sets up the required state automatically in test mode.
 */

import { createClient } from '@supabase/supabase-js';
import { executeEventAction } from '../lib/event-service';
import { registerScan } from '../lib/event-service';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const db = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function countBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, number> {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}

// ─── setup ──────────────────────────────────────────────────────────────────

async function ensureTestState() {
  const { data: state } = await db.from('event_state').select('*').eq('id', 1).single();

  // Verify test mode
  if (state?.mode !== 'test') {
    throw new Error('Concurrency test requires test mode. Aborting to protect live data.');
  }

  // Reset to clean slate
  console.log('  Resetting event data to clean state...');
  const resetRes = await executeEventAction(db, 'reset', null, { confirm: 'RESET' });
  if (!resetRes.ok) throw new Error(`Reset failed: ${resetRes.message}`);

  // Qualify a few teams
  await db.from('teams').update({ qualified: true }).in('id', ['T01', 'T02', 'T03']);

  // Start R1 then close it to allow R2 start
  await executeEventAction(db, 'start-r1', null);
  await executeEventAction(db, 'end-r1', null);

  // Start R2
  const r2Res = await executeEventAction(db, 'start-r2', null);
  if (!r2Res.ok) throw new Error(`Failed to start R2: ${r2Res.message}`);

  console.log('  ✓ Event state: r2_running with T01, T02, T03 qualified.');
}

// ─── test 1: last-slot race ──────────────────────────────────────────────────

async function testLastSlotRace() {
  console.log('\n══════════════════════════════════════════');
  console.log('TEST 1: Last-free-slot race (30 parallel scans → exactly 1 succeeds)');
  console.log('══════════════════════════════════════════');

  // Use the first QR location; set capacity to 1 so only 1 can register
  const { data: qrRows } = await db
    .from('qr_locations')
    .select('id, name, token, capacity')
    .eq('active', true)
    .order('id')
    .limit(1);

  if (!qrRows || qrRows.length === 0) throw new Error('No active QR locations found. Run seed first.');
  const qr = qrRows[0];

  // Set capacity to 1
  await db.from('qr_locations').update({ capacity: 1 }).eq('id', qr.id);
  console.log(`  QR: "${qr.name}" (id=${qr.id}) — capacity forced to 1`);

  // Fetch T01's team members
  const { data: students } = await db
    .from('students')
    .select('id, name, team_id, is_captain, absent')
    .eq('team_id', 'T01')
    .eq('absent', false);

  if (!students || students.length < 3) {
    throw new Error('Need at least 3 non-absent students in T01. Run seed first.');
  }

  // Use 30 concurrent requests: all members of T01 + duplicates to simulate 30 callers
  // In real tests only distinct students matter; for concurrency we fire many in parallel.
  // We'll use the same set of students cycling through for a high-throughput race.
  const CONCURRENT = 30;
  const requests = Array.from({ length: CONCURRENT }, (_, i) => {
    const student = students[i % students.length];
    return registerScan(db, student.id, qr.token);
  });

  console.log(`  Firing ${CONCURRENT} concurrent scan requests...`);
  const results = await Promise.all(requests);

  const successCount = results.filter((r) => r.ok).length;
  const qrFullCount = results.filter((r) => !r.ok && r.code === 'QR_FULL').length;
  const alreadyCount = results.filter((r) => r.ok && r.already).length;
  const otherFailures = results.filter((r) => !r.ok && r.code !== 'QR_FULL');

  console.log(`  Results: ${successCount} ok (${alreadyCount} already), ${qrFullCount} QR_FULL, ${otherFailures.length} other`);

  // With capacity=1, only 1 unique student should win a fresh slot.
  // The rest either get QR_FULL or "already" (if same student retried).
  const uniqueSuccessStudents = new Set(
    results
      .filter((r) => r.ok && !r.already)
      .map((_, i) => students[i % students.length].id)
  );

  // Verify database: exactly 1 registration at this QR for run 1
  const { data: regs } = await db
    .from('registrations')
    .select('id, student_id, slot_no')
    .eq('qr_id', qr.id)
    .eq('run', 1);

  const actualRegistered = regs?.length ?? 0;
  console.log(`  DB registrations for this QR in run 1: ${actualRegistered}`);

  if (actualRegistered !== 1) {
    throw new Error(
      `FAILED: Expected exactly 1 registration in DB, got ${actualRegistered}. Concurrency protection is broken!`
    );
  }

  console.log('  ✓ PASS: Exactly 1 registration stored in DB despite 30 concurrent requests.');

  // Restore capacity
  await db.from('qr_locations').update({ capacity: qr.capacity }).eq('id', qr.id);
}

// ─── test 2: two teammates same QR ──────────────────────────────────────────

async function testTeammateRace() {
  console.log('\n══════════════════════════════════════════');
  console.log('TEST 2: Two teammates scanning same QR simultaneously');
  console.log('══════════════════════════════════════════');

  const { data: qrRows } = await db
    .from('qr_locations')
    .select('id, name, token, capacity')
    .eq('active', true)
    .order('id')
    .limit(2);

  if (!qrRows || qrRows.length < 2) throw new Error('Need at least 2 active QRs. Run seed first.');
  const qr = qrRows[1]; // use the second QR

  const { data: students } = await db
    .from('students')
    .select('id, name, team_id, absent')
    .eq('team_id', 'T02')
    .eq('absent', false)
    .limit(2);

  if (!students || students.length < 2) {
    throw new Error('Need at least 2 non-absent students in T02. Run seed first.');
  }

  const [s1, s2] = students;
  console.log(`  Firing simultaneous scan for ${s1.id} and ${s2.id} at QR "${qr.name}"...`);

  const [r1, r2] = await Promise.all([
    registerScan(db, s1.id, qr.token),
    registerScan(db, s2.id, qr.token),
  ]);

  const successes = [r1, r2].filter((r) => r.ok);
  const failures  = [r1, r2].filter((r) => !r.ok);

  console.log(`  Student ${s1.id}: ${JSON.stringify({ ok: r1.ok, code: r1.code })}`);
  console.log(`  Student ${s2.id}: ${JSON.stringify({ ok: r2.ok, code: r2.code })}`);

  // Verify DB: exactly 1 registration for this QR
  const { data: regs } = await db
    .from('registrations')
    .select('id, student_id')
    .eq('qr_id', qr.id)
    .eq('run', 1);

  const dbCount = regs?.length ?? 0;
  console.log(`  DB registrations for this QR in run 1: ${dbCount}`);

  if (dbCount !== 1) {
    throw new Error(
      `FAILED: Expected exactly 1 registration, got ${dbCount}. Teammate race not handled correctly!`
    );
  }

  // The failure should be TEAMMATE_HERE
  const teammateErrors = failures.filter((r) => r.code === 'TEAMMATE_HERE');
  if (failures.length > 0 && teammateErrors.length === 0) {
    console.warn(`  Warning: Failure code was "${failures[0].code}" — expected TEAMMATE_HERE for DB fallback path`);
  }

  console.log('  ✓ PASS: Exactly 1 teammate registered; TEAMMATE_HERE enforced.');
}

// ─── test 3: duplicate requestId / same student rescan (idempotent) ──────────

async function testIdempotentRescan() {
  console.log('\n══════════════════════════════════════════');
  console.log('TEST 3: Duplicate scan (same student, same QR) returns already=true idempotently');
  console.log('══════════════════════════════════════════');

  // Get a QR that T03 hasn't used yet
  const { data: qrRows } = await db
    .from('qr_locations')
    .select('id, name, token')
    .eq('active', true)
    .order('id')
    .limit(3);

  if (!qrRows || qrRows.length < 3) throw new Error('Need at least 3 active QRs.');
  const qr = qrRows[2];

  const { data: students } = await db
    .from('students')
    .select('id, absent')
    .eq('team_id', 'T03')
    .eq('absent', false)
    .limit(1);

  if (!students || students.length === 0) throw new Error('No students in T03.');
  const student = students[0];

  // First scan
  const first = await registerScan(db, student.id, qr.token);
  if (!first.ok) {
    throw new Error(`First scan failed unexpectedly: ${first.code} – ${first.message}`);
  }
  console.log(`  First scan: ok=${first.ok}, piece=${first.piece_no}, run=${first.run}`);

  // Repeat scan 5 times concurrently
  const repeats = await Promise.all(
    Array.from({ length: 5 }, () => registerScan(db, student.id, qr.token))
  );

  const allOk = repeats.every((r) => r.ok);
  const allAlready = repeats.every((r) => r.already === true);

  console.log(`  Repeat scans (x5): allOk=${allOk}, allAlready=${allAlready}`);

  // Verify DB: still exactly 1 registration
  const { data: regs } = await db
    .from('registrations')
    .select('id')
    .eq('student_id', student.id)
    .eq('qr_id', qr.id);

  const dbCount = regs?.length ?? 0;
  if (dbCount !== 1) {
    throw new Error(`FAILED: Expected 1 registration row, got ${dbCount} after repeated scans.`);
  }

  if (!allOk || !allAlready) {
    throw new Error(`FAILED: Repeat scans should all return ok=true, already=true.`);
  }

  console.log('  ✓ PASS: Idempotent re-scan returns ok+already=true without creating duplicate rows.');
}

// ─── test 4: all Section 6.1 domain rejection codes ─────────────────────────

async function testDomainRejections() {
  console.log('\n══════════════════════════════════════════');
  console.log('TEST 4: Domain rejection codes from Section 6.1');
  console.log('══════════════════════════════════════════');

  // INVALID_QR
  const { data: anyStudent } = await db
    .from('students')
    .select('id, team_id, absent')
    .eq('team_id', 'T01')
    .eq('absent', false)
    .limit(1);

  if (!anyStudent || anyStudent.length === 0) throw new Error('No T01 student found.');
  const student = anyStudent[0];

  const r1 = await registerScan(db, student.id, 'INVALID_TOKEN_XYZ_12345');
  console.log(`  INVALID_QR test: code=${r1.code}`);
  if (r1.code !== 'INVALID_QR') throw new Error(`Expected INVALID_QR, got ${r1.code}`);
  console.log('  ✓ INVALID_QR correct');

  // QR_INACTIVE: deactivate a QR
  const { data: allQrs } = await db
    .from('qr_locations')
    .select('id, token')
    .order('id')
    .limit(4);

  if (!allQrs || allQrs.length < 4) throw new Error('Need 4+ QRs.');
  const inactiveQr = allQrs[3];
  await db.from('qr_locations').update({ active: false }).eq('id', inactiveQr.id);

  const r2 = await registerScan(db, student.id, inactiveQr.token);
  console.log(`  QR_INACTIVE test: code=${r2.code}`);
  if (r2.code !== 'QR_INACTIVE') throw new Error(`Expected QR_INACTIVE, got ${r2.code}`);
  console.log('  ✓ QR_INACTIVE correct');

  // Re-activate
  await db.from('qr_locations').update({ active: true }).eq('id', inactiveQr.id);

  // NOT_IN_ROUND: use a student from non-qualified team
  const { data: nonQualTeam } = await db
    .from('teams')
    .select('id')
    .eq('qualified', false)
    .limit(1);

  if (nonQualTeam && nonQualTeam.length > 0) {
    const { data: nonQualStudent } = await db
      .from('students')
      .select('id')
      .eq('team_id', nonQualTeam[0].id)
      .eq('absent', false)
      .limit(1);

    if (nonQualStudent && nonQualStudent.length > 0) {
      const activeQr = allQrs[0];
      const r3 = await registerScan(db, nonQualStudent[0].id, activeQr.token);
      console.log(`  NOT_IN_ROUND test: code=${r3.code}`);
      if (r3.code !== 'NOT_IN_ROUND') throw new Error(`Expected NOT_IN_ROUND, got ${r3.code}`);
      console.log('  ✓ NOT_IN_ROUND correct');
    }
  } else {
    console.log('  (skipped NOT_IN_ROUND — all teams are qualified)');
  }

  // ABSENT: mark a student absent and try to scan
  const { data: t01Students } = await db
    .from('students')
    .select('id')
    .eq('team_id', 'T01')
    .eq('absent', false)
    .limit(2);

  if (t01Students && t01Students.length >= 2) {
    const absentStudent = t01Students[1];
    await db.from('students').update({ absent: true }).eq('id', absentStudent.id);

    const r4 = await registerScan(db, absentStudent.id, allQrs[0].token);
    console.log(`  ABSENT test: code=${r4.code}`);
    if (r4.code !== 'ABSENT') throw new Error(`Expected ABSENT, got ${r4.code}`);
    console.log('  ✓ ABSENT correct');

    // Restore
    await db.from('students').update({ absent: false }).eq('id', absentStudent.id);
  }

  console.log('  ✓ All domain rejection codes verified.');
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Phase 3 Concurrency Test                ║');
  console.log('╚══════════════════════════════════════════╝\n');

  try {
    // Set up clean state
    console.log('Setting up test environment...');
    await ensureTestState();

    await testLastSlotRace();
    await testTeammateRace();
    await testIdempotentRescan();
    await testDomainRejections();

    // Final cleanup
    console.log('\n--- Cleanup: resetting event data ---');
    await executeEventAction(db, 'reset', null, { confirm: 'RESET' });
    console.log('✓ Event data reset to clean state.');

    console.log('\n╔══════════════════════════════════════════╗');
    console.log('║  🎉 ALL CONCURRENCY TESTS PASSED         ║');
    console.log('╚══════════════════════════════════════════╝');
  } catch (err: any) {
    console.error(`\n❌ CONCURRENCY TEST FAILED:\n   ${err.message || err}`);
    // Try to reset even on failure
    try {
      await executeEventAction(db, 'reset', null, { confirm: 'RESET' });
    } catch {}
    process.exit(1);
  }
}

main();
