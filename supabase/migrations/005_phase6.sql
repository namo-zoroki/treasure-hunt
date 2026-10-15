-- 005_phase6.sql: Rest of admin panel atomic functions (Sections 6.7, 9)
-- Safe to re-run. Run after 004_phase5.sql in Supabase SQL editor.

-- 1. set_captain(p_team text, p_student text, p_admin_id int)
-- Clears current captain and sets the new captain in one transaction
create or replace function set_captain(p_team text, p_student text, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_student record;
  v_prev_captain record;
begin
  perform advance_event();

  -- Verify target student belongs to the team
  select * into v_student from students where id = p_student and team_id = p_team for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student does not exist or is not in this team');
  end if;

  if v_student.absent then
    return jsonb_build_object('ok', false, 'code', 'STUDENT_ABSENT', 'message', 'Cannot make an absent student captain');
  end if;

  -- Lock team row
  perform 1 from teams where id = p_team for update;

  -- Find current captain
  select * into v_prev_captain from students where team_id = p_team and is_captain = true for update;

  if v_prev_captain.id = p_student then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  -- Clear previous captain
  if found then
    update students set is_captain = false where id = v_prev_captain.id;
  end if;

  -- Set new captain
  update students set is_captain = true where id = p_student;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'set_captain',
    p_team,
    jsonb_build_object('captain_id', v_prev_captain.id),
    jsonb_build_object('captain_id', p_student)
  );

  return jsonb_build_object('ok', true, 'captainId', p_student);
end;
$$;

-- 2. edit_team_n(p_team text, p_n int, p_admin_id int)
-- Allowed only before phase r2_running
create or replace function edit_team_n(p_team text, p_n int, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_team record;
  v_state record;
  v_member_count int;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1;

  if v_state.phase in ('r2_running', 'r2_break', 'r3_open', 'ended') then
    return jsonb_build_object('ok', false, 'code', 'PHASE_LOCKED', 'message', 'Team size cannot be modified once Round 2 has started');
  end if;

  if p_n < 3 or p_n > 5 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_N', 'message', 'Team size must be between 3 and 5');
  end if;

  select * into v_team from teams where id = p_team for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Team not found');
  end if;

  -- Verify current non-absent students count
  select count(*) into v_member_count from students where team_id = p_team;
  if v_member_count > p_n then
    return jsonb_build_object('ok', false, 'code', 'TOO_MANY_STUDENTS', 'message', format('Team currently has %s registered members', v_member_count));
  end if;

  update teams set n = p_n where id = p_team;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'edit_team_n',
    p_team,
    jsonb_build_object('n', v_team.n),
    jsonb_build_object('n', p_n)
  );

  return jsonb_build_object('ok', true, 'n', p_n);
end;
$$;

-- 3. set_qualified(p_team text, p_qualified boolean, p_admin_id int)
-- Allowed only in r1_closed
create or replace function set_qualified(p_team text, p_qualified boolean, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_team record;
  v_state record;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1;

  if v_state.phase <> 'r1_closed' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Qualifying teams is only allowed during r1_closed phase');
  end if;

  select * into v_team from teams where id = p_team for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Team not found');
  end if;

  update teams set qualified = p_qualified where id = p_team;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'set_qualified',
    p_team,
    jsonb_build_object('qualified', v_team.qualified),
    jsonb_build_object('qualified', p_qualified)
  );

  return jsonb_build_object('ok', true, 'qualified', p_qualified);
end;
$$;

-- 4. admin_register(p_student text, p_qr_id int, p_run int, p_admin_id int)
-- Same as register_scan but ignores QR capacity
create or replace function admin_register(
  p_student text,
  p_qr_id int,
  p_run int default null,
  p_admin_id int default null
) returns jsonb language plpgsql as $$
declare
  v_student record;
  v_team record;
  v_qr record;
  v_run int;
  v_now bigint;
  v_free_slot int;
  v_free_piece int;
  v_state record;
