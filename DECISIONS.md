# Architectural & Implementation Decisions

- Used Next.js App Router with TypeScript strict mode and Tailwind CSS as standard mobile-first UI framework.
- Selected slate-900 (#0f172a) for dark background and amber-500 (#f59e0b) as the single accent color for treasure hunt aesthetic.
- Implemented `/login` and `/hq/login` with live countdown timers on receiving `THROTTLED` (showing remaining seconds).
- Middleware enforces `th_admin` JWT on `/hq/*` (redirecting to `/hq/login`) and `/api/admin/*` (returning 401 JSON), while setting `X-Robots-Tag: noindex`.
- `POST /api/admin/import` accepts CSV via multipart/form-data, JSON payload, or raw text body; validates team size (3-5), exactly 1 captain, unique student IDs, and allows re-import strictly in `setup` phase.
- Provided `002_functions.sql` migrations with server-side query fallback in `lib/event-service.ts` for atomic event actions and seamless execution.
- Designed `/hq` dashboard skeleton with 5-second polling, live clock synchronization, primary phase action dispatching, pause/resume, add-time, mode toggle, and reset controls.
- Implemented `/s/[token]` scan flow with server-side authentication redirect (`/login?next=/s/<token>`) and client mount `POST /api/scan` execution to guarantee link previews and prefetchers never register participants.
- Created QR location CRUD (`/api/admin/qr`), base64url token regeneration, and printable sheet (`/hq/qr/print`) generating 4 QR beacons per A4 page using `qrcode`.
- Mapped database-level unique constraint violations on `registrations` into strict domain error codes (`TEAMMATE_HERE`, `QR_USED_BEFORE`, `ALREADY_REGISTERED`, `QR_FULL`) for concurrent scan safety.
- Phase 4 SQL lives in `003_phase4.sql` (not appended to 002) so an already-migrated database only needs the new file. All functions are `create or replace`, safe to re-run.
- Removed the TypeScript "fallback" paths from `registerScan`, `executeEventAction` and `advanceEvent`. They duplicated Postgres logic non-atomically and could silently run when migration 002 had not been applied. A missing function now returns `RPC_ERROR` ("Something is not set up").
- `submit_answer` locks the team row before the `team_questions` row. This serialises the "is the run finished?" check so two simultaneous final answers cannot both miss each other.
- `submit_answer(kind 'r1')` returns `WRONG_PHASE` until Phase 7. `/api/state` already chooses the R1 and R3 screens, but their payloads (riddles, clue) arrive in Phases 7 and 8.
- Extra codes not in Section 8.3: `DUPLICATE_REQUEST` (a requestId already used by another team), `RPC_ERROR` (database function missing or failing). Voided question answers return `LOCKED`; an unknown question number returns `CONTENT_MISSING`.
- `player_state()` (SQL) builds the whole `/api/state` snapshot in one round trip and takes `eventNowMs` from `event_now_ms()`, never from the Node clock. `lib/state.ts` maps it to the player DTO.
- `mine` items carry a `status` (open, one_try_left, correct, locked, voided) so members see the status of their own questions. No points are ever sent.
- SQL tests: `tests/sql/run.sh` and `tests/sql/concurrency.sh` need `psql` and a throwaway local Postgres. They create and drop their own database; never point them at the event database.
