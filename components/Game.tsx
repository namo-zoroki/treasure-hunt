'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CaptainBoardQuestionDTO, MemberQuestionDTO, StateDTO } from '@/lib/dto';
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
      return <Msg title="Round 1 is live" text="The riddle screen arrives in a later build." />;
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
      return <Msg title="Round 3" text="Round 3 screen arrives in a later build." />;
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