begin
  perform advance_event();
  v_now := event_now_ms();
  select * into v_state from event_state where id = 1;

  if v_state.phase <> 'r2_running' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Round 2 is not running');
  end if;

  select * into v_student from students where id = p_student;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Student not found');
  end if;

  select * into v_team from teams where id = v_student.team_id;
  if not found or not v_team.qualified or v_team.withdrawn then
    return jsonb_build_object('ok', false, 'code', 'NOT_IN_ROUND', 'message', 'Team is not qualified or withdrawn');
  end if;

  select * into v_qr from qr_locations where id = p_qr_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'INVALID_QR', 'message', 'QR location not found');
  end if;

  -- Determine target run
  if p_run is not null then
    v_run := p_run;
  else
    select run into v_run from team_run
     where team_id = v_team.id and opens_ms <= v_now
     order by run desc limit 1;
  end if;

  if v_run is null then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Team run is not open');
  end if;

  -- Lock team and QR
  perform 1 from qr_locations where id = v_qr.id for update;
  perform 1 from teams where id = v_team.id for update;

  -- Check student registration in this run
  if exists (select 1 from registrations where student_id = v_student.id and run = v_run and qr_id = v_qr.id) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if exists (select 1 from registrations where student_id = v_student.id and run = v_run) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REGISTERED', 'message', 'Student already registered for this run');
  end if;

  -- Check teammate at same QR in this run
  if exists (select 1 from registrations where team_id = v_team.id and qr_id = v_qr.id and run = v_run) then
    return jsonb_build_object('ok', false, 'code', 'TEAMMATE_HERE', 'message', 'Teammate already registered at this location');
  end if;

  -- Check student reuse of QR across runs
  if exists (select 1 from registrations where student_id = v_student.id and qr_id = v_qr.id) then
    return jsonb_build_object('ok', false, 'code', 'QR_USED_BEFORE', 'message', 'Student previously registered at this location');
  end if;

  -- Check team piece limit
  if (select count(*) from piece_assignments where team_id = v_team.id and run = v_run) >= v_team.n then
    return jsonb_build_object('ok', false, 'code', 'TEAM_COMPLETE', 'message', 'Team already has all pieces assigned');
  end if;

  -- Choose smallest free slot_no (ignoring capacity limit)
  select coalesce(max(slot_no), 0) + 1 into v_free_slot
  from registrations where qr_id = v_qr.id and run = v_run;

  -- Smallest free piece_no from 1 to N
  select p into v_free_piece
  from generate_series(1, v_team.n) p
  where not exists (
    select 1 from piece_assignments pa where pa.team_id = v_team.id and pa.run = v_run and pa.piece_no = p
  )
  order by p limit 1;

  if v_free_piece is null then
    return jsonb_build_object('ok', false, 'code', 'TEAM_COMPLETE', 'message', 'Team already has all pieces assigned');
  end if;

  insert into registrations (run, team_id, student_id, qr_id, slot_no, created_ms)
  values (v_run, v_team.id, v_student.id, v_qr.id, v_free_slot, v_now);

  insert into piece_assignments (run, team_id, piece_no, student_id, via)
  values (v_run, v_team.id, v_free_piece, v_student.id, 'admin');

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'admin_register',
    v_student.id,
    null,
    jsonb_build_object('qr_id', v_qr.id, 'run', v_run, 'slot_no', v_free_slot, 'piece_no', v_free_piece)
  );

  return jsonb_build_object('ok', true, 'run', v_run, 'piece_no', v_free_piece, 'qr_name', v_qr.name);
end;
$$;

-- 5. reset_attempts(p_team text, p_item_id int, p_kind text, p_admin_id int)
-- Resets attempts for a team and question/riddle
create or replace function reset_attempts(
  p_team text,
  p_item_id int,
  p_kind text,
  p_admin_id int default null
) returns jsonb language plpgsql as $$
declare
  v_deleted int;
begin
  perform advance_event();

  if p_kind = 'r1' then
    delete from attempts
     where team_id = p_team and riddle_id = p_item_id;
    get diagnostics v_deleted = row_count;
  elsif p_kind = 'r2' then
    delete from attempts
     where team_id = p_team and question_id = p_item_id;
    get diagnostics v_deleted = row_count;
  else
    return jsonb_build_object('ok', false, 'code', 'INVALID_KIND', 'message', 'Kind must be r1 or r2');
  end if;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'reset_attempts',
    p_team || ':' || p_kind || ':' || p_item_id,
    jsonb_build_object('deleted_count', v_deleted),
    null
  );

  return jsonb_build_object('ok', true, 'deletedAttempts', v_deleted);
end;
$$;

-- 6. update_setting(p_key text, p_value jsonb, p_admin_id int)
-- Validates phase-based setting lock rules (Section 3) and logs change
create or replace function update_setting(p_key text, p_value jsonb, p_admin_id int default null)
returns jsonb language plpgsql as $$
declare
  v_state record;
  v_old jsonb;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1;

  select value into v_old from settings where key = p_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', 'Unknown setting key');
  end if;

  -- Check locking rules from Section 3
  if p_key in ('r1_minutes', 'r1_points_per_riddle', 'tries_r1') and v_state.phase <> 'setup' then
    return jsonb_build_object('ok', false, 'code', 'SETTING_LOCKED', 'message', 'Setting locked once setup phase completes');
  end if;

  if p_key in ('r2_minutes', 'run_cap_minutes', 'run_total_points', 'tries_r2') and v_state.phase in ('r2_running', 'r2_break', 'r3_open', 'ended') then
    return jsonb_build_object('ok', false, 'code', 'SETTING_LOCKED', 'message', 'Setting locked once Round 2 starts');
  end if;

  update settings set value = p_value where key = p_key;

  insert into admin_log (admin_id, action, target, before, after)
  values (
    p_admin_id,
    'update_setting',
    p_key,
    jsonb_build_object('value', v_old),
    jsonb_build_object('value', p_value)
  );

  return jsonb_build_object('ok', true, 'key', p_key, 'value', p_value);
end;
$$;

-- Permissions grant
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
