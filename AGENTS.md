# Campus Treasure Hunt: Build Specification

This file is the single source of truth for the coding agent. Save it as `AGENTS.md` in the repository root.

---

## 0. Rules for the coding agent (read first)

1. Read this whole file before writing code. If anything else (comments, older documents, your own preferences) conflicts with this file, this file wins.
2. Do not redesign, rename, add features, or add libraries beyond Section 2. Where something is unspecified, choose the simplest option, add one line to `DECISIONS.md`, and continue. Stop and ask only for missing credentials or a real contradiction inside this file.
3. Build phase by phase (Section 12). Run each phase's "Done when" checks, fix failures, commit, then stop and wait for the next instruction. Never start a later phase early.
4. The browser is untrusted. Every rule is enforced in server code or Postgres. Identity comes only from the signed session cookie, never from a request body.
5. Never send correct answers, scores, point values, or Round 3 clue/password/room to a client that is not entitled to them. Build every response through the mappers in `lib/dto.ts`. Never return raw database rows.
6. Every state-changing player action is atomic and idempotent (Sections 6 and 7).
7. No cron jobs, websockets, background workers, or external services other than Supabase and Vercel. Time-based changes are evaluated lazily (Section 4).
8. All placeholder content is marked `[PLACEHOLDER]`. Real content is entered later through the admin panel.

---

## 1. Product summary

A mobile-first web app that runs a campus treasure hunt for about 100 players.

- **Players** are pre-registered with a student ID and team. Teams have 3 to 5 members, one of whom is the captain. Players log in with student ID plus a personal code.
- **Round 1:** a 30-minute website riddle quiz. The captain submits for the team. Teams are ranked, and the top N (default 25) are selected for Round 2.
- **Round 2:** a 60-minute QR race made of two runs. In each run, members scan QR codes around campus, each scan reveals a teaser puzzle piece, the captain solves the teaser, then the team answers N poster-based questions (one per member). The captain submits.
- **Round 3:** the top 5 teams by Round 2 points see an enciphered clue. The first team to enter the correct password wins and sees the room number. An organiser at the room checks the team ID against the winner shown in the admin panel.
- **Admin panel** controls the clock, content, interventions and exports.

---

## 2. Stack, structure, conventions

### 2.1 Stack (fixed)

- Next.js (current stable), App Router, TypeScript strict, Tailwind CSS.
- Supabase Postgres. Accessed **only from server code** using `@supabase/supabase-js` with the service-role key. Atomic logic lives in Postgres functions called through `.rpc()`. There are no direct Postgres connections.
- Libraries allowed: `@supabase/supabase-js`, `jose` (JWT), `bcryptjs`, `zod`, `qrcode`, `csv-parse`. Dev only: `eslint`, `vitest`, `tsx`. Nothing else.
- Hosting: Vercel, deployed from GitHub `main`.

### 2.2 Environment variables

| Name | Purpose |
|------|---------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only. Never prefix with `NEXT_PUBLIC_`. Holds the Supabase **secret key** (`sb_secret_...`); a legacy `service_role` key also works. Use it exactly as the service-role key |
| `SESSION_SECRET` | Signs player JWTs (32+ random bytes) |
| `ADMIN_SESSION_SECRET` | Signs admin JWTs (different value) |
| `BASE_URL` | Public site URL, used to build QR links |
| `SEED_ADMINS` | Up to 3 admin accounts as `username:password` pairs separated by `;`, for example `asha:Pw1;ravi:Pw2`. Passwords must not contain `:` or `;`. Read by `scripts/create-admins.ts`. All admins have the same full access |

Local values live in `.env.local` (git-ignored; never commit it). Scripts must load it explicitly: run them as `tsx --env-file=.env.local scripts/<name>.ts`. On Vercel the same names are set in Project Settings, with `BASE_URL` set to the production URL.

### 2.3 Manual steps for the human (tell them when you reach Phase 0)

1. Create a Supabase project. Copy the URL and service-role key.
2. Create a Vercel project from the GitHub repo and set the env vars above.
3. Create the Supabase project with these options: **Enable Data API = ON** (required: `supabase-js` and `.rpc()` use it), **Automatically expose new tables and functions = OFF**, **Automatic RLS = ON**. The migrations grant `service_role` explicitly, so the OFF setting is safe.
4. Run the SQL migrations (Section 5) in the Supabase SQL editor, in order.

### 2.4 Repository layout

