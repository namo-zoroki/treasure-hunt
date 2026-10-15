'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function ClientLogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      router.push('/login');
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      className="w-full h-11 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 border border-slate-700 text-slate-300 font-semibold rounded-lg text-xs tracking-wider uppercase transition-colors"
    >
      {loading ? 'Logging out...' : 'Log Out'}
    </button>
  );
}
