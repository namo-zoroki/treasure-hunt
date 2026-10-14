import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Error: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
});

async function main() {
  console.log('Testing connection to Supabase...');

  const { data: eventStateData, error: eventStateErr } = await supabase
    .from('event_state')
    .select('*')
    .limit(1);

  if (eventStateErr) {
    console.log('Table event_state check:', eventStateErr.message);
  } else {
    console.log('Table event_state exists! Data:', eventStateData);
  }

  const { data: rpcData, error: rpcErr } = await supabase.rpc('event_now_ms');

  if (rpcErr) {
    console.log('RPC event_now_ms check:', rpcErr.message);
  } else {
    console.log('RPC event_now_ms succeeded! Value:', rpcData);
  }
}

main().catch((err) => {
  console.error('Fatal error in test-db:', err);
  process.exit(1);
});