```
app/
  (player)/            login, home, scan page /s/[token]
  hq/                  admin UI (Section 9)
  api/                 route handlers (Section 7)
lib/
  db.ts                server-only supabase client (import 'server-only')
  session.ts           player + admin JWT helpers
  dto.ts               response mappers (no raw rows leave the server)
  shuffle.ts           seeded shuffle (Section 2.6)
  messages.ts          error code to player text (Section 8.3)
supabase/migrations/   001_schema.sql, 002_functions.sql
scripts/               seed.ts (test data), create-admins.ts, concurrency-test.ts, load-test.ts
DECISIONS.md           one line per unspecified choice you made
```

### 2.5 API conventions

- Domain rejections (wrong phase, full QR, wrong answer, locked, and so on) return HTTP 200 with `{ ok:false, code, message }`. Success returns `{ ok:true, ... }`.
- HTTP 401 for no or invalid session, 400 for validation errors (validate every body with `zod`). The client treats only network failures and 5xx as "retrying".
- Every state-changing player request carries a client-generated UUID `requestId`. The client resends the **same** `requestId` on retry. The server stores it (`attempts.request_id`) and returns the original result on repeat. Scans and password claims are idempotent by their natural keys (Section 6).
- All API routes that use bcrypt or Supabase set `export const runtime = 'nodejs'`.
- JSON uses camelCase. The database uses snake_case.

### 2.6 Seeded shuffle (use exactly this)

Option order is deterministic per team and item, so it is never stored.

```ts
function fnv1a(s: string) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const a = [...items], rnd = mulberry32(fnv1a(seed));
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
// seed = `${teamId}:r1:${riddleId}` or `${teamId}:r2:${questionId}`
```

### 2.7 Text normalisation

For teaser answers and the Round 3 password: lowercase, trim, collapse internal whitespace to a single space. Nothing else. SQL: `lower(regexp_replace(trim(x), '\s+', ' ', 'g'))`. Store `answer_norm` and `password_norm` already normalised.

### 2.8 UI rules

Mobile-first (design for 360 px width), one column, max width 480 px, system font, large tap targets, dark theme with one accent colour, no animation libraries, no images beyond QR codes. Player pages must stay light for slow data. Tone is playful and slightly mysterious (the "structured chaos" feel) but messages stay short.

---

## 3. Settings (table `settings`, editable in the admin panel)

| Key | Default | Locks when |
|-----|---------|------------|
| `top_n_r2` | 25 | never (informational for selection) |
| `top_n_r3` | 5 | never |
| `r1_minutes` | 30 | phase leaves `setup` |
| `r2_minutes` | 60 | phase leaves `r1_closed` |
| `run_cap_minutes` | 30 | phase leaves `r1_closed` |
| `break_minutes` | 3 | never |
| `run_total_points` | 120 | phase leaves `r1_closed` |
| `r1_points_per_riddle` | 1 | phase leaves `setup` |
| `tries_r1` | 1 | phase leaves `setup` |
| `tries_r2` | 2 | phase leaves `r1_closed` |
| `default_qr_capacity` | 12 | never |
| `variants_per_question` | 2 | never |
| `password_max_wrong` | 5 | never |
| `password_lockout_s` | 30 | never |

"Locks" means the admin API rejects edits (code `SETTING_LOCKED`) once the phase has moved past the stated point.

Points per R2 question: `full = floor(run_total_points / n)`, `half = floor(full / 2)`. With 120: n=3 gives 40/20, n=4 gives 30/15, n=5 gives 24/12. `teams.n` is constrained to 3 to 5.

**Content edits:** a riddle's or question's text (`stem`) may be edited at any time. Its options and correct answer lock once any attempt exists for it. Typos are fixed through the stem; real errors use "void" (Section 9).

---

## 4. Event clock and phases

### 4.1 One pausable event clock

`event_now_ms = (epoch_ms(now()) - paused_total_ms) - (paused_at is null ? 0 : epoch_ms(now()) - epoch_ms(paused_at))`.

Every deadline and timestamp (`r1_end_ms`, `opens_ms`, `deadline_ms`, `created_ms`, and so on) is stored in **event time**, so one pause moves everything together. The SQL function `event_now_ms()` is the only clock. Never use the client clock or JS `Date.now()` for any rule. The client shows countdowns by taking `eventNowMs` from the last API response, adding the local time elapsed since that response, and subtracting from the deadline. When paused it freezes.

### 4.2 Phases (`event_state.phase`)

