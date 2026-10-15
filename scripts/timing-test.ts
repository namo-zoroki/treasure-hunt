import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const TEAMS = ['T01', 'T02'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}

// Tries each argument shape in turn, because I haven't seen your exact function signatures.
async function rpc(name: string, variants: Record<string, unknown>[]) {
  let lastErr: unknown;
  for (const args of variants) {
    const { data, error } = await db.rpc(name, args);
    if (!error) {
      if (data && typeof data === 'object' && (data as any).ok === false) {
        throw new Error(`${name} rejected: ${JSON.stringify(data)}`);
      }
      return data;
    }
    lastErr = error;
  }
  throw new Error(`${name} failed: ${JSON.stringify(lastErr)}`);
}
const admin = (name: string) => rpc(name, [{ p_admin_id: null }, {}]);
const eventNow = async () => Number(await rpc('event_now_ms', [{}]));
async function setSetting(key: string, value: number) {
  const { error } = await db.from('settings').update({ value }).eq('key', key);
  if (error) throw error;
}
async function state() {
  const { data, error } = await db.from('event_state').select('*').eq('id', 1).single();
  if (error) throw error;
  return data as any;
}

async function main() {
  console.log('--- Setup ---');
  await rpc('reset_event_data', [{ p_admin_id: null, p_confirm: 'RESET' }]);
  await setSetting('run_cap_minutes', 2);
  await setSetting('r2_minutes', 4);

  const { data: studs } = await db.from('students').select('id,team_id,is_captain').in('team_id', TEAMS);
  const captain: Record<string, string> = {};
  for (const s of studs ?? []) if (s.is_captain) captain[s.team_id] = s.id;
  const { data: qrs } = await db.from('qr_locations').select('id,token').eq('active', true).order('id').limit(3);
  if (!qrs || qrs.length < 2 || TEAMS.some((t) => !captain[t])) throw new Error('Need seed data: 2 teams with captains, 2+ QRs');

  await admin('start_round1');
  await admin('end_round1');
  const q = await db.from('teams').update({ qualified: true }).in('id', TEAMS);
  if (q.error) throw q.error;

  console.log('--- start_round2 (real path) ---');
  await admin('start_round2');
  const st = await state();
  const start = Number(st.r2_start_ms);
  check('phase is r2_running', st.phase === 'r2_running', st.phase);
  check('run2_open = start + 2 min', Number(st.run2_open_ms) - start === 120000, `${Number(st.run2_open_ms) - start}ms`);
  check('hard_end = start + 4 min', Number(st.r2_hard_end_ms) - start === 240000, `${Number(st.r2_hard_end_ms) - start}ms`);

  const { data: runs1 } = await db.from('team_run').select('*').in('team_id', TEAMS).eq('run', 1);
  check('run 1 created for both teams', runs1?.length === 2);
  check('run 1 deadline = start + 2 min', (runs1 ?? []).every((r: any) => Number(r.deadline_ms) - start === 120000));

  const scan1 = await db.rpc('register_scan', { p_student: captain.T01, p_token: qrs[0].token });
  check('T01 scan in run 1 succeeds', scan1.data?.ok === true && scan1.data?.run === 1, JSON.stringify(scan1.data ?? scan1.error));

  console.log('--- polling with advance_event (about 4 min) ---');
  let did2 = false, breakChecked = false;
  const wallStart = Date.now();
  let lastLine = '';
  while (Date.now() - wallStart < 6 * 60 * 1000) {
    await rpc('advance_event', [{}]);
    const s = await state();
    const now = await eventNow();
    const { data: tr } = await db.from('team_run').select('team_id,run,opens_ms,deadline_ms').in('team_id', TEAMS).order('team_id').order('run');
    const line = `${s.phase} | ${tr?.map((r: any) => `${r.team_id}:run${r.run}`).join(' ')}`;
    if (line !== lastLine) {
      console.log(`t=${Math.round((now - start) / 1000)}s  ${line}`);
      lastLine = line;
    }

    if (!did2 && now >= Number(s.run2_open_ms) + 2000) {
      did2 = true;
      const r2 = (tr ?? []).filter((r: any) => r.run === 2);
      check('run 2 created for both teams at 2 min', r2.length === 2);
      check('run 2 opens_ms = run2_open_ms', r2.every((r: any) => Number(r.opens_ms) === Number(s.run2_open_ms)));
      check('run 2 deadline = hard_end (capped)', r2.every((r: any) => Number(r.deadline_ms) === Number(s.r2_hard_end_ms)));
      const scan2 = await db.rpc('register_scan', { p_student: captain.T01, p_token: qrs[1].token });
      check('T01 scan in run 2 succeeds', scan2.data?.ok === true && scan2.data?.run === 2, JSON.stringify(scan2.data ?? scan2.error));
    }

    if (!breakChecked && s.phase === 'r2_break') {
      breakChecked = true;
      const lateBy = now - Number(s.r2_hard_end_ms);
      check('break started within 6s of hard end', lateBy >= 0 && lateBy < 6000, `${lateBy}ms late`);
      check('break_end = hard_end + 3 min', Number(s.break_end_ms) - Number(s.r2_hard_end_ms) === 180000);
      const late = await db.rpc('register_scan', { p_student: captain.T02, p_token: qrs[0].token });
      check('scan after hard end is rejected', late.data?.ok === false, late.data?.code);
      const { count } = await db.from('attempts').select('id', { count: 'exact', head: true }).in('team_id', TEAMS);
      check('no attempts written for unanswered runs', count === 0, `${count} rows`);
      const { data: pts } = await db.from('r2_standings').select('team_id,points').in('team_id', TEAMS);
      check('expired teams score 0', (pts ?? []).every((p: any) => p.points === 0), JSON.stringify(pts));
      break;
    }
    await sleep(3000);
  }
  if (!breakChecked) check('phase reached r2_break', false, 'timed out');

  console.log('--- Cleanup ---');
  await setSetting('run_cap_minutes', 30);
  await setSetting('r2_minutes', 60);
  await rpc('reset_event_data', [{ p_admin_id: null, p_confirm: 'RESET' }]);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });