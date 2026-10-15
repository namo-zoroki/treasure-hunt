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