| From | Trigger | To | Effects |
|------|---------|----|---------|
| `setup` | admin "Start Round 1" | `r1_running` | `r1_end_ms = now + r1_minutes` |
| `r1_running` | `event_now >= r1_end_ms`, or admin "End Round 1" | `r1_closed` | none |
| `r1_closed` | admin "Start Round 2" (at least 1 qualified team) | `r2_running` | `r2_start_ms = now`; `run2_open_ms = now + run_cap_minutes`; `r2_hard_end_ms = now + r2_minutes`; insert `team_run` run 1 for every qualified team with `opens_ms = now`, `deadline_ms = min(now + cap, hard_end)` |
| `r2_running` | `event_now >= r2_hard_end_ms`, or admin "End Round 2" | `r2_break` | `break_end_ms = hard_end + break_minutes` (if ended manually, `hard_end = now` first) |
| `r2_break` | admin "Open Round 3" (allowed only when `event_now >= break_end_ms`) | `r3_open` | run `open_round3()` (Section 6.6) |
| `r3_open` | admin "End event" | `ended` | none |

`event_state.paused_at` is independent of phase. While paused, every player mutation is rejected with `PAUSED`.

### 4.3 Lazy evaluation (no cron)

`advance_event()` is a Postgres function that is idempotent and cheap. It is called as the first statement of every mutating RPC, and once per `/api/state` request and per admin dashboard poll. It does:

1. If `r1_running` and `event_now >= r1_end_ms`: set `r1_closed`.
2. If `r2_running` and `event_now >= r2_hard_end_ms`: set `r2_break` and `break_end_ms`.
3. If `r2_running` and `event_now >= run2_open_ms`: for every qualified, non-withdrawn team without a run 2 row, insert `team_run` run 2 with `opens_ms = run2_open_ms`, `deadline_ms = min(opens + cap, hard_end)`.

Unanswered questions are **never written as locked**. A question counts as 0 when the run deadline has passed. `submit_answer` rejects after the deadline, and standings sum only real attempt rows.

### 4.4 Pause, resume, add time

- **Pause:** allowed in `r1_running`, `r2_running`, `r2_break`, `r3_open`. Sets `paused_at = now()`.
- **Resume:** `paused_total_ms += now() - paused_at`; `paused_at = null`.
- **Add time (X minutes):** `paused_total_ms += X*60000`. This is the only way to give more time. It pushes every deadline later by X (Round 1 end, Run 2 opening, run deadlines, hard end, break) all at once. Use it after an outage (the panel is unreachable during an outage, so nobody can press Pause) or whenever the event needs more time.

All three are logged to `admin_log`.

### 4.5 Current run of a team

`current_run(team) = highest run in team_run where opens_ms <= event_now`. A run is **open** when `finished_ms is null` and `event_now < deadline_ms`. A run is **finished** when all N of the team's `team_questions` for that run are resolved: voided, or have a correct attempt, or have `tries_r2` wrong attempts. When a team finishes run 1 and run 2 does not exist yet, `submit_answer` inserts run 2 with `opens_ms = event_now`, `deadline_ms = min(event_now + cap, hard_end)`.

---

## 5. Database schema

Put in `supabase/migrations/001_schema.sql`. Run exactly as written.

```sql
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
```

`002_functions.sql` contains the functions of Section 6. At its end: `revoke execute on all functions in schema public from public, anon, authenticated; grant execute on all functions in schema public to service_role;`.

---

## 6. Atomic functions (Postgres, called via `.rpc()`)

All return `jsonb`: `{ "ok": true, ... }` or `{ "ok": false, "code": "CODE" }`. All start with `perform advance_event();`. Lock order is always **QR row, then team row, then team_questions row**, to avoid deadlocks. Player functions reject with `PAUSED` when `event_state.paused_at is not null`.

### 6.1 `register_scan(p_student text, p_token text)`

1. Load student and team. If the team is not `qualified` or is `withdrawn`: `NOT_IN_ROUND`. If `student.absent`: `ABSENT`. If phase is not `r2_running`: `WRONG_PHASE`.
2. Find the QR by token: none gives `INVALID_QR`; inactive gives `QR_INACTIVE`.
3. Determine the run: `current_run(team)`. If that run is not open: `WRONG_PHASE`.
4. `select ... for update` the QR row, then the team row.
5. If this student already has a registration for this run: same QR returns `{ok:true, already:true, ...}` (idempotent); a different QR returns `ALREADY_REGISTERED`.
6. If the team already has a registration at this QR for this run: `TEAMMATE_HERE`.
7. If this student has a registration at this QR in any run: `QR_USED_BEFORE`.
8. If the team's piece assignments for this run already number N: `TEAM_COMPLETE`.
9. If registrations at this QR for this run are at or above `capacity`: `QR_FULL`.
10. Insert the registration with `slot_no` = smallest free integer from 1 to capacity. Insert a `piece_assignments` row with `piece_no` = smallest free integer from 1 to N, `via='scan'`.
11. Return `{ok:true, run, piece_no, qr_name}`. Rejections write nothing, so they consume no capacity.

