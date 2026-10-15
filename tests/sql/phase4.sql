\set ON_ERROR_STOP on
\set QUIET on
-- helper: register team members at distinct QRs
create or replace function t_register(p_team text, p_n int, p_qr_offset int) returns void language plpgsql as $$
declare k int; r jsonb;
begin
  for k in 1..p_n loop
    r := register_scan('S'||substr(p_team,2)||k, 'tok'||(k + p_qr_offset));
    perform t_assert((r->>'ok')::boolean, 'register '||p_team||k||' '||r::text);
  end loop;
end $$;

do $$
declare r jsonb; ts jsonb; n int; fin bool; s text;
begin
  -- 1) teaser gating (T01, n=3)
  perform register_scan('S011','tok1'); perform register_scan('S012','tok2');
  r := solve_teaser('S011','the answer'); perform t_assert(r->>'code'='TEASER_NOT_READY','not ready: '||r::text);
  perform register_scan('S013','tok3');
  r := solve_teaser('S012','the answer'); perform t_assert(r->>'code'='NOT_CAPTAIN','not captain: '||r::text);
  r := solve_teaser('S011','wrong');      perform t_assert(r->>'code'='TEASER_WRONG','wrong: '||r::text);
  perform t_assert((select count(*) from team_questions where team_id='T01')=0,'no questions before solve');
  r := solve_teaser('S011','  The   ANSWER ');  perform t_assert((r->>'ok')::boolean,'solve normalised: '||r::text);
  r := solve_teaser('S011','the answer'); perform t_assert((r->>'already')::boolean,'idempotent: '||r::text);
  perform t_assert((select count(*) from team_questions where team_id='T01')=3,'3 questions');
  perform t_assert((select count(distinct slot) from team_questions where team_id='T01')=3,'3 distinct slots');
  perform t_assert((select array_agg(question_no order by question_no) from team_questions where team_id='T01')='{1,2,3}','question_no 1..3');

  -- 2) answers on question 1: wrong then right -> half points (n=3: full 40, half 20)
  r := submit_answer('S012','r2',1,'a',gen_random_uuid()); perform t_assert(r->>'code'='NOT_CAPTAIN','member cannot submit: '||r::text);
  r := submit_answer('S011','r2',1,'z',gen_random_uuid()); perform t_assert(r->>'code'='INVALID_OPTION','invalid option: '||r::text);
  r := submit_answer('S011','r2',9,'a',gen_random_uuid()); perform t_assert(r->>'code'='CONTENT_MISSING','bad key: '||r::text);
  r := submit_answer('S011','r2',1,'a','00000000-0000-0000-0000-000000000001'); perform t_assert(r->>'status'='wrong_one_left','wrong1: '||r::text);
  r := submit_answer('S011','r2',1,'a','00000000-0000-0000-0000-000000000001'); perform t_assert(r->>'status'='wrong_one_left','dup same result: '||r::text);
  perform t_assert((select count(*) from attempts where team_id='T01')=1,'dup inserted nothing');
  r := submit_answer('S011','r2',1,'c',gen_random_uuid()); perform t_assert(r->>'status'='correct','correct on try 2: '||r::text);
  perform t_assert((select points from attempts where team_id='T01' and try_no=2)=20,'half points = 20');
  r := submit_answer('S011','r2',1,'c',gen_random_uuid()); perform t_assert(r->>'code'='ALREADY_DONE','already done: '||r::text);

  -- question 2: correct first try -> 40
  r := submit_answer('S011','r2',2,'c',gen_random_uuid()); perform t_assert(r->>'status'='correct' and not (r->>'runFinished')::boolean,'q2: '||r::text);
  perform t_assert((select points from attempts where team_id='T01' and try_no=1 and points>0)=40,'full points = 40');

  -- 3) player_state leaks nothing before the run finishes
  ts := player_state('S011'); s := ts::text;
  perform t_assert(s not like '%correct_option_id%' and s not like '%answer_norm%' and s not like '%password%' and s not like '%points%','state has no secrets');
  perform t_assert(regexp_count(s,'Stem r1')=1,'captain sees only the one stem he holds');
  perform t_assert(jsonb_array_length(ts->'board')=3,'captain board has 3');
  ts := player_state('S012'); perform t_assert(jsonb_array_length(ts->'board')=0,'member has no board');
  perform t_assert(jsonb_array_length(ts->'mine')=1 and (ts->'mine'->0->>'stem') like 'Stem r1%','member sees only own stem');

  -- question 3: two wrongs -> locked, then run finished and run 2 opens
  r := submit_answer('S011','r2',3,'a',gen_random_uuid()); perform t_assert(r->>'status'='wrong_one_left','q3 w1');
  r := submit_answer('S011','r2',3,'b',gen_random_uuid()); perform t_assert(r->>'status'='locked' and (r->>'runFinished')::boolean,'q3 locked+finished: '||r::text);
  r := submit_answer('S011','r2',3,'c',gen_random_uuid()); perform t_assert(r->>'code' in ('WRONG_PHASE','LOCKED','TEASER_NOT_READY'),'old run closed; run 2 current: '||r::text);
  perform t_assert((select finished_ms from team_run where team_id='T01' and run=1) is not null,'run 1 finished');
  perform t_assert((select count(*) from team_run where team_id='T01' and run=2)=1,'run 2 created on finish');
  -- run 2 is now current: scanning works again, the QR used before is refused
  r := register_scan('S011','tok1'); perform t_assert(r->>'code'='QR_USED_BEFORE','QR_USED_BEFORE across runs: '||r::text);
  r := register_scan('S011','tok4'); perform t_assert((r->>'ok')::boolean and (r->>'run')::int=2,'run 2 scan: '||r::text);

  -- 4) cancel/skip path and points for n=4 and n=5
  perform t_register('T11',4,0); perform solve_teaser('S111','the answer');
  r := submit_answer('S111','r2',1,'c',gen_random_uuid());
  perform t_assert((select points from attempts where team_id='T11' limit 1)=30,'n=4 full = 30');
  perform t_register('T16',5,0); perform solve_teaser('S161','the answer');
  r := submit_answer('S161','r2',1,'c',gen_random_uuid());
  perform t_assert((select points from attempts where team_id='T16' limit 1)=24,'n=5 full = 24');

  -- 5) skip_teaser (admin) unblocks a team that never scanned
  r := skip_teaser('T02',1,null); perform t_assert((r->>'ok')::boolean,'skip: '||r::text);
  perform t_assert((select count(*) from team_questions where team_id='T02')=3,'skip assigns questions');
  perform t_assert((select count(*) from admin_log where action='skip_teaser')=1,'skip logged');
  r := submit_answer('S021','r2',1,'c',gen_random_uuid()); perform t_assert(r->>'status'='correct','answer after skip: '||r::text);

  -- 6) deadline, pause
  update team_run set deadline_ms = 0 where team_id='T02' and run=1;
  r := submit_answer('S021','r2',2,'c',gen_random_uuid()); perform t_assert(r->>'code'='WRONG_PHASE','after deadline: '||r::text);
  perform pause_event();
  r := submit_answer('S011','r2',1,'c',gen_random_uuid()); perform t_assert(r->>'code'='PAUSED','paused: '||r::text);
  r := solve_teaser('S011','x'); perform t_assert(r->>'code'='PAUSED','teaser paused: '||r::text);
  perform resume_event();
end $$;

-- 7) fair distribution: every team in T03..T10 and T12..T15, T17..T20 solves; slots/variants stay balanced
do $$
declare g int; n int; k int;
begin
  for g in 3..10 loop perform t_register('T'||lpad(g::text,2,'0'),3,0); perform solve_teaser('S'||lpad(g::text,2,'0')||'1','the answer'); end loop;
  for g in 12..15 loop perform t_register('T'||lpad(g::text,2,'0'),4,0); perform solve_teaser('S'||lpad(g::text,2,'0')||'1','the answer'); end loop;
  for g in 17..20 loop perform t_register('T'||lpad(g::text,2,'0'),5,0); perform solve_teaser('S'||lpad(g::text,2,'0')||'1','the answer'); end loop;
  perform t_assert((select count(*) from team_questions where run=1)= 3*10 + 4*5 + 5*5, 'total assignments');
  perform t_assert((select max(c)-min(c) from (select slot, count(*) c from team_questions where run=1 group by slot) x) <= 1, 'slot usage within 1');
  perform t_assert((select max(c)-min(c) from (select question_id, count(*) c from team_questions where run=1 and slot=1 group by question_id) x) <= 1, 'variant usage within 1');
end $$;
\echo PHASE4 SQL TESTS PASSED
