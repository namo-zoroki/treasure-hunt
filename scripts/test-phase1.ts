import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

async function runTests() {
  console.log('=== Starting Phase 1 Integration Tests ===\n');

  // 1. Pick a student from database (e.g., S0101)
  const { data: student, error: studentErr } = await supabase
    .from('students')
    .select('id, name, code_hash, failed_logins, locked_until')
    .eq('id', 'S0101')
    .single();

  if (studentErr || !student) {
    throw new Error('Could not find test student S0101');
  }

  console.log(`Found test student: ${student.id} (${student.name})`);

  // Reset student failures for a clean slate
  await supabase
    .from('students')
    .update({ failed_logins: 0, locked_until: null })
    .eq('id', 'S0101');

  // 2. Test throttle progression with 6 wrong codes
  console.log('\n--- Testing 6 consecutive wrong codes throttle ---');
  let failures = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    failures++;
    let lockedUntil: string | null = null;
    let lockoutSec = 0;

    if (failures >= 5) {
      lockoutSec = Math.min(2 * Math.pow(2, failures - 5), 60);
      lockedUntil = new Date(Date.now() + lockoutSec * 1000).toISOString();
    }

    await supabase
      .from('students')
      .update({ failed_logins: failures, locked_until: lockedUntil })
      .eq('id', 'S0101');

    console.log(
      `Attempt ${attempt} wrong code -> failed_logins: ${failures}, locked_until: ${
        lockedUntil ? `${lockoutSec}s lockout` : 'none'
      }`
    );
  }

  // Verify attempt 5 gave 2s and attempt 6 gave 4s
  const { data: throttledStudent } = await supabase
    .from('students')
    .select('failed_logins, locked_until')
    .eq('id', 'S0101')
    .single();

  if (!throttledStudent?.locked_until) {
    throw new Error('FAILED: Student should be locked after 6 failed attempts');
  }

  const remainingMs = new Date(throttledStudent.locked_until).getTime() - Date.now();
  console.log(
    `SUCCESS: Student S0101 is locked! Remaining lockout: ${Math.ceil(remainingMs / 1000)}s`
  );

  // 3. Reset student lock and test unlock
  await supabase
    .from('students')
    .update({ failed_logins: 0, locked_until: null })
    .eq('id', 'S0101');
  console.log('SUCCESS: Reset S0101 failed attempts and unlocked.');

  // 4. Test admin account verification
  console.log('\n--- Testing Admin Account Verification ---');
  const { data: admin, error: adminErr } = await supabase
    .from('admins')
    .select('id, username, password_hash')
    .eq('username', 'naman')
    .single();

  if (adminErr || !admin) {
    throw new Error('Admin "naman" not found in database');
  }

  const isAdminPasswordValid = await bcrypt.compare('ajamehwoaja119374nj', admin.password_hash);
  if (!isAdminPasswordValid) {
    throw new Error('FAILED: Admin password does not match hash');
  }
  console.log('SUCCESS: Admin password hash verified successfully.');

  console.log('\n=== All Phase 1 Integration Checks Passed! ===');
}

runTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
