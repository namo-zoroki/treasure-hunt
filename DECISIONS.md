# Architectural & Implementation Decisions

- Used Next.js App Router with TypeScript strict mode and Tailwind CSS as standard mobile-first UI framework.
- Selected slate-900 (#0f172a) for dark background and amber-500 (#f59e0b) as the single accent color for treasure hunt aesthetic.
- Implemented `/login` and `/hq/login` with live countdown timers on receiving `THROTTLED` (showing remaining seconds).
- Middleware enforces `th_admin` JWT on `/hq/*` (redirecting to `/hq/login`) and `/api/admin/*` (returning 401 JSON), while setting `X-Robots-Tag: noindex`.
- `POST /api/admin/import` accepts CSV via multipart/form-data, JSON payload, or raw text body; validates team size (3-5), exactly 1 captain, unique student IDs, and allows re-import strictly in `setup` phase.
- Provided `002_functions.sql` migrations with server-side query fallback in `lib/event-service.ts` for atomic event actions and seamless execution.
- Designed `/hq` dashboard skeleton with 5-second polling, live clock synchronization, primary phase action dispatching, pause/resume, add-time, mode toggle, and reset controls.
