import { redirect } from 'next/navigation';
import { getPlayerSession } from '@/lib/session';
import { db } from '@/lib/db';
import { mapPlayerMe } from '@/lib/dto';
import ClientLogoutButton from './ClientLogoutButton';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getPlayerSession();

  if (!session) {
    redirect('/login');
  }

  // Load student and team fresh from database (Section 10)
  const { data: student, error: studentErr } = await db
    .from('students')
    .select('id, name, is_captain, absent, team_id')
    .eq('id', session.sid)
    .single();

  if (studentErr || !student) {
    redirect('/login');
  }

  const { data: team } = await db
    .from('teams')
    .select('id, name, n, qualified, withdrawn')
    .eq('id', student.team_id)
    .single();

  const me = mapPlayerMe(
    student,
    team || { id: student.team_id, name: 'Squad', n: 4 }
  );

  return (
    <div className="flex flex-col items-center justify-between flex-1 w-full max-w-player mx-auto py-6">
      <div className="w-full">
        {/* Top bar */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-800">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-400 font-semibold">
              Team {me.teamId}
            </div>
            <div className="text-lg font-bold text-slate-100">{me.teamName}</div>
          </div>
          <div className="text-right">
            <span
              className={`inline-block px-2.5 py-0.5 rounded text-xs font-bold uppercase tracking-wider ${
                me.isCaptain
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  : 'bg-slate-800 text-slate-300'
              }`}
            >
              {me.isCaptain ? 'Captain' : 'Agent'}
            </span>
          </div>
        </div>

        {/* Member Card */}
        <div className="mt-6 p-5 rounded-xl bg-surface border border-slate-700/60 shadow-lg">
          <div className="text-xs text-slate-400 uppercase tracking-wider">
            Player Profile
          </div>
          <div className="text-xl font-bold text-accent mt-1">{me.name}</div>
          <div className="text-xs font-mono text-slate-400 mt-0.5">ID: {me.studentId}</div>

          <div className="mt-4 pt-4 border-t border-slate-700/60 flex items-center justify-between text-xs text-slate-300">
            <span>Squad Size</span>
            <span className="font-semibold text-slate-100">{me.n} Members</span>
          </div>
        </div>

        {/* Status notice */}
        <div className="mt-4 p-4 rounded-xl bg-slate-900 border border-slate-800 text-center">
          <p className="text-sm text-slate-300 font-medium">
            Awaiting Next Phase
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Stand by for hunt briefing and round dispatch.
          </p>
        </div>
      </div>

      <div className="w-full mt-8">
        <ClientLogoutButton />
      </div>
    </div>
  );
}
