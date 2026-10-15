-- 002_functions.sql: Atomic functions for event state, phases, clock, and controls

create or replace function advance_event() returns void language plpgsql as $$
declare
  v_state record;
  v_now bigint;
  v_break_min bigint;
  v_cap_min bigint;
  v_hard_end bigint;
  v_cap_ms bigint;
  v_team record;
begin
  select * into v_state from event_state where id = 1 for update;
  if not found then
    return;
  end if;

  v_now := event_now_ms();

  -- 1. If r1_running and event_now >= r1_end_ms: set r1_closed
  if v_state.phase = 'r1_running' and v_state.r1_end_ms is not null and v_now >= v_state.r1_end_ms then
    update event_state set phase = 'r1_closed' where id = 1;
    v_state.phase := 'r1_closed';
  end if;

  -- 2. If r2_running and event_now >= r2_hard_end_ms: set r2_break and break_end_ms
  if v_state.phase = 'r2_running' and v_state.r2_hard_end_ms is not null and v_now >= v_state.r2_hard_end_ms then
    select coalesce((value #>> '{}')::bigint, 3) into v_break_min from settings where key = 'break_minutes';
    update event_state set
      phase = 'r2_break',
      break_end_ms = v_state.r2_hard_end_ms + (v_break_min * 60000)
    where id = 1;
    v_state.phase := 'r2_break';
    v_state.break_end_ms := v_state.r2_hard_end_ms + (v_break_min * 60000);
  end if;

  -- 3. If r2_running and event_now >= run2_open_ms: for every qualified, non-withdrawn team without a run 2 row,
  -- insert team_run run 2 with opens_ms = run2_open_ms, deadline_ms = min(opens + cap, hard_end)
  if v_state.phase = 'r2_running' and v_state.run2_open_ms is not null and v_now >= v_state.run2_open_ms then
    select coalesce((value #>> '{}')::bigint, 30) into v_cap_min from settings where key = 'run_cap_minutes';
    v_cap_ms := v_cap_min * 60000;
    v_hard_end := v_state.r2_hard_end_ms;

    for v_team in
      select t.id from teams t
      where t.qualified = true and t.withdrawn = false
        and not exists (select 1 from team_run tr where tr.team_id = t.id and tr.run = 2)
    loop
      insert into team_run (team_id, run, opens_ms, deadline_ms)
      values (
        v_team.id,
        2,
        v_state.run2_open_ms,
        case
          when v_hard_end is not null and (v_state.run2_open_ms + v_cap_ms) > v_hard_end then v_hard_end
          else v_state.run2_open_ms + v_cap_ms
        end
      )
      on conflict (team_id, run) do nothing;
    end loop;
  end if;
end;
$$;

create or replace function start_round1(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_now bigint;
  v_r1_min bigint;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;
  if v_state.phase <> 'setup' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Can only start Round 1 from setup phase');
  end if;

  v_before := to_jsonb(v_state);
  v_now := event_now_ms();
  select coalesce((value #>> '{}')::bigint, 30) into v_r1_min from settings where key = 'r1_minutes';

  update event_state set
    phase = 'r1_running',
    r1_end_ms = v_now + (v_r1_min * 60000)
  where id = 1
  returning * into v_state;

  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'start-r1', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'phase', v_state.phase, 'r1_end_ms', v_state.r1_end_ms);
end;
$$;

create or replace function end_round1(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;
  if v_state.phase <> 'r1_running' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Can only end Round 1 while running');
  end if;

  v_before := to_jsonb(v_state);

  update event_state set phase = 'r1_closed' where id = 1 returning * into v_state;
  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'end-r1', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'phase', v_state.phase);
end;
$$;

create or replace function start_round2(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_now bigint;
  v_r2_min bigint;
  v_cap_min bigint;
  v_qual_count int;
  v_cap_ms bigint;
  v_hard_end bigint;
  v_team record;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;
  if v_state.phase <> 'r1_closed' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Can only start Round 2 from r1_closed phase');
  end if;

  select count(*) into v_qual_count from teams where qualified = true and withdrawn = false;
  if v_qual_count = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_QUALIFIED_TEAMS', 'message', 'At least 1 qualified team is required to start Round 2');
  end if;

  v_before := to_jsonb(v_state);
  v_now := event_now_ms();
  select coalesce((value #>> '{}')::bigint, 60) into v_r2_min from settings where key = 'r2_minutes';
  select coalesce((value #>> '{}')::bigint, 30) into v_cap_min from settings where key = 'run_cap_minutes';

  v_cap_ms := v_cap_min * 60000;
  v_hard_end := v_now + (v_r2_min * 60000);

  update event_state set
    phase = 'r2_running',
    r2_start_ms = v_now,
    run2_open_ms = v_now + v_cap_ms,
    r2_hard_end_ms = v_hard_end
  where id = 1
  returning * into v_state;

  v_after := to_jsonb(v_state);

  -- Insert run 1 for every qualified team
  for v_team in select id from teams where qualified = true and withdrawn = false loop
    insert into team_run (team_id, run, opens_ms, deadline_ms)
    values (
      v_team.id,
      1,
      v_now,
      case when (v_now + v_cap_ms) > v_hard_end then v_hard_end else (v_now + v_cap_ms) end
    )
    on conflict (team_id, run) do nothing;
  end loop;

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'start-r2', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'phase', v_state.phase, 'r2_start_ms', v_state.r2_start_ms, 'r2_hard_end_ms', v_state.r2_hard_end_ms);
end;
$$;

create or replace function end_round2(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_now bigint;
  v_break_min bigint;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;
  if v_state.phase <> 'r2_running' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Can only end Round 2 while running');
  end if;

  v_before := to_jsonb(v_state);
  v_now := event_now_ms();
  select coalesce((value #>> '{}')::bigint, 3) into v_break_min from settings where key = 'break_minutes';

  update event_state set
    phase = 'r2_break',
    r2_hard_end_ms = v_now,
    break_end_ms = v_now + (v_break_min * 60000)
  where id = 1
  returning * into v_state;

  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'end-r2', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'phase', v_state.phase, 'break_end_ms', v_state.break_end_ms);
end;
$$;

create or replace function open_round3(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_now bigint;
  v_top_n bigint;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;
  if v_state.phase <> 'r2_break' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Can only open Round 3 from r2_break phase');
  end if;

  v_now := event_now_ms();
  if v_state.break_end_ms is not null and v_now < v_state.break_end_ms then
    return jsonb_build_object('ok', false, 'code', 'BREAK_NOT_OVER', 'message', 'Break has not ended yet');
  end if;

  v_before := to_jsonb(v_state);
  select coalesce((value #>> '{}')::bigint, 5) into v_top_n from settings where key = 'top_n_r3';

  update event_state set phase = 'r3_open' where id = 1 returning * into v_state;
  v_after := to_jsonb(v_state);

  -- Set teams.r3_eligible = true for teams whose rank() is <= top_n_r3; all others false
  update teams set r3_eligible = false;

  update teams t
  set r3_eligible = true
  from (
    select team_id, rank() over (order by points desc, last_ms asc nulls last) as rk
    from r2_standings
  ) ranked
  where t.id = ranked.team_id and ranked.rk <= v_top_n;

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'open-r3', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'phase', v_state.phase);
end;
$$;

create or replace function end_event(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;
  if v_state.phase <> 'r3_open' then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Can only end event from r3_open phase');
  end if;

  v_before := to_jsonb(v_state);

  update event_state set phase = 'ended' where id = 1 returning * into v_state;
  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'end-event', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'phase', v_state.phase);
end;
$$;

create or replace function pause_event(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
begin
  perform advance_event();
  select * into v_state from event_state where id = 1 for update;

  if v_state.phase not in ('r1_running', 'r2_running', 'r2_break', 'r3_open') then
    return jsonb_build_object('ok', false, 'code', 'WRONG_PHASE', 'message', 'Cannot pause in current phase');
  end if;

  if v_state.paused_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'paused', true);
  end if;

  v_before := to_jsonb(v_state);

  update event_state set paused_at = now() where id = 1 returning * into v_state;
  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'pause', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'paused', true, 'paused_at', v_state.paused_at);
end;
$$;

create or replace function resume_event(p_admin_id int default null) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_delta bigint;
begin
  select * into v_state from event_state where id = 1 for update;

  if v_state.paused_at is null then
    return jsonb_build_object('ok', true, 'already', true, 'paused', false);
  end if;

  v_before := to_jsonb(v_state);
  v_delta := ((extract(epoch from now()) - extract(epoch from v_state.paused_at)) * 1000)::bigint;

  update event_state set
    paused_total_ms = paused_total_ms + v_delta,
    paused_at = null
  where id = 1
  returning * into v_state;

  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'resume', 'event_state', v_before, v_after);

  perform advance_event();

  return jsonb_build_object('ok', true, 'paused', false, 'paused_total_ms', v_state.paused_total_ms);
end;
$$;

create or replace function add_time(p_admin_id int, p_minutes int) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_add_ms bigint;
begin
  if p_minutes is null or p_minutes <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PARAMS', 'message', 'Minutes must be greater than zero');
  end if;

  select * into v_state from event_state where id = 1 for update;
  v_before := to_jsonb(v_state);
  v_add_ms := (p_minutes::bigint * 60000);

  update event_state set
    paused_total_ms = paused_total_ms + v_add_ms
  where id = 1
  returning * into v_state;

  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'add-time', 'event_state', v_before, v_after);

  perform advance_event();

  return jsonb_build_object('ok', true, 'addedMinutes', p_minutes, 'paused_total_ms', v_state.paused_total_ms);
end;
$$;

create or replace function go_live(p_admin_id int, p_confirm text) returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
  v_before jsonb;
  v_after jsonb;
begin
  if p_confirm <> 'LIVE' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRM', 'message', 'Confirmation text must be LIVE');
  end if;

  select * into v_state from event_state where id = 1 for update;
  if v_state.mode = 'live' then
    return jsonb_build_object('ok', true, 'already', true, 'mode', 'live');
  end if;

  v_before := to_jsonb(v_state);

  update event_state set mode = 'live' where id = 1 returning * into v_state;
  v_after := to_jsonb(v_state);

  insert into admin_log (admin_id, action, target, before, after)
  values (p_admin_id, 'go-live', 'event_state', v_before, v_after);

  return jsonb_build_object('ok', true, 'mode', v_state.mode);
end;
$$;

create or replace function reset_event_data(p_admin_id int default null, p_confirm text default '') returns jsonb language plpgsql as $$
declare
  v_state event_state%rowtype;
begin
  select * into v_state from event_state where id = 1 for update;
  if v_state.mode <> 'test' then
    return jsonb_build_object('ok', false, 'code', 'LIVE_MODE', 'message', 'Cannot reset data in live mode');
  end if;

  if p_confirm <> 'RESET' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRM', 'message', 'Confirmation text must be RESET');
  end if;

  truncate table
    registrations, piece_assignments, team_run, team_questions,
    attempts, score_adjustments, round3_claim, admin_log;

  update event_state set
    phase = 'setup',
    paused_at = null,
    paused_total_ms = 0,
    r1_end_ms = null,
    r2_start_ms = null,
    run2_open_ms = null,
    r2_hard_end_ms = null,
    break_end_ms = null
  where id = 1;

  update teams set
    qualified = false,
    r3_eligible = false,
    pw_wrong = 0,
    pw_blocked_until = null;

  update students set
    absent = false,
    failed_logins = 0,
    locked_until = null;

  return jsonb_build_object('ok', true);
end;
$$;

-- Security: grants and revocations
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