### 6.2 `solve_teaser(p_student text, p_answer text)` (captain only)

1. Not captain: `NOT_CAPTAIN`. Current run not open: `WRONG_PHASE`. Teaser already done or skipped: return `{ok:true, already:true}`.
2. If assigned pieces < N: `TEASER_NOT_READY`.
3. Compare normalised answer to `teaser_puzzles(run, size=N).answer_norm`. Missing puzzle: `CONTENT_MISSING`. Wrong: return `TEASER_WRONG`. Unlimited tries, no points, no throttle.
4. Correct: set `teaser_done_ms = event_now`, call `assign_questions(team, run)`, return `{ok:true}`.

`skip_teaser(team, run)` (admin) sets `teaser_skipped = true` and calls `assign_questions`.

### 6.3 `assign_questions(team, run)` (idempotent; no-op if rows exist)

Under `pg_advisory_xact_lock(hashtext('assign:' || run))`:

1. Count existing `team_questions` per `slot` for this run. Choose the N slots (from 1 to 5) with the lowest counts, ties random.
2. For each chosen slot, choose the variant with the fewest existing `team_questions` rows (ties random).
3. Assign `question_no` 1..N to the chosen slots in random order. Insert the rows.

### 6.4 `submit_answer(p_student text, p_kind text, p_key int, p_option text, p_request uuid)`

`p_kind` is `'r1'` (key = riddle id) or `'r2'` (key = question_no).

1. If an attempt with `request_id = p_request` exists, return its derived result (below). Never insert twice.
2. Not captain: `NOT_CAPTAIN`.
3. **R1:** phase must be `r1_running` and `event_now < r1_end_ms`, else `WRONG_PHASE`. Riddle must exist. `max_tries = tries_r1`, `full = r1_points_per_riddle`.
   **R2:** the team's current run must be open, the teaser done or skipped (else `TEASER_NOT_READY`), and `team_questions(run, question_no = p_key)` must exist and not be voided. `max_tries = tries_r2`, `full = floor(run_total_points / N)`.
4. Lock the `team_questions` row (R2) or the team row (R1).
5. Count existing attempts for this team and item. Any correct: `ALREADY_DONE`. Count at or above `max_tries`: `LOCKED`.
6. `p_option` must be one of the item's option ids, else `INVALID_OPTION`.
7. Insert the attempt: `try_no = count + 1`, `correct = (p_option = correct_option_id)`, `points = correct ? (try_no = 1 ? full : floor(full/2)) : 0`, `created_ms = event_now`.
8. R2 only: if all N questions of the run are now resolved, set `team_run.finished_ms = event_now`; if run = 1 and run 2 does not exist and phase is `r2_running`, insert run 2 (Section 4.5).
9. Return `{ok:true, status, runFinished}` where `status` is `correct`, `wrong_one_left` (wrong and `try_no < max_tries`), or `locked` (wrong and `try_no = max_tries`). Never return points or the correct option.
   Derived result for step 1: same mapping from the stored attempt.

### 6.5 `claim_round3(p_student text, p_password text)`

1. Phase must be `r3_open`, else `WRONG_PHASE`. Student's team must have `r3_eligible`, else `NOT_ELIGIBLE`. Any member may submit.
2. If a `round3_claim` row exists: if it is this team's, return `{ok:true, won:true}`; otherwise `ALREADY_CLAIMED`.
3. If the team's `pw_blocked_until > now()`: `THROTTLED`.
4. Wrong normalised password: `pw_wrong += 1`; when it reaches `password_max_wrong`, set `pw_blocked_until = now() + password_lockout_s` seconds and `pw_wrong = 0`. Return `WRONG_PASSWORD`.
5. Correct: `insert into round3_claim (id, team_id, student_id, created_ms) values (1, ...) on conflict (id) do nothing`. If a row was inserted, return `{ok:true, won:true}`; if not, `ALREADY_CLAIMED`. The primary key is what guarantees a single winner.

### 6.6 `open_round3()`

Allowed only in `r2_break` with `event_now >= break_end_ms`. Set `phase = r3_open`. Set `teams.r3_eligible = true` for teams whose `rank() over (order by points desc, last_ms asc nulls last)` from `r2_standings` is `<= top_n_r3`; all others false.

### 6.7 Admin functions (each writes `admin_log` with before and after)

