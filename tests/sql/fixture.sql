-- Scratch-database fixture for the SQL tests. NEVER run against a real event database.
create or replace function t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if; end $$;

-- teams T01-T10 (n=3), T11-T15 (n=4), T16-T20 (n=5); S<team><k>, k=1 is captain
insert into teams(id,name,n,qualified)
  select 'T'||lpad(g::text,2,'0'),'Team '||g, case when g<=10 then 3 when g<=15 then 4 else 5 end, true from generate_series(1,20) g;
insert into students(id,name,team_id,is_captain,code_hash)
  select 'S'||lpad(g::text,2,'0')||k,'Student '||g||'-'||k,'T'||lpad(g::text,2,'0'),k=1,'x'
  from generate_series(1,20) g, generate_series(1,5) k
  where k <= case when g<=10 then 3 when g<=15 then 4 else 5 end;
insert into qr_locations(name,token,capacity) select 'Place '||g,'tok'||g,40 from generate_series(1,8) g;
insert into teaser_puzzles(run,size,pieces,answer_norm)
  select r,s,(select jsonb_agg('piece'||r||s||p) from generate_series(1,s) p),'the answer' from generate_series(1,2) r, generate_series(3,5) s;
insert into questions(run,slot,variant,qr_id,stem,options,correct_option_id)
  select r,s,v,(s % 8)+1,'Stem r'||r||' s'||s||' v'||v,
    (select jsonb_agg(jsonb_build_object('id',chr(96+o),'text','opt '||o)) from generate_series(1,8) o),'c'
  from generate_series(1,2) r, generate_series(1,5) s, generate_series(1,2) v;
select start_round1(); select end_round1(); select start_round2();
