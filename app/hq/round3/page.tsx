'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';

const HQNav = () => (
  <nav className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs font-medium text-slate-400">
    <Link href="/hq" className="hover:text-accent transition-colors">Dashboard</Link>
    <Link href="/hq/teams" className="hover:text-accent transition-colors">Teams & Students</Link>
    <Link href="/hq/selection" className="hover:text-accent transition-colors">Selection</Link>
    <Link href="/hq/round3" className="text-accent">Round 3</Link>
    <Link href="/hq/content" className="hover:text-accent transition-colors">Content</Link>
    <Link href="/hq/qr" className="hover:text-accent transition-colors">QR Locations</Link>
    <Link href="/hq/interventions" className="hover:text-accent transition-colors">Interventions</Link>
    <Link href="/hq/logs" className="hover:text-accent transition-colors">Log & Export</Link>
    <Link href="/hq/settings" className="hover:text-accent transition-colors">Settings</Link>
  </nav>
);

interface WinnerInfo {
  teamId: string;
  teamName: string;
  studentId: string;
  studentName: string;
  createdMs: number;
}

interface EligibleTeam {
  id: string;
  name: string;
  n: number;
  r3_eligible: boolean;
  withdrawn: boolean;
}

export default function Round3AdminPage() {
  const [phase, setPhase] = useState<string>('setup');
  const [clueText, setClueText] = useState('');
  const [passwordNorm, setPasswordNorm] = useState('');
  const [keyInfo, setKeyInfo] = useState('');
  const [room, setRoom] = useState('');
  const [eligibleTeams, setEligibleTeams] = useState<EligibleTeam[]>([]);
  const [winner, setWinner] = useState<WinnerInfo | null>(null);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; ok: boolean } | null>(null);

  async function loadData() {
    try {
      const res = await fetch('/api/admin/round3');
      const data = await res.json();
      if (data.ok) {
        setPhase(data.phase || 'setup');
        setClueText(data.clueText || '');
        setPasswordNorm(data.passwordNorm || '');
        setKeyInfo(data.keyInfo || '');
        setRoom(data.room || '');
        setEligibleTeams(data.eligibleTeams || []);
        setWinner(data.winner || null);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);

    try {
      const res = await fetch('/api/admin/round3', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clueText, passwordNorm, keyInfo, room }),
      });
      const data = await res.json();
      if (data.ok) {
        setSaveMsg({ text: 'Round 3 configuration saved successfully.', ok: true });
        await loadData();
      } else {
        setSaveMsg({ text: data.message || 'Failed to save config', ok: false });
      }
    } catch (err: any) {
      setSaveMsg({ text: err.message || 'Network error', ok: false });
    } finally {
      setSaving(false);
    }
  }

  const inputClass = 'w-full px-3 py-2 text-xs rounded bg-slate-900 text-slate-100 border border-slate-700 focus:outline-none focus:border-accent';
  const labelClass = 'block text-[10px] font-semibold uppercase text-slate-400 mb-1';

  return (
    <div className="w-full max-w-5xl mx-auto py-6 px-4">
      {/* Header */}
      <div className="pb-4 border-b border-slate-700">
        <div>
          <span className="px-2 py-0.5 text-xs font-semibold uppercase bg-accent/20 text-accent rounded">HQ</span>
          <h1 className="text-xl font-bold text-slate-100 mt-1">Round 3 & Winner Check</h1>
        </div>
        <HQNav />
      </div>

      {/* WINNER BANNER FOR ORGANISERS */}
      {winner ? (
        <div className="mt-6 p-6 rounded-2xl bg-gradient-to-r from-amber-500/20 via-slate-800 to-amber-500/20 border-2 border-accent shadow-2xl">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <span className="px-3 py-1 text-xs font-black uppercase tracking-wider rounded-full bg-accent text-slate-950">
                Official Winning Claim
              </span>
              <div className="text-3xl font-black text-accent mt-3 font-mono tracking-wider">
                Team {winner.teamId}
              </div>
              <div className="text-lg font-bold text-slate-100 mt-0.5">
                {winner.teamName}
              </div>
              <p className="text-xs text-slate-300 mt-2 font-medium">
                Submitted by student <span className="text-slate-100 font-semibold">{winner.studentName}</span> ({winner.studentId})
                at {new Date(Number(winner.createdMs)).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-700 text-center min-w-[200px]">
              <span className="text-[10px] uppercase font-bold text-slate-400">Winning Room</span>
              <div className="text-2xl font-black text-slate-100 mt-0.5">{room || 'Room 101'}</div>
              <span className="inline-block mt-2 text-[11px] font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800 px-2 py-0.5 rounded">
                ✓ Check Team ID at Door
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-6 p-4 rounded-xl bg-slate-800/80 border border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
            <div>
              <div className="text-xs font-semibold text-slate-200">
                Awaiting Winner Claim
              </div>
              <div className="text-[11px] text-slate-400">
                Current phase: <span className="font-mono text-accent uppercase font-bold">{phase}</span>. No team has claimed the winning room yet.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Left: Eligible Teams */}
        <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">
              Top 5 Eligible Teams
            </h2>
            <span className="px-2 py-0.5 text-xs font-bold rounded bg-slate-700 text-slate-300">
              {eligibleTeams.length} Teams
            </span>
          </div>
          <p className="text-xs text-slate-400 mb-4">
            Populated when admin clicks &quot;Open Round 3&quot; based on Round 2 standings.
          </p>

          {eligibleTeams.length === 0 ? (
            <div className="text-xs text-slate-500 py-8 text-center">
              No teams eligible yet (Round 3 has not been opened).
            </div>
          ) : (
            <div className="space-y-2">
              {eligibleTeams.map((t) => (
                <div
                  key={t.id}
                  className={`p-3 rounded-lg border flex items-center justify-between ${
                    winner?.teamId === t.id
                      ? 'bg-amber-500/10 border-accent'
                      : 'bg-slate-900/60 border-slate-700'
                  }`}
                >
                  <div>
                    <span className="font-mono font-bold text-accent text-xs mr-2">{t.id}</span>
                    <span className="text-xs font-semibold text-slate-200">{t.name}</span>
                  </div>
                  {winner?.teamId === t.id && (
                    <span className="px-2 py-0.5 text-[10px] font-black uppercase rounded bg-accent text-slate-950">
                      Winner
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right: Round 3 Configuration */}
        <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide mb-3">
            Round 3 Clue & Secrets
          </h2>
          <form onSubmit={handleSaveConfig} className="space-y-3">
            <div>
              <label className={labelClass}>Enciphered Clue Text</label>
              <textarea
                className={`${inputClass} h-20 resize-none font-mono`}
                value={clueText}
                onChange={(e) => setClueText(e.target.value)}
                placeholder="The ciphered clue shown to the top 5 teams"
              />
            </div>

            <div>
              <label className={labelClass}>Password (Normalised: lowercase, single space)</label>
              <input
                className={`${inputClass} font-mono`}
                value={passwordNorm}
                onChange={(e) => setPasswordNorm(e.target.value)}
                placeholder="The winning password"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>Key Info (Winner only)</label>
                <input
                  className={inputClass}
                  value={keyInfo}
                  onChange={(e) => setKeyInfo(e.target.value)}
                  placeholder="Cipher key or notes"
                />
              </div>
              <div>
                <label className={labelClass}>Room (Winner only)</label>
                <input
                  className={inputClass}
                  value={room}
                  onChange={(e) => setRoom(e.target.value)}
                  placeholder="e.g. Room 204"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="mt-2 w-full py-2.5 rounded-lg bg-accent hover:bg-amber-400 text-slate-950 font-bold text-xs tracking-wide transition-colors disabled:opacity-40"
            >
              {saving ? 'Saving...' : 'Save Round 3 Config'}
            </button>

            {saveMsg && (
              <p className={`text-xs text-center mt-2 ${saveMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {saveMsg.text}
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