`start_round1`, `end_round1`, `start_round2`, `end_round2`, `open_round3` (6.6), `end_event`, `pause_event`, `resume_event`, `add_time(minutes)` (Section 4.4); `set_qualified(team, bool)` (only in `r1_closed`); `set_captain(team, student)` (in one transaction: clear the old captain, set the new); `edit_team_n(team, n)` (only before phase `r2_running`); `mark_absent(student, move_to_student)`; `unmark_absent(student)`; `cancel_registration(registration_id)`; `admin_register(student, qr_id, run)` (same as `register_scan` but ignores capacity); `skip_teaser(team, run)`; `reset_attempts(team, item)`; `void_question(team or null, question_id)`; `reset_event_data(confirm text)`.

**`mark_absent(student, move_to)`:** set `absent = true`. For the current run, every piece number from 1 to N that has no assignment is assigned to `move_to` (`via='admin'`); any piece already held by the absent student is reassigned to `move_to` too. N and points per question do not change. If the absent student has a registration, keep it (it still occupies its slot).

**`cancel_registration(id)`:** delete the registration and delete the matching piece assignment if its holder is that student. Slot and piece number become free for the next registrant.

**`void_question(team|null, question_id)`:** for each affected team (the given team, or all teams that have this question): set `team_questions.voided = true`; insert a `score_adjustments` row with `points = full - (points already earned on that question)` (never negative), `reason` required. Re-evaluate run-finished. Adjustments count toward totals but are never used for tie-break time.

**`reset_event_data(confirm)`:** only when `mode = 'test'` and `confirm = 'RESET'`. Truncate `registrations, piece_assignments, team_run, team_questions, attempts, score_adjustments, round3_claim, admin_log`. Set `event_state` to defaults (`phase='setup'`, `paused_at=null`, `paused_total_ms=0`, all `*_ms` null). Set `teams.qualified = false`, `r3_eligible = false`, `pw_wrong = 0`, `pw_blocked_until = null`; `students.absent = false`, `failed_logins = 0`, `locked_until = null`. Keep teams, students, QRs, content, settings, round3 config.

**Mode switch:** admin "Go Live" sets `mode = 'live'` after a typed confirmation. It cannot be undone from the panel. `reset_event_data` refuses in live mode.

---

## 7. API contract

### 7.1 Player routes (cookie `th_session`, identity from the session only)

| Route | Body | Result |
|-------|------|--------|
| `POST /api/auth/login` | `{studentId, code}` | sets cookie; `{ok:true}` or `INVALID_LOGIN` / `THROTTLED` (with `retryAfterSec`) |
| `POST /api/auth/logout` | none | clears cookie |
| `GET /api/state` | none | the state object of Section 8.1 |
| `POST /api/scan` | `{token}` | `register_scan` result |
| `POST /api/teaser` | `{answer, requestId}` | `solve_teaser` result |
| `POST /api/answer` | `{kind:'r1'\|'r2', key, optionId, requestId}` | `submit_answer` result |
| `POST /api/r3/claim` | `{password}` | `claim_round3` result; on win include `{keyInfo, room}` |

### 7.2 Scan page `GET /s/[token]`

1. No valid session: redirect to `/login?next=/s/<token>`. `next` must be a relative path starting with `/s/` or equal to `/`; otherwise ignore it (no open redirects).
2. With a session: render a small page, and **on load the client POSTs `/api/scan`** with the token. The scan is a POST triggered by page JavaScript, never a side effect of the GET, so link previews and prefetchers cannot register anyone.
3. Show the result (Section 8.2) with a button to the home screen. Re-scanning the same QR is safe (`already:true`).

### 7.3 Admin routes (cookie `th_admin`)

UI at `/hq`. Middleware verifies the admin JWT on `/hq/*` and `/api/admin/*` (except `POST /api/admin/login`). Every mutating admin route writes `admin_log`.

| Route | Purpose |
|-------|---------|
| `POST /api/admin/login` | username + password |
| `GET /api/admin/dashboard` | live dashboard data |
| `POST /api/admin/event/<action>` | `start-r1, end-r1, start-r2, end-r2, open-r3, end-event, pause, resume, add-time, go-live, reset` |
| `GET/PUT /api/admin/settings` | settings (respecting locks) |
| `POST /api/admin/import` | participant CSV (Section 11.1) |
| `POST /api/admin/students/<id>/<action>` | `reset-code, unlock, absent, unabsent, make-captain` |
| `PATCH /api/admin/teams/<id>` | `n`, `withdrawn`, `qualified` |
| CRUD `/api/admin/qr`, `/api/admin/riddles`, `/api/admin/questions`, `/api/admin/teasers`, `PUT /api/admin/round3` | content |
| `POST /api/admin/interventions/<action>` | `cancel-registration, admin-register, skip-teaser, reset-attempts, void-question` |
| `GET /api/admin/export/<name>` | CSV: `registrations, attempts, standings` |

---

## 8. Player experience

