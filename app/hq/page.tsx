'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface DashboardData {
  ok: boolean;
  clock: {
    serverNowMs: number;
    eventNowMs: number;
    paused: boolean;
    pausedAt: string | null;
    pausedTotalMs: number;
  };
  state: {
    mode: 'test' | 'live';
    phase: string;
    pausedAt: string | null;
    pausedTotalMs: number;
    r1EndMs: number | null;
    r2StartMs: number | null;
    run2OpenMs: number | null;
    r2HardEndMs: number | null;
    breakEndMs: number | null;
  };
  primaryAction: {
    action: string;
    label: string;
    enabled: boolean;
    reason?: string;
  } | null;
  stats: {
    totalTeams: number;
    qualifiedTeams: number;
    activeQRs: number;
  };
  teams: Array<{
    id: string;
    name: string;
    n: number;
    qualified: boolean;
    withdrawn: boolean;
    r3_eligible: boolean;
    runs?: any[];
  }>;
  qrs: Array<{
    id: number;
    name: string;
    capacity: number;
    active: boolean;
    run1Count: number;
    run2Count: number;
  }>;
}

export default function AdminHQDashboard() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [addMinutes, setAddMinutes] = useState(5);
  const [searchTerm, setSearchTerm] = useState('');
  const lastFetchRef = useRef<{ local: number; eventNow: number; paused: boolean }>({
    local: Date.now(),
    eventNow: Date.now(),
    paused: false,
  });
  const [clientEventNow, setClientEventNow] = useState<number>(Date.now());

  // Fetch dashboard data
  async function fetchDashboard() {
    try {
      const res = await fetch('/api/admin/dashboard');
      if (res.status === 401) {
        router.push('/hq/login');
        return;
      }
      const json: DashboardData = await res.json();
      if (json.ok) {
        setData(json);
        setError(null);
        lastFetchRef.current = {
          local: Date.now(),
          eventNow: json.clock.eventNowMs,
          paused: json.clock.paused,
        };
        setClientEventNow(json.clock.eventNowMs);
      } else {
        setError(json.primaryAction?.reason || 'Failed to load dashboard');
      }
    } catch (err: any) {
      setError(err?.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }

  // Poll dashboard every 5s
  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 5000);
    return () => clearInterval(interval);
  }, []);

  // Update client clock display every second
  useEffect(() => {
    const clockInterval = setInterval(() => {
      const { local, eventNow, paused } = lastFetchRef.current;
      if (paused) {
        setClientEventNow(eventNow);
      } else {
        const elapsed = Date.now() - local;
        setClientEventNow(eventNow + elapsed);
      }
    }, 1000);
    return () => clearInterval(clockInterval);
  }, []);

  // Execute event actions
  async function handleAction(action: string, payload?: any, confirmText?: string) {
    if (confirmText) {
      const confirmed = window.confirm(confirmText);
      if (!confirmed) return;
    }

    setActionLoading(true);
    try {
      const res = await fetch(`/api/admin/event/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const result = await res.json();
      if (!result.ok) {
        alert(`Action failed: ${result.message || result.code}`);
      } else {
        await fetchDashboard();
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    router.push('/hq/login');
    router.refresh();
  }

  // Calculate countdown to the active deadline
  function getDeadlineCountdown(): { label: string; text: string } | null {
    if (!data) return null;
    const { phase, r1EndMs, r2HardEndMs, breakEndMs } = data.state;
    let deadline: number | null = null;
    let label = '';

    if (phase === 'r1_running' && r1EndMs) {
      deadline = r1EndMs;
      label = 'R1 Closes in';
    } else if (phase === 'r2_running' && r2HardEndMs) {
      deadline = r2HardEndMs;
      label = 'R2 Hard End in';
    } else if (phase === 'r2_break' && breakEndMs) {
      deadline = breakEndMs;
      label = 'Break ends in';
    }

    if (!deadline) return null;

    const diffMs = Math.max(0, deadline - clientEventNow);
    const totalSec = Math.floor(diffMs / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return {
      label,
      text: `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`,
    };
  }

  const countdown = getDeadlineCountdown();

  // Filtered teams list
  const filteredTeams = (data?.teams || []).filter(
    (t) =>
      t.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
      t.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="w-full max-w-4xl mx-auto py-6 px-4">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-4 border-b border-slate-700">
        <div>
          <div className="flex items-center gap-2">
            <span className="px-2 py-0.5 text-xs font-semibold uppercase bg-accent/20 text-accent rounded">
              HQ Control
            </span>
            {data && (
              <span
                className={`px-2 py-0.5 text-xs font-bold uppercase rounded ${
                  data.state.mode === 'live'
                    ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                    : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                }`}
              >
                {data.state.mode}
              </span>
            )}
          </div>
          <h1 className="text-xl font-bold text-slate-100 mt-1">Campus Treasure Hunt</h1>
        </div>
        <button
          onClick={handleLogout}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600 transition-colors"
        >
          Logout
        </button>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-950/60 border border-red-800 text-red-200 text-sm rounded-lg">
          {error}
        </div>
      )}

      {/* Main Clock & Phase Status Card */}
      {data && (
        <div className="mt-6 p-5 rounded-xl bg-slate-800/90 border border-slate-700 shadow-md">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-400">Current Phase</span>
              <div className="text-2xl font-black text-accent mt-0.5 uppercase tracking-wider">
                {data.state.phase.replace('_', ' ')}
              </div>
            </div>

            <div className="text-right">
              <span className="text-xs uppercase tracking-wide text-slate-400">Event Clock</span>
              <div className="flex items-center justify-end gap-2 mt-0.5">
                {data.clock.paused && (
                  <span className="px-2 py-0.5 text-xs font-bold uppercase bg-amber-500 text-slate-950 rounded animate-pulse">
                    PAUSED
                  </span>
                )}
                <span className="font-mono text-xl font-bold text-slate-200">
                  {new Date(clientEventNow).toLocaleTimeString()}
                </span>
              </div>
            </div>
          </div>

          {/* Active Countdown */}
          {countdown && (
            <div className="mt-4 p-3 rounded-lg bg-slate-900/80 border border-slate-700/80 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300 uppercase">{countdown.label}</span>
              <span className="font-mono text-2xl font-extrabold text-accent">
                {countdown.text}
              </span>
            </div>
          )}

          {/* Big Action Button for Primary Phase Transition */}
          {data.primaryAction && (
            <div className="mt-6 pt-4 border-t border-slate-700">
              <button
                disabled={!data.primaryAction.enabled || actionLoading}
                onClick={() =>
                  handleAction(
                    data.primaryAction!.action,
                    undefined,
                    `Proceed with action: "${data.primaryAction!.label}"?`
                  )
                }
                className="w-full py-3.5 px-4 rounded-lg bg-accent text-slate-950 hover:bg-amber-400 font-bold text-base transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-lg active:scale-[0.99]"
              >
                {actionLoading ? 'Processing...' : data.primaryAction.label}
              </button>
              {data.primaryAction.reason && (
                <p className="text-xs text-amber-400 mt-1.5 text-center">
                  Notice: {data.primaryAction.reason}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Clock Controls: Pause / Resume / Add Time */}
      {data && (
        <div className="mt-6 p-5 rounded-xl bg-slate-800/80 border border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide mb-3">
            Clock Controls
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Pause / Resume */}
            <div className="flex flex-col justify-between p-3.5 rounded-lg bg-slate-900/60 border border-slate-700/80">
              <div>
                <div className="text-xs font-medium text-slate-300">Clock Pause / Resume</div>
                <p className="text-xs text-slate-400 mt-1">
                  Pausing freezes the event clock and shifts all deadlines accordingly.
                </p>
              </div>
              <div className="mt-3">
                {data.clock.paused ? (
                  <button
                    disabled={actionLoading}
                    onClick={() => handleAction('resume', undefined, 'Resume event clock?')}
                    className="w-full py-2 px-3 text-xs font-bold rounded bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
                  >
                    Resume Event
                  </button>
                ) : (
                  <button
                    disabled={
                      actionLoading ||
                      !['r1_running', 'r2_running', 'r2_break', 'r3_open'].includes(
                        data.state.phase
                      )
                    }
                    onClick={() => handleAction('pause', undefined, 'Pause event clock?')}
                    className="w-full py-2 px-3 text-xs font-bold rounded bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-40"
                  >
                    Pause Event
                  </button>
                )}
              </div>
            </div>

            {/* Add Time */}
            <div className="flex flex-col justify-between p-3.5 rounded-lg bg-slate-900/60 border border-slate-700/80">
              <div>
                <div className="text-xs font-medium text-slate-300">Add Time (Minutes)</div>
                <p className="text-xs text-slate-400 mt-1">
                  Pushes all deadlines later by adding to paused total ms.
                </p>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="number"
                  min="1"
                  max="120"
                  value={addMinutes}
                  onChange={(e) => setAddMinutes(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-20 px-2.5 py-1.5 text-xs rounded bg-slate-800 text-slate-100 border border-slate-600 focus:outline-none focus:border-accent"
                />
                <button
                  disabled={actionLoading}
                  onClick={() =>
                    handleAction(
                      'add-time',
                      { minutes: addMinutes },
                      `Add ${addMinutes} minutes to all deadlines?`
                    )
                  }
                  className="flex-1 py-1.5 px-3 text-xs font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-100 border border-slate-500 transition-colors"
                >
                  + Add Time
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Mode & Reset Controls */}
      {data && (
        <div className="mt-6 p-5 rounded-xl bg-slate-800/80 border border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide mb-3">
            Event Management & Mode
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Go Live */}
            <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-700/80">
              <div className="text-xs font-medium text-slate-300">Switch to Live Mode</div>
              <p className="text-xs text-slate-400 mt-1">
                Permanent switch. Once in live mode, reset event data is locked.
              </p>
              <button
                disabled={data.state.mode === 'live' || actionLoading}
                onClick={() => {
                  const val = window.prompt('Type LIVE to confirm switching to live mode:');
                  if (val === 'LIVE') {
                    handleAction('go-live', { confirm: 'LIVE' });
                  }
                }}
                className="mt-3 w-full py-2 px-3 text-xs font-bold rounded bg-slate-800 hover:bg-slate-700 text-red-400 border border-red-800/40 transition-colors disabled:opacity-40"
              >
                {data.state.mode === 'live' ? 'Live Mode Active' : 'Switch to Live'}
              </button>
            </div>

            {/* Reset Event Data */}
            <div className="p-3.5 rounded-lg bg-slate-900/60 border border-slate-700/80">
              <div className="text-xs font-medium text-slate-300">Reset Event Data</div>
              <p className="text-xs text-slate-400 mt-1">
                Truncates operational tables and resets state to setup (test mode only).
              </p>
              <button
                disabled={data.state.mode !== 'test' || actionLoading}
                onClick={() => {
                  const val = window.prompt(
                    'DANGER: This truncates all attempts and runs!\nType RESET to confirm:'
                  );
                  if (val === 'RESET') {
                    handleAction('reset', { confirm: 'RESET' });
                  }
                }}
                className="mt-3 w-full py-2 px-3 text-xs font-bold rounded bg-red-950/60 hover:bg-red-900/80 text-red-300 border border-red-700 transition-colors disabled:opacity-40"
              >
                Reset Event (Typed RESET)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Teams & QRs Summary Section */}
      {data && (
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Teams Overview */}
          <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">
                Teams ({data.stats.totalTeams} total, {data.stats.qualifiedTeams} qualified)
              </h2>
            </div>
            <input
              type="text"
              placeholder="Search team ID or name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-1.5 text-xs rounded bg-slate-900 text-slate-100 border border-slate-700 mb-3 focus:outline-none focus:border-accent"
            />
            <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
              {filteredTeams.map((team) => (
                <div
                  key={team.id}
                  className="flex items-center justify-between p-2.5 rounded bg-slate-900/60 border border-slate-700 text-xs"
                >
                  <div>
                    <span className="font-bold text-accent mr-2">{team.id}</span>
                    <span className="text-slate-200 font-medium">{team.name}</span>
                    <span className="text-slate-400 ml-1.5">({team.n} members)</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {team.qualified && (
                      <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-emerald-500/20 text-emerald-400">
                        Qualified
                      </span>
                    )}
                    {team.withdrawn && (
                      <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase rounded bg-red-500/20 text-red-400">
                        Withdrawn
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {filteredTeams.length === 0 && (
                <p className="text-xs text-slate-400 text-center py-4">No matching teams.</p>
              )}
            </div>
          </div>

          {/* QR Locations Capacity Overview */}
          <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
            <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide mb-3">
              QR Locations ({data.stats.activeQRs} active)
            </h2>
            <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
              {data.qrs.map((qr) => (
                <div
                  key={qr.id}
                  className="flex items-center justify-between p-2.5 rounded bg-slate-900/60 border border-slate-700 text-xs"
                >
                  <div>
                    <span className="font-semibold text-slate-200">{qr.name}</span>
                    <span className="text-slate-400 ml-1.5">(Cap: {qr.capacity})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">
                      R1: <b className="text-slate-200">{qr.run1Count}</b>
                    </span>
                    <span className="text-slate-400">
                      R2: <b className="text-slate-200">{qr.run2Count}</b>
                    </span>
                    <span
                      className={`w-2 h-2 rounded-full ${
                        qr.active ? 'bg-emerald-500' : 'bg-red-500'
                      }`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
