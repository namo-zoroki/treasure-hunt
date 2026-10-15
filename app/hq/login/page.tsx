'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function AdminLoginPage() {
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(timer);
          setError(null);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (countdown && countdown > 0) return;
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: username.trim(),
          password,
        }),
      });

      const data = await res.json();

      if (data.ok) {
        router.push('/hq');
        router.refresh();
      } else {
        if (data.code === 'THROTTLED' && data.retryAfterSec) {
          setCountdown(data.retryAfterSec);
        }
        setError(data.message || 'Login failed.');
      }
    } catch {
      setError('Network failure. Retrying...');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 w-full max-w-md mx-auto py-12">
      <div className="w-full bg-slate-800 border border-slate-700 rounded-xl p-8 shadow-2xl">
        <div className="text-center mb-6">
          <div className="inline-block px-2.5 py-1 mb-2 text-xs font-semibold tracking-wider uppercase bg-accent/20 text-accent rounded">
            HQ Control
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100">
            Organizer Access
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Sign in to manage the hunt and view live telemetry
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="username"
              className="block text-xs font-semibold tracking-wider uppercase text-slate-300 mb-1"
            >
              Admin Username
            </label>
            <input
              id="username"
              type="text"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. naman"
              disabled={loading || (countdown !== null && countdown > 0)}
              className="w-full h-11 px-3.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-accent text-sm"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold tracking-wider uppercase text-slate-300 mb-1"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading || (countdown !== null && countdown > 0)}
              className="w-full h-11 px-3.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-100 placeholder-slate-500 focus:outline-none focus:border-accent text-sm"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-950/60 border border-red-800/60 text-red-200 text-xs text-center font-medium">
              {countdown && countdown > 0 ? (
                <span>Too many tries. Wait {countdown} seconds.</span>
              ) : (
                error
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || (countdown !== null && countdown > 0)}
            className="w-full h-11 mt-2 bg-accent hover:bg-accentHover active:bg-amber-600 text-slate-950 font-bold rounded-lg text-sm tracking-wide transition-colors disabled:opacity-50"
          >
            {loading
              ? 'Verifying...'
              : countdown && countdown > 0
              ? `Locked (${countdown}s)`
              : 'Sign In to HQ'}
          </button>
        </form>
      </div>
    </div>
  );
}