### 8.1 `GET /api/state` response

```ts
type State = {
  clock: { serverNowMs: number; eventNowMs: number; paused: boolean };
  me: { studentId: string; name: string; teamId: string; teamName: string; isCaptain: boolean; n: number };
  screen:
   | 'WAIT_R1' | 'R1' | 'R1_DONE'
   | 'R2_SPECTATOR' | 'R2_SCAN' | 'R2_TEASER' | 'R2_QUESTIONS' | 'R2_DONE' | 'R2_BREAK'
   | 'R3' | 'R3_SPECTATOR' | 'ENDED';
  deadlineEventMs?: number;
  // plus the payload for the screen (below)
};
```

How `screen` is chosen (first match):

| Condition | Screen |
|-----------|--------|
| phase `setup` | `WAIT_R1` |
| phase `r1_running` | `R1` |
| phase `r1_closed` | `R1_DONE` |
| phase `r2_running`/`r2_break`, team not qualified or withdrawn | `R2_SPECTATOR` |
| phase `r2_running`, current run finished or deadline passed | `R2_DONE` |
| phase `r2_running`, current run open, student has no registration this run and team teaser not done/skipped | `R2_SCAN` |
| phase `r2_running`, teaser not done/skipped | `R2_TEASER` |
| phase `r2_running`, teaser done/skipped | `R2_QUESTIONS` |
| phase `r2_break` | `R2_BREAK` |
| phase `r3_open`, team `r3_eligible` | `R3` |
| phase `r3_open`, otherwise | `R3_SPECTATOR` |
| phase `ended` | `ENDED` |

When a team has finished run 1 and run 2 is open with no registration by this student, the screen is `R2_SCAN` with `message: "Run 2 is open. Scan any QR."`.

**Payloads:**

- `R1`: `deadlineEventMs`, `riddles: [{ id, position, text, options (seeded-shuffled), status: 'open'|'correct'|'wrong' }]`, `canSubmit` (captain only). Members see riddles read-only. All riddles are visible and may be answered in any order. Riddle status feedback is only `correct` or `wrong` (1 try).
- `R2_SCAN`: `run`, `deadlineEventMs`, `message?`.
- `R2_TEASER`: `run`, `deadlineEventMs`, `piecesHeld: [{ pieceNo, text }]`, `registered` (count of assigned pieces), `total: n`, `canAnswer` (captain and `registered == n`, or teaser skipped).
- `R2_QUESTIONS`: `run`, `deadlineEventMs`, `mine: [{ questionNo, stem, locationName }]` for every question_no whose piece the student holds (a student holding several pieces sees several questions); if captain also `board: [{ questionNo, options (seeded-shuffled), status: 'open'|'one_try_left'|'correct'|'locked'|'voided' }]`. **The captain does not see other members' stems**, only the options for each numbered question. This forces the team to split up and report back. Members see the status of their own questions only. No points anywhere.
- `R2_DONE` / `R2_BREAK`: message only. `R2_SPECTATOR`: message "Round 2 is for qualified teams. You can watch the fun."
- `R3`: `clue` (the enciphered text), `claimed: boolean`, and if this team won, `keyInfo` and `room`. The winning team's screen also shows its team ID in large text with the line "Go to the room and show this to the organiser."
- `R3_SPECTATOR`: message "You are not among the top 5 teams."

**Polling:** `R2_TEASER`, `R2_SCAN`, `WAIT_R1`, `R1_DONE`, `R2_DONE`, `R2_BREAK`, `R3` (while unclaimed) poll every 5 s with random jitter of plus or minus 1 s. `R1` and `R2_QUESTIONS` poll every 15 s (to catch pause and deadlines) and after each submit. `R2_SPECTATOR`, `R3_SPECTATOR`, `ENDED` poll every 30 s. On network failure show "Retrying..." and keep the same `requestId`.

### 8.2 Scan result texts

