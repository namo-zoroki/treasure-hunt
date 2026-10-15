import { redirect } from 'next/navigation';
import { getPlayerSession } from '@/lib/session';
import Game from '@/components/Game';
import ClientLogoutButton from './ClientLogoutButton';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getPlayerSession();
  if (!session) {
    redirect('/login');
  }

  return (
    <div className="flex flex-col flex-1 w-full max-w-player mx-auto py-4">
      <Game />
      <div className="w-full mt-8">
        <ClientLogoutButton />
      </div>
    </div>
  );
}
