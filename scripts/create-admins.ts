import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const seedAdmins = process.env.SEED_ADMINS;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
  process.exit(1);
}

async function main() {
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
    process.exit(1);
  }

  if (!seedAdmins) {
    console.error('Error: SEED_ADMINS environment variable is not set.');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  const adminEntries = seedAdmins
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  if (adminEntries.length === 0) {
    console.log('No admins found in SEED_ADMINS.');
    return;
  }

  if (adminEntries.length > 3) {
    console.warn('Warning: SEED_ADMINS specifies more than 3 admins. Only up to 3 are expected.');
  }

  for (const entry of adminEntries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) {
      console.error(`Invalid admin entry format (expected username:password): "${entry}"`);
      continue;
    }
    const username = entry.slice(0, colonIdx).trim();
    const password = entry.slice(colonIdx + 1).trim();

    if (!username || !password) {
      console.error(`Invalid admin credentials in entry: "${entry}"`);
      continue;
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const { data: existingAdmin, error: fetchErr } = await supabase
      .from('admins')
      .select('id, username')
      .eq('username', username)
      .maybeSingle();

    if (fetchErr) {
      console.error(`Error querying admin ${username}:`, fetchErr.message);
      continue;
    }

    if (existingAdmin) {
      const { error: updateErr } = await supabase
        .from('admins')
        .update({
          password_hash: passwordHash,
          failed_logins: 0,
          locked_until: null,
        })
        .eq('id', existingAdmin.id);

      if (updateErr) {
        console.error(`Failed to update admin ${username}:`, updateErr.message);
      } else {
        console.log(`Updated admin: ${username} (password reset, unlocked)`);
      }
    } else {
      const { error: insertErr } = await supabase.from('admins').insert({
        username,
        password_hash: passwordHash,
        failed_logins: 0,
        locked_until: null,
      });

      if (insertErr) {
        console.error(`Failed to insert admin ${username}:`, insertErr.message);
      } else {
        console.log(`Created admin: ${username}`);
      }
    }
  }

  console.log('Admin creation/update completed successfully.');
}

main().catch((err) => {
  console.error('Fatal error running create-admins:', err);
  process.exit(1);
});