Success: "Registered at {qrName}. You are piece {pieceNo} of {n}." (do not reveal anything about other teammates' locations). Failures use Section 8.3.

### 8.3 Error codes and player text (`lib/messages.ts`)

| Code | Text |
|------|------|
| `INVALID_LOGIN` | Student ID or code is wrong. |
| `THROTTLED` | Too many tries. Wait {s} seconds. |
| `WRONG_PHASE` | That is not open right now. |
| `PAUSED` | The event is paused. Hang tight. |
| `NOT_IN_ROUND` | Your team is not in this round. |
| `ABSENT` | You are marked absent. Ask an organiser. |
| `INVALID_QR` | This QR code is not valid. |
| `QR_INACTIVE` | This location is closed. Find another location. |
| `TEAMMATE_HERE` | A teammate already registered here. Find another location. |
| `QR_USED_BEFORE` | You used this location before. Find another location. |
| `QR_FULL` | This location is full. Find another location. |
| `ALREADY_REGISTERED` | You are already registered for this run. |
| `TEAM_COMPLETE` | Your team is already complete. |
| `NOT_CAPTAIN` | Only your captain can submit. |
| `TEASER_NOT_READY` | Wait until every teammate has registered. |
| `TEASER_WRONG` | Not quite. Keep talking to your team. |
| `ALREADY_DONE` | Already answered. |
| `LOCKED` | This question is locked. |
| `INVALID_OPTION` | Choose one of the options. |
| `NOT_ELIGIBLE` | Your team is not in this round. |
| `WRONG_PASSWORD` | That is not it. |
| `ALREADY_CLAIMED` | Another team got there first. |
| `CONTENT_MISSING` | Something is not set up. Tell an organiser. |

Answer feedback texts: `correct` gives "Correct.", `wrong_one_left` gives "Wrong. One try left.", `locked` gives "Wrong. Locked.". Round 1 uses "Correct." / "Wrong.".

---

## 9. Admin panel (`/hq`)

Plain, functional UI. Polls the dashboard every 5 s. All lists are searchable by team or student ID.

| Page | Contents |
|------|----------|
| **Dashboard** | phase, event clock, pause state, big buttons for the next valid phase action; per-team row: stage, run, teaser state, registrations (QR names), questions with status and attempts used, run deadline; per-QR live counts per run versus capacity |
| **Event control** | all actions in 4.2 and 4.4 with confirm dialogs; Test/Live switch; Reset event data (typed `RESET`, test mode only) |
| **Teams & students** | CSV import (11.1), add/remove, edit N (before Round 2), change captain, withdraw, unlock login, reset code (shown once), mark absent with a "move to" teammate picker |
| **QR locations** | add (name, capacity default 12); token = `crypto.randomBytes(16).toString('base64url')`; link = `BASE_URL/s/<token>`; a printable sheet page of all active QRs (4 per A4 page, name under each, codes generated with `qrcode`); edit capacity live; deactivate; regenerate token; delete is blocked (FK) while any question points to it, with a clear message |
| **Riddles / Questions / Teasers** | CRUD per Section 3 edit rules; questions grouped by run, slot, variant; shows location name from `qr_id` |
| **Selection** | after Round 1: table ranked by `r1_standings`; first `top_n_r2` rows pre-ticked; admin ticks/unticks `qualified` (promote the next team by ticking it); header shows the count of ticked teams; applies only while phase is `r1_closed` |
| **Round 3** | enter clue, password, key info, room; shows eligible teams after `open_round3`; shows the winning claim (team ID, student, time) so the organiser at the room can check the team ID |
| **Interventions** | cancel/override registration, skip teaser, reset attempts, void question (team or all, reason required) |
| **Log & export** | `admin_log` viewer; CSV downloads (7.3) |

---

## 10. Security rules

- Passwords and codes: bcrypt (cost 10). Student codes are 6 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, entered case-insensitively.
- **Player session:** JWT (HS256 via `jose`), payload `{ sid }` only, 24 h expiry. Cookie `th_session`: HttpOnly, Secure, SameSite=Lax (Lax is required so a cookie sent on a QR-scan navigation still works). On every request load the student and team fresh from the database; never trust role or team from the token.
- **Admin session:** separate secret and cookie `th_admin`, 8 h, payload `{ aid }`.
- **Login throttle:** per student and per admin account, after 5 consecutive failures set `locked_until = now + min(2 * 2^(failed_logins - 5), 60)` seconds; success resets the counter. An admin can unlock a student from the panel. There is no per-IP limit (campus Wi-Fi shares IPs).
- Admin UI is at `/hq`, has no links from the player site, and sends `X-Robots-Tag: noindex`. The real protection is authentication.
- `lib/db.ts` begins with `import 'server-only'`. The service-role key is never in client code.
- Responses never include `correct_option_id`, `answer_norm`, `password_norm`, points, other teams' data, or Round 3 content for ineligible teams.
- Accepted limit: a shared login or a photo of a QR cannot be fully stopped. Poster questions, per-team attempt limits and server rules make that harmless enough.

---

## 11. Data formats and seed

### 11.1 Participant CSV (import)

Header: `student_id,name,team_id,team_name,is_captain`. Validate before writing anything: every team has exactly 1 captain and 3 to 5 members; `student_id` unique. On success create teams (`n` = member count), students, and generated codes; return a **one-time downloadable `codes.csv`** (`student_id,name,team_id,code`). Re-import replaces rows only in `setup` phase.

### 11.2 Seed script `scripts/seed.ts`

Creates in test data, all labelled `[PLACEHOLDER]`: 30 teams (`T01` to `T30`) with 3 to 5 students each (`S0101` style), exactly one captain each, codes written to `codes.csv`; 12 QR locations; 12 riddles with 8 options each; teaser puzzles for runs 1 and 2 in sizes 3, 4, 5; 20 questions (5 slots x 2 runs x 2 variants) linked to QRs; round3 with sample clue, password, key and room.

`scripts/create-admins.ts` reads `SEED_ADMINS` and creates or updates those admin accounts (re-running it resets their passwords). It touches nothing else, so it is also safe to run for the real event.

---

## 12. Build phases (stop after each; the human instructs the next)

| Phase | Build | Done when |
|-------|-------|-----------|
| **0** | Scaffold, env, `001_schema.sql` + `event_now_ms`, `lib/db.ts`, seed script, `create-admins.ts`, `DECISIONS.md` | App deploys; migrations run clean; seed runs; `select event_now_ms()` works |
| **1** | Player login/session, throttle, CSV import, admin login + middleware, `lib/dto.ts`, `lib/messages.ts` | Login works on a phone; 6 wrong codes cause a delay; admin routes return 401 without cookie |
| **2** | Clock and phases: `advance_event`, event control actions, pause/resume/add-time, dashboard skeleton | Walking `setup` to `ended` works; pausing for 2 minutes shifts all deadlines by 2 minutes; unit test of the clock formula passes |
| **3** | QR management, `register_scan`, `/s/[token]` flow, QR sheet | 30 parallel scans for the last free slot: exactly 1 succeeds (`scripts/concurrency-test.ts`); every rule in 6.1 has a test; scan from iPhone camera and Google Lens works after login redirect; link preview does not register anyone |
| **4** | Teaser, `assign_questions`, `submit_answer` (R2), `/api/state` for Round 2 screens | Full run: scan, teaser, N questions, captain submit with tries 2 then lock; duplicate `requestId` returns the same result without a second row; captain sees options but not others' stems |
| **-- Checkpoint --** | Human runs a pilot of phases 0-4 with friends on real phones | Fix what breaks before continuing |
| **5** | Run timing: run 2 opening (finish or 30-minute mark), deadlines, hard end, results break, void, absent/move, cancel registration | Test with `run_cap_minutes` temporarily 2 and `r2_minutes` 4: Run 2 opens correctly, expired runs score 0, break starts on time |
| **6** | Rest of admin panel: teams, interventions, dashboard detail, log, exports | Every action in Section 9 works and appears in the log |
| **7** | Round 1 (`R1` screen, `submit_answer` r1), selection page, standings | Ranked list, promote/remove, Start Round 2 is blocked with zero qualified teams |
| **8** | Round 3: `open_round3`, claim, admin Round 3 page | Two teams submitting the correct password at the same instant: exactly one wins; a spectator team sees the spectator screen; the admin Round 3 page shows the winner |
| **9** | Hardening: RLS and grants verified, `load-test.ts`, edge-case sweep, README with the admin cheat sheet (pause, add time, captain swap, skip teaser, void, absent) and the one-page outage policy | Load test: 150 clients polling `/api/state` for 5 minutes, zero 5xx, p95 under 800 ms; security checks of Section 10 pass |

### Outage policy (put in the README, one page)

If the site is down for more than about 3 minutes: fix it, then use **Add time** for the downtime. State is saved on the server and players resume by reloading. Use the CSV export only if the database itself is lost.

---

## 13. Tests (vitest plus scripts)

1. Seeded shuffle: same seed gives the same order; different teams differ.
2. Points: n=3,4,5 give full 40/30/24 and half 20/15/12; tries exhaustion; a correct answer after a wrong one gives half.
3. Ranking: ties on points break by earliest last point-earning attempt; adjustments do not change the tie-break; `rank()` includes all teams tied at the cutoff.
4. Registration rules: each rule in 6.1 returns its code; cancel frees slot and piece; `QR_USED_BEFORE` across runs.
5. Concurrency: last-slot scan race; two teammates at one QR; duplicate `requestId`; simultaneous Round 3 claims.
6. Clock: pause, resume, add time across the Run 2 mark and the hard end.
7. Security: no response contains `correct_option_id`, `password_norm`, points, or `room` for an ineligible team; anon Supabase key cannot read any table.

---

## 14. Out of scope for this version

GPS checks, in-site QR scanner, email/OTP/third-party login, paper fallback, 2FA for admins, websockets, multiple environments, scoreboards visible to players.
