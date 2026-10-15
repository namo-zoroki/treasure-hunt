'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CaptainBoardQuestionDTO, MemberQuestionDTO, RiddleDTO, StateDTO } from '@/lib/dto';
import { ANSWER_FEEDBACK, getErrorMessage } from '@/lib/messages';

type Api = { ok: boolean; code?: string; message?: string; status?: string; [k: string]: unknown };

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function pollMs(screen: string): number {
  const jitter = (base: number) => base + (Math.random() * 2000 - 1000);
  switch (screen) {
    case 'R1':
    case 'R2_QUESTIONS':
      return 15000;
    case 'R2_SPECTATOR':
    case 'R3_SPECTATOR':
    case 'ENDED':
      return 30000;
    default:
      return jitter(5000);
  }
}

export default function Game() {
  const router = useRouter();
  const [state, setState] = useState<StateDTO | null>(null);
  const [offline, setOffline] = useState(false);
  const [, setTick] = useState(0);
  const received = useRef({ eventNowMs: 0, at: 0, paused: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      if (res.status === 401) {
        router.replace('/login');
        return;
      }
      if (!res.ok) throw new Error('server');
      const data = (await res.json()) as StateDTO;
      received.current = { eventNowMs: data.clock.eventNowMs, at: Date.now(), paused: data.clock.paused };
      setState(data);
      setOffline(false);
      timer.current = setTimeout(load, pollMs(data.screen));
    } catch {
      setOffline(true);
      timer.current = setTimeout(load, 3000);
    }
  }, [router]);

  useEffect(() => {
    load();
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      clearInterval(t);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    load();
  }, [load]);

  /** POST with a stable requestId. A network failure retries with the SAME id (idempotent on the server). */
  const post = useCallback(async (url: string, key: string, body: Record<string, unknown>): Promise<Api | null> => {
    let id = pending.current.get(key);
    if (!id) {
      id = uuid();
      pending.current.set(key, id);
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, requestId: id }),
        });
        if (res.status === 401) {
          router.replace('/login');
          return null;
        }
        if (res.status < 500) {
          pending.current.delete(key);
          setOffline(false);
          return (await res.json()) as Api;
        }
      } catch {
        /* network failure: retry below */
      }
      setOffline(true);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    return null;
  }, [router]);

  if (!state) {
    return <p className="text-center text-slate-400 mt-24 text-sm">{offline ? 'Retrying...' : 'Loading...'}</p>;
  }

  const r = received.current;
  const nowEvent = r.eventNowMs + (r.paused ? 0 : Date.now() - r.at);
  const remainingS = state.deadlineEventMs !== undefined ? Math.max(0, Math.floor((state.deadlineEventMs - nowEvent) / 1000)) : null;
  const mmss = remainingS === null ? '' : `${Math.floor(remainingS / 60)}:${String(remainingS % 60).padStart(2, '0')}`;

  return (
    <div className="flex flex-col flex-1 w-full gap-4">
      <div className="flex items-center justify-between pb-3 border-b border-slate-800">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Team {state.me.teamId}</div>
          <div className="text-lg font-bold text-slate-100">{state.me.teamName}</div>
        </div>
        <span className={`px-2.5 py-0.5 rounded text-xs font-bold uppercase tracking-wider ${state.me.isCaptain ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-slate-800 text-slate-300'}`}>
          {state.me.isCaptain ? 'Captain' : 'Agent'}
        </span>
      </div>

      {state.clock.paused && <Banner tone="warn">{getErrorMessage('PAUSED')}</Banner>}
      {offline && <Banner tone="warn">Retrying...</Banner>}
      {remainingS !== null && (
        <div className="text-center">
          <div className="text-xs uppercase tracking-wider text-slate-400">Time left</div>
          <div className="text-4xl font-extrabold text-accent tabular-nums">{mmss}</div>
        </div>
      )}

      <Screen state={state} post={post} refresh={refresh} />
    </div>
  );
}

