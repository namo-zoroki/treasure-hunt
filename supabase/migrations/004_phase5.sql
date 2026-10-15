-- 004_phase5.sql: Run timing, void question, absent management, cancel registration (Sections 4.3, 4.5, 6.7)
-- Safe to re-run. Run after 003_phase4.sql.

-- Admin function: mark_absent
create or replace function mark_absent(p_student text, p_move_to text, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_student record;
  v_target record;
  v_team record;
  v_now bigint;
  v_run record;
  v_piece int;
begin
  perform advance_event();

  select * into v_student from students where id = p_student;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student not found');
  end if;

  select * into v_target from students where id = p_move_to;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MOVE_TO', 'message', 'Target teammate not found');
  end if;

  if v_target.team_id <> v_student.team_id then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MOVE_TO', 'message', 'Target teammate must be in the same team');
  end if;

  if v_target.id = v_student.id then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MOVE_TO', 'message', 'Cannot move pieces to the absent student');
  end if;

  if v_target.absent then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MOVE_TO', 'message', 'Target teammate is marked absent');
  end if;

  select * into v_team from teams where id = v_student.team_id for update;

  update students set absent = true where id = p_student;

  v_now := event_now_ms();
  select * into v_run from team_run
   where team_id = v_team.id and opens_ms <= v_now
   order by run desc limit 1;

  if found then
    -- Any piece already held by the absent student is reassigned to move_to
    update piece_assignments
       set student_id = p_move_to, via = 'admin'
     where team_id = v_team.id and run = v_run.run and student_id = p_student;

    -- Every piece number from 1 to N that has no assignment is assigned to move_to
    for v_piece in 1..v_team.n loop
      if not exists (
        select 1 from piece_assignments pa
        where pa.team_id = v_team.id and pa.run = v_run.run and pa.piece_no = v_piece
      ) then
        insert into piece_assignments (run, team_id, piece_no, student_id, via)
        values (v_run.run, v_team.id, v_piece, p_move_to, 'admin')
        on conflict (run, team_id, piece_no) do update set student_id = p_move_to, via = 'admin';
      end if;
    end loop;
  end if;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'mark_absent',
    p_student,
    jsonb_build_object('absent', v_student.absent),
    jsonb_build_object('absent', true, 'move_to', p_move_to)
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- Admin function: unmark_absent
create or replace function unmark_absent(p_student text, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_student record;
begin
  perform advance_event();

  select * into v_student from students where id = p_student;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student not found');
  end if;

  update students set absent = false where id = p_student;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'unmark_absent',
    p_student,
    jsonb_build_object('absent', v_student.absent),
    jsonb_build_object('absent', false)
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- Admin function: cancel_registration
create or replace function cancel_registration(p_registration_id bigint, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_reg record;
begin
  perform advance_event();

  select * into v_reg from registrations where id = p_registration_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Registration not found');
  end if;

  perform 1 from teams where id = v_reg.team_id for update;

  -- Delete matching piece assignment if its holder is that student
  delete from piece_assignments
   where team_id = v_reg.team_id and run = v_reg.run and student_id = v_reg.student_id;

  -- Delete the registration (frees slot_no)
  delete from registrations where id = p_registration_id;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'cancel_registration',
    p_registration_id::text,
    jsonb_build_object('team_id', v_reg.team_id, 'student_id', v_reg.student_id, 'qr_id', v_reg.qr_id, 'run', v_reg.run, 'slot_no', v_reg.slot_no),
    null
  );

  return jsonb_build_object('ok', true);
end;
$$;

-- Admin function: void_question
create or replace function void_question(
  p_team text,
  p_question_id int,
  p_reason text,
  p_admin_id int default null
) returns jsonb language plpgsql as $$
declare
  v_reason text;
  v_now bigint;
  v_full int;
  v_earned int;
  v_adj int;
  v_count int := 0;
  v_unresolved int;
  v_cap_ms bigint;
  v_run_row record;
  v_state record;
  v_tq record;
  v_team record;
  v_rec record;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1;

  v_reason := trim(coalesce(p_reason, ''));
  if v_reason = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED', 'message', 'A reason is required to void a question');
  end if;

  if not exists (select 1 from questions where id = p_question_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Question not found');
  end if;

  v_now := event_now_ms();

  for v_rec in
    select distinct team_id
      from team_questions
     where question_id = p_question_id
       and not voided
       and (p_team is null or p_team = '' or team_id = p_team)
  loop
    select * into v_team from teams where id = v_rec.team_id for update;
    select * into v_tq from team_questions
     where team_id = v_team.id and question_id = p_question_id
       for update;

    -- Mark voided
    update team_questions
       set voided = true
     where team_id = v_team.id and question_id = p_question_id;

    -- Calculate points adjustment: full - points already earned on that question (never negative)
    v_full := floor(setting_int('run_total_points', 120)::numeric / v_team.n);
    select coalesce(sum(points), 0)::int into v_earned
      from attempts
     where team_id = v_team.id and question_id = p_question_id and correct = true;

    v_adj := greatest(0, v_full - v_earned);

    insert into score_adjustments (team_id, run, question_id, points, reason, admin_id, created_ms)
    values (v_team.id, v_tq.run, p_question_id, v_adj, v_reason, p_admin_id, v_now);

    -- Re-evaluate run-finished
    select count(*) into v_unresolved
      from team_questions tq
     where tq.team_id = v_team.id and tq.run = v_tq.run and not tq.voided
       and not exists (select 1 from attempts a where a.team_id = tq.team_id and a.question_id = tq.question_id and a.correct)
       and (select count(*) from attempts a where a.team_id = tq.team_id and a.question_id = tq.question_id) < setting_int('tries_r2', 2);

    if v_unresolved = 0 then
      select * into v_run_row from team_run
       where team_id = v_team.id and run = v_tq.run
         for update;
      if found and v_run_row.finished_ms is null then
        update team_run
           set finished_ms = v_now
         where team_id = v_team.id and run = v_tq.run;

        if v_tq.run = 1
           and not exists (select 1 from team_run where team_id = v_team.id and run = 2)
           and v_state.phase = 'r2_running' then
          v_cap_ms := setting_int('run_cap_minutes', 30)::bigint * 60000;
          insert into team_run (team_id, run, opens_ms, deadline_ms)
          values (v_team.id, 2, v_now, least(v_now + v_cap_ms, v_state.r2_hard_end_ms));
        end if;
      end if;
    end if;

    insert into admin_log (admin_id, action, target, before, after)
    values (
      p_admin_id,
      'void_question',
      v_team.id || ':q' || p_question_id,
      jsonb_build_object('voided', false),
      jsonb_build_object('voided', true, 'points_adjusted', v_adj, 'reason', v_reason)
    );

    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('ok', true, 'affectedTeams', v_count);
end;
$$;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
