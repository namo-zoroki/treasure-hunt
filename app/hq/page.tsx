'use client';

import React from 'react';
import { useRouter } from 'next/navigation';

export default function AdminHQDashboard() {
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    router.push('/hq/login');
    router.refresh();
  }

  return (
    <div className="w-full max-w-4xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between pb-6 border-b border-slate-700">
        <div>
          <span className="px-2 py-0.5 text-xs font-semibold uppercase bg-accent/20 text-accent rounded">
            HQ Panel
          </span>
          <h1 className="text-2xl font-bold text-slate-100 mt-1">
            Campus Treasure Hunt Control
          </h1>
        </div>
        <button
          onClick={handleLogout}
          className="px-3.5 py-1.5 text-xs font-medium rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600 transition-colors"
        >
          Logout
        </button>
      </div>

      <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
          <h2 className="text-base font-semibold text-slate-200 mb-2">
            Admin Session Active
          </h2>
          <p className="text-xs text-slate-400">
            Authenticated via secure admin JWT cookie. Full controls will be active as subsequent phases are implemented.
          </p>
        </div>

        <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
          <h2 className="text-base font-semibold text-slate-200 mb-2">
            Participant Import
          </h2>
          <p className="text-xs text-slate-400">
            CSV import endpoint is ready at <code className="text-accent">/api/admin/import</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