function Banner({ tone, children }: { tone: 'warn' | 'ok'; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg px-3 py-2 text-sm text-center font-medium ${tone === 'warn' ? 'bg-amber-950/50 border border-amber-800 text-amber-300' : 'bg-emerald-950/50 border border-emerald-800 text-emerald-300'}`}>
      {children}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="p-4 rounded-xl bg-surface border border-slate-700/60">{children}</div>;
}

function Msg({ title, text }: { title: string; text?: string }) {
  return (
    <Card>
      <div className="text-center py-3">
        <div className="text-base font-bold text-slate-100">{title}</div>
        {text && <p className="text-sm text-slate-400 mt-1">{text}</p>}
      </div>
    </Card>
  );
}

type PostFn = (url: string, key: string, body: Record<string, unknown>) => Promise<Api | null>;

function Screen({ state, post, refresh }: { state: StateDTO; post: PostFn; refresh: () => void }) {
  switch (state.screen) {
    case 'WAIT_R1':
      return <Msg title="Stand by" text="Round 1 has not started yet." />;
    case 'R1':
      return <Round1Screen state={state} post={post} refresh={refresh} />;
    case 'R1_DONE':
      return <Msg title="Round 1 is over" text="Results are being counted." />;
    case 'R2_SPECTATOR':
    case 'R3_SPECTATOR':
      return <Msg title={state.message ?? 'Watching'} />;
    case 'R2_DONE':
      return <Msg title="Run complete" text={state.message} />;
    case 'R2_BREAK':
      return <Msg title="Break" text="Round 2 is over. Round 3 is coming." />;
    case 'R3':
      return <Round3Screen state={state} refresh={refresh} />;
    case 'ENDED':
      return <Msg title="The hunt has ended" text="Thanks for playing." />;
    case 'R2_SCAN':
      return (
        <Card>
          <div className="text-center py-2">
            <div className="text-base font-bold text-slate-100">Run {state.run}: find a QR code</div>
            <p className="text-sm text-slate-400 mt-2">{state.message ?? 'Scan any QR code around campus with your phone camera.'}</p>
          </div>
        </Card>
      );
    case 'R2_TEASER':
      return <Teaser state={state} post={post} refresh={refresh} />;
    case 'R2_QUESTIONS':
      return <Questions state={state} post={post} refresh={refresh} />;
  }
}

function Teaser({ state, post, refresh }: { state: StateDTO; post: PostFn; refresh: () => void }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim() || busy) return;
    setBusy(true);
    setMsg(null);
    const res = await post('/api/teaser', `teaser:${answer.trim().toLowerCase()}`, { answer });
    setBusy(false);
    if (!res) return;
    if (res.ok) refresh();
    else setMsg(res.code ? getErrorMessage(res.code) : 'Something went wrong.');
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="text-xs uppercase tracking-wider text-slate-400">Your piece{(state.piecesHeld?.length ?? 0) === 1 ? '' : 's'}</div>
        {state.piecesHeld?.map((p) => (
          <div key={p.pieceNo} className="mt-2 flex items-baseline gap-3">
            <span className="text-xs text-slate-400">#{p.pieceNo}</span>
            <span className="text-2xl font-extrabold text-accent break-words">{p.text}</span>
          </div>
        ))}
        <p className="text-sm text-slate-400 mt-3">
          Teammates registered: <span className="text-slate-100 font-semibold">{state.registered}/{state.total}</span>. Put the pieces together.
        </p>
      </Card>
      {state.me.isCaptain && (
        <form onSubmit={submit} className="flex flex-col gap-2">
          <input
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={!state.canAnswer}
            placeholder={state.canAnswer ? 'Type the answer' : 'Waiting for every teammate to scan'}
            className="w-full rounded-lg bg-slate-900 border border-slate-700 px-4 py-3 text-base text-slate-100 disabled:opacity-50"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button disabled={!state.canAnswer || busy || !answer.trim()} className="w-full py-3.5 rounded-xl bg-accent text-slate-950 font-bold disabled:opacity-40">
            {busy ? 'Checking...' : 'Submit answer'}
          </button>
          {msg && <p className="text-sm text-amber-300 text-center">{msg}</p>}
        </form>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  one_try_left: 'One try left',
  correct: 'Correct',
  locked: 'Locked',
  voided: 'Voided',
};

function Questions({ state, post, refresh }: { state: StateDTO; post: PostFn; refresh: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs uppercase tracking-wider text-slate-400">Your questions</div>
      {state.mine?.length ? (
        state.mine.map((q: MemberQuestionDTO) => (
          <Card key={q.questionNo}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-accent">Question #{q.questionNo}</span>
              <span className="text-xs text-slate-400">{STATUS_LABEL[q.status]}</span>
            </div>
            <p className="text-base text-slate-100 mt-2">{q.stem}</p>
            <p className="text-xs text-slate-400 mt-2">Find the poster at <span className="text-slate-200 font-semibold">{q.locationName}</span>, then tell your captain the answer.</p>
          </Card>
        ))
      ) : (
        <Msg title="No questions for you" text={state.me.isCaptain ? undefined : 'Your captain handles the rest.'} />
      )}

      {state.board && (
        <>
          <div className="text-xs uppercase tracking-wider text-slate-400 mt-2">Captain board</div>
          {state.board.map((b) => (
            <BoardQuestion key={b.questionNo} q={b} post={post} refresh={refresh} />
          ))}
        </>
      )}
    </div>
  );
}

function BoardQuestion({ q, post, refresh }: { q: CaptainBoardQuestionDTO; post: PostFn; refresh: () => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const done = q.status === 'correct' || q.status === 'locked' || q.status === 'voided';

  async function submit() {
    if (!choice || busy) return;
    setBusy(true);
    setMsg(null);
    const res = await post('/api/answer', `a:${q.questionNo}:${choice}`, { kind: 'r2', key: q.questionNo, optionId: choice });
    setBusy(false);
    if (!res) return;
    if (res.ok) {
      setMsg(ANSWER_FEEDBACK[String(res.status)] ?? null);
      setChoice(null);
      refresh();
    } else {
      setMsg(res.code ? getErrorMessage(res.code) : 'Something went wrong.');
      refresh();
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-accent">Question #{q.questionNo}</span>
        <span className="text-xs text-slate-400">{STATUS_LABEL[q.status]}</span>
      </div>
      {!done && (
        <>
          <div className="mt-3 flex flex-col gap-2">
            {q.options.map((o) => (
              <label key={o.id} className={`flex items-center gap-3 rounded-lg border px-3 py-3 text-base cursor-pointer ${choice === o.id ? 'border-accent bg-amber-500/10' : 'border-slate-700 bg-slate-900'}`}>
                <input type="radio" name={`q${q.questionNo}`} checked={choice === o.id} onChange={() => setChoice(o.id)} className="accent-amber-500" />
                <span>{o.text}</span>
              </label>
            ))}
          </div>
          <button onClick={submit} disabled={!choice || busy} className="mt-3 w-full py-3.5 rounded-xl bg-accent text-slate-950 font-bold disabled:opacity-40">
            {busy ? 'Submitting...' : 'Submit'}
          </button>
        </>
      )}
      {msg && <p className="text-sm text-amber-300 text-center mt-2">{msg}</p>}
    </Card>
  );
}

function Round1Screen({ state, post, refresh }: { state: StateDTO; post: PostFn; refresh: () => void }) {
  const riddles = state.riddles || [];
  const canSubmit = !!state.canSubmit;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400">Round 1</div>
          <h2 className="text-base font-bold text-slate-100">Campus Riddles</h2>
        </div>
        <span className="text-xs text-slate-400 font-medium">
          {riddles.filter((r) => r.status === 'correct').length} of {riddles.length} solved
        </span>
      </div>

      {!canSubmit && (
        <div className="rounded-lg p-3 bg-slate-800/80 border border-slate-700 text-xs text-slate-300">
          👀 You are viewing in read-only mode. Only your captain can submit answers for the team.
        </div>
      )}

      {riddles.length === 0 ? (
        <Card>
          <div className="text-center py-6 text-slate-400 text-sm">
            No riddles available right now. Tell an organiser.
          </div>
        </Card>
      ) : (
        riddles.map((riddle) => (
          <RiddleCard
            key={riddle.id}
            riddle={riddle}
            canSubmit={canSubmit}
            post={post}
            refresh={refresh}
          />
        ))
      )}
    </div>
  );
}

function RiddleCard({
  riddle,
  canSubmit,
  post,
  refresh,
}: {
  riddle: RiddleDTO;
  canSubmit: boolean;
  post: PostFn;
  refresh: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const done = riddle.status === 'correct' || riddle.status === 'wrong';

  async function handleSubmit() {
    if (!choice || busy || !canSubmit) return;
    setBusy(true);
    setFeedback(null);

    const res = await post('/api/answer', `r1:${riddle.id}:${choice}`, {
      kind: 'r1',
      key: riddle.id,
      optionId: choice,
    });
    setBusy(false);

    if (!res) return;
    if (res.ok) {
      setFeedback(res.status === 'correct' ? 'Correct.' : 'Wrong.');
      setChoice(null);
      refresh();
    } else {
      setFeedback(res.code ? getErrorMessage(res.code) : 'Something went wrong.');
      refresh();
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-accent">Riddle #{riddle.position}</span>
        <span
          className={`px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider ${
            riddle.status === 'correct'
              ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800'
              : riddle.status === 'wrong'
              ? 'bg-red-950/60 text-red-400 border border-red-800'
              : 'bg-slate-800 text-slate-400 border border-slate-700'
          }`}
        >
          {riddle.status === 'correct' ? 'Solved' : riddle.status === 'wrong' ? 'Wrong' : 'Open'}
        </span>
      </div>

      <p className="text-base text-slate-100 mt-3 whitespace-pre-line leading-relaxed">{riddle.text}</p>

      {/* Options */}
      <div className="mt-4 flex flex-col gap-2">
        {riddle.options.map((opt) => {
          const isSelected = choice === opt.id;
          return (
            <label
              key={opt.id}
              className={`flex items-start gap-3 rounded-lg border p-3 text-sm cursor-pointer transition-colors ${
                done
                  ? 'border-slate-800 bg-slate-900/40 text-slate-400 cursor-not-allowed'
                  : isSelected
                  ? 'border-accent bg-amber-500/10 text-slate-100'
                  : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-600'
              }`}
            >
              <input
                type="radio"
                name={`riddle-${riddle.id}`}
                disabled={done || !canSubmit}
                checked={isSelected}
                onChange={() => setChoice(opt.id)}
                className="mt-0.5 accent-amber-500 disabled:opacity-40"
              />
              <span className="leading-snug">{opt.text}</span>
            </label>
          );
        })}
      </div>

      {/* Action / Feedback */}
      {!done && canSubmit && (
        <button
          onClick={handleSubmit}
          disabled={!choice || busy}
          className="mt-4 w-full py-3 rounded-xl bg-accent text-slate-950 font-bold text-sm tracking-wide disabled:opacity-40 hover:bg-amber-400 transition-colors"
        >
          {busy ? 'Submitting...' : 'Submit Riddle'}
        </button>
      )}

      {feedback && (
        <div
          className={`mt-3 p-2.5 rounded text-center text-xs font-semibold ${
            feedback === 'Correct.'
              ? 'bg-emerald-950/60 text-emerald-300 border border-emerald-800'
              : 'bg-red-950/60 text-red-300 border border-red-800'
          }`}
        >
          {feedback}
        </div>
      )}
    </Card>
  );
}

function Round3Screen({ state, refresh }: { state: StateDTO; refresh: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [throttleSec, setThrottleSec] = useState<number | null>(null);

  const isWinner = state.winnerTeamId === state.me.teamId;
  const isClaimedByOther = state.claimed && !isWinner;

  // Countdown timer for lockout
  useEffect(() => {
    if (throttleSec === null || throttleSec <= 0) return;
    const interval = setInterval(() => {
      setThrottleSec((s) => (s !== null && s > 1 ? s - 1 : null));
    }, 1000);
    return () => clearInterval(interval);
  }, [throttleSec]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!password.trim() || busy || throttleSec !== null) return;
    setBusy(true);
    setMsg(null);

    try {
      const res = await fetch('/api/r3/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim() }),
      });
      const data = await res.json();
      if (data.ok && data.won) {
        setMsg({ text: 'Password correct! You have won Round 3!', ok: true });
        refresh();
      } else if (data.code === 'THROTTLED') {
        const s = data.retryAfterSec ?? 30;
        setThrottleSec(s);
        setMsg({ text: getErrorMessage('THROTTLED', { s }), ok: false });
      } else {
        setMsg({ text: data.code ? getErrorMessage(data.code) : 'Incorrect password.', ok: false });
        if (data.code === 'ALREADY_CLAIMED') {
          refresh();
        }
      }
    } catch {
      setMsg({ text: 'Network error. Please try again.', ok: false });
    } finally {
      setBusy(false);
    }
  }

  // 1. If this team won Round 3
  if (isWinner) {
    return (
      <div className="flex flex-col gap-4">
        <div className="p-6 rounded-2xl bg-gradient-to-b from-amber-500/20 to-slate-900 border-2 border-accent text-center shadow-xl">
          <span className="px-3 py-1 text-xs font-black uppercase tracking-wider rounded-full bg-accent text-slate-950">
            🏆 FIRST PLACE WINNER 🏆
          </span>
          <div className="text-4xl font-black text-accent mt-4 font-mono tracking-wider">
            {state.me.teamId}
          </div>
          <div className="text-xl font-bold text-slate-100 mt-1">{state.me.teamName}</div>
          <p className="text-sm font-semibold text-amber-200 mt-3">
            Go to the room and show this to the organiser.
          </p>

          <div className="mt-6 p-4 rounded-xl bg-slate-950/80 border border-slate-700 space-y-2">
            <div>
              <span className="text-[10px] uppercase font-bold text-slate-400">Winning Room:</span>
              <div className="text-2xl font-black text-slate-100">{state.room || 'Room 101'}</div>
            </div>
            {state.keyInfo && (
              <div className="pt-2 border-t border-slate-800">
                <span className="text-[10px] uppercase font-bold text-slate-400">Secret Key Info:</span>
                <div className="text-sm font-mono text-accent font-semibold break-words">
                  {state.keyInfo}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 2. If another team already claimed victory
  if (isClaimedByOther) {
    return (
      <Card>
        <div className="text-center py-6">
          <div className="w-12 h-12 rounded-full bg-slate-800 border border-slate-700 text-slate-400 flex items-center justify-center mx-auto mb-3 text-xl font-bold">
            🔒
          </div>
          <h2 className="text-lg font-bold text-slate-100">Round 3 Claimed</h2>
          <p className="text-sm text-slate-400 mt-2">
            Another team got there first. Thanks for putting up a great race!
          </p>
        </div>
      </Card>
    );
  }

  // 3. Active Round 3 Clue and Password Input
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Round 3</div>
          <h2 className="text-base font-bold text-slate-100">Final Decryption</h2>
        </div>
        <span className="px-2 py-0.5 text-xs font-bold uppercase rounded bg-accent/20 text-accent">
          Top 5 Race
        </span>
      </div>

      {/* Enciphered Clue Card */}
      <Card>
        <span className="text-xs font-bold uppercase text-slate-400 tracking-wider">Enciphered Clue</span>
        <div className="mt-2 p-3.5 rounded-lg bg-slate-950/80 border border-slate-800 font-mono text-sm text-accent whitespace-pre-wrap leading-relaxed break-words">
          {state.clue || 'Clue arrives shortly...'}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Decrypt the message with your team. Any team member can submit the final password.
        </p>
      </Card>

      {/* Password Submission Form */}
      <Card>
        <form onSubmit={submitPassword} className="space-y-3">
          <div>
            <label className="block text-xs font-semibold uppercase text-slate-400 mb-1">
              Final Password
            </label>
            <input
              type="text"
              disabled={busy || throttleSec !== null}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={throttleSec ? `Locked out for ${throttleSec}s` : 'Enter password'}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full px-3.5 py-2.5 text-sm rounded-lg bg-slate-900 text-slate-100 border border-slate-700 focus:outline-none focus:border-accent disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={!password.trim() || busy || throttleSec !== null}
            className="w-full py-3.5 rounded-xl bg-accent hover:bg-amber-400 text-slate-950 font-bold text-sm tracking-wide disabled:opacity-40 transition-colors shadow-md"
          >
            {busy ? 'Verifying...' : throttleSec ? `Locked (${throttleSec}s)` : 'Submit Password'}
          </button>

          {msg && (
            <p
              className={`text-xs text-center font-semibold mt-2 ${
                msg.ok ? 'text-emerald-400' : 'text-amber-300'
              }`}
            >
              {msg.text}
            </p>
          )}
        </form>
      </Card>
    </div>
  );
}


