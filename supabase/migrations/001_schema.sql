create extension if not exists pgcrypto;

create table settings (key text primary key, value jsonb not null);

create table event_state (
  id smallint primary key check (id = 1),
  mode text not null default 'test' check (mode in ('test','live')),
  phase text not null default 'setup' check (phase in ('setup','r1_running','r1_closed','r2_running','r2_break','r3_open','ended')),
  paused_at timestamptz,
  paused_total_ms bigint not null default 0,
  r1_end_ms bigint, r2_start_ms bigint, run2_open_ms bigint, r2_hard_end_ms bigint, break_end_ms bigint
);
insert into event_state (id) values (1);

create function event_now_ms() returns bigint language sql stable as $$
  select (extract(epoch from now()) * 1000)::bigint
         - paused_total_ms
         - case when paused_at is null then 0
                else ((extract(epoch from now()) - extract(epoch from paused_at)) * 1000)::bigint end
  from event_state where id = 1
$$;

create table teams (
  id text primary key, name text not null,
  n smallint not null check (n between 3 and 5),
  withdrawn boolean not null default false,
  qualified boolean not null default false,
  r3_eligible boolean not null default false,
  pw_wrong int not null default 0,              -- Round 3 password throttle
  pw_blocked_until timestamptz
);

create table students (
  id text primary key, name text not null,
  team_id text not null references teams(id),
  is_captain boolean not null default false,
  absent boolean not null default false,
  code_hash text not null,
  failed_logins int not null default 0,
  locked_until timestamptz
);
create unique index one_captain_per_team on students(team_id) where is_captain;

create table admins (
  id serial primary key, username text unique not null, password_hash text not null,
  failed_logins int not null default 0, locked_until timestamptz
);

create table qr_locations (
  id serial primary key, name text not null, token text unique not null,
  capacity int not null default 12 check (capacity > 0), active boolean not null default true
);

-- options format everywhere: [{"id":"a","text":"..."}, ...] with 8 to 10 items, ids 'a'..'j'
create table riddles (
  id serial primary key, position int not null, text text not null,
  options jsonb not null, correct_option_id text not null
);

create table teaser_puzzles (
  id serial primary key, run smallint not null check (run in (1,2)), size smallint not null check (size between 3 and 5),
  pieces jsonb not null,            -- array of exactly `size` strings
  answer_norm text not null,
  unique (run, size)
);

create table questions (
  id serial primary key, run smallint not null check (run in (1,2)),
  slot smallint not null check (slot between 1 and 5), variant smallint not null check (variant >= 1),
  qr_id int not null references qr_locations(id),   -- restrict delete: poster location by ID
  stem text not null, options jsonb not null, correct_option_id text not null,
  unique (run, slot, variant)
);

create table registrations (
  id bigserial primary key, run smallint not null,
  team_id text not null references teams(id), student_id text not null references students(id),
  qr_id int not null references qr_locations(id), slot_no int not null, created_ms bigint not null,
  unique (team_id, qr_id, run),      -- one member per team per QR per run
  unique (student_id, run),          -- one registration per student per run
  unique (student_id, qr_id),        -- a student never reuses a QR across runs
  unique (qr_id, run, slot_no)       -- slot_no between 1 and capacity
);

create table piece_assignments (
  run smallint not null, team_id text not null references teams(id), piece_no smallint not null,
  student_id text not null references students(id),
  via text not null check (via in ('scan','admin')),
  primary key (run, team_id, piece_no)
);

create table team_run (
  team_id text not null references teams(id), run smallint not null check (run in (1,2)),
  opens_ms bigint not null, deadline_ms bigint not null,
  teaser_done_ms bigint, teaser_skipped boolean not null default false,
  finished_ms bigint,
  primary key (team_id, run)
);

create table team_questions (
  team_id text not null references teams(id), run smallint not null,
  question_no smallint not null,            -- 1..N; question_no k belongs to the holder of piece k
  slot smallint not null, question_id int not null references questions(id),
  voided boolean not null default false,
  primary key (team_id, run, question_no),
  unique (team_id, run, slot)
);

create table attempts (
  id bigserial primary key, request_id uuid not null unique,
  team_id text not null references teams(id), student_id text not null references students(id),
  riddle_id int references riddles(id), question_id int references questions(id),
  option_id text not null, try_no smallint not null, correct boolean not null,
  points int not null, created_ms bigint not null,
  check ((riddle_id is null) <> (question_id is null)),
  unique (team_id, riddle_id, try_no), unique (team_id, question_id, try_no)
);

create table score_adjustments (
  id bigserial primary key, team_id text not null references teams(id), run smallint not null,
  question_id int references questions(id), points int not null, reason text not null,
  admin_id int references admins(id), created_ms bigint not null
);

create table round3 (
  id smallint primary key check (id = 1),
  clue_text text not null default '', password_norm text not null default '',
  key_info text not null default '', room text not null default ''
);
insert into round3 (id) values (1);

create table round3_claim (
  id smallint primary key check (id = 1),     -- only one row can ever exist
  team_id text not null references teams(id), student_id text not null references students(id),
  created_ms bigint not null
);

create table admin_log (
  id bigserial primary key, admin_id int references admins(id), action text not null,
  target text, before jsonb, after jsonb, created_at timestamptz not null default now()
);
create function admin_log_immutable() returns trigger language plpgsql as $$
begin raise exception 'admin_log is append-only'; end $$;
create trigger admin_log_no_change before update or delete on admin_log
  for each row execute function admin_log_immutable();

insert into settings (key, value) values
 ('top_n_r2','25'),('top_n_r3','5'),('r1_minutes','30'),('r2_minutes','60'),('run_cap_minutes','30'),
 ('break_minutes','3'),('run_total_points','120'),('r1_points_per_riddle','1'),('tries_r1','1'),('tries_r2','2'),
 ('default_qr_capacity','12'),('variants_per_question','2'),
 ('password_max_wrong','5'),('password_lockout_s','30');

-- standings (rank() gives ties the same rank, so ties at the cutoff all advance)
create view r1_standings as
select t.id as team_id,
       coalesce(sum(a.points), 0)::int as points,
       max(a.created_ms) filter (where a.points > 0) as last_ms
from teams t left join attempts a on a.team_id = t.id and a.riddle_id is not null
where not t.withdrawn group by t.id;

create view r2_standings as
select t.id as team_id,
  (coalesce((select sum(points) from attempts a where a.team_id = t.id and a.question_id is not null), 0)
 + coalesce((select sum(points) from score_adjustments s where s.team_id = t.id), 0))::int as points,
  (select max(created_ms) from attempts a where a.team_id = t.id and a.question_id is not null and a.points > 0) as last_ms
from teams t where t.qualified and not t.withdrawn;
-- ordering everywhere: points desc, last_ms asc nulls last.
-- rank: rank() over (order by points desc, last_ms asc nulls last). Adjustments never affect last_ms.

-- security: deny everything to anon/authenticated; only the service role (server) is used
do $$ declare r record; begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;

-- The project is created with "Automatically expose new tables" OFF, so nothing is granted to
-- any API role by default. The server uses the secret key (role service_role), which needs
-- explicit privileges. ALL includes TRUNCATE, which reset_event_data() needs.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
