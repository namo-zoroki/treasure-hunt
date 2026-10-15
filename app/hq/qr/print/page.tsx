import QRCode from 'qrcode';
import { db } from '@/lib/db';
import { getAdminSession } from '@/lib/session';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function PrintableQrSheetPage() {
  const session = await getAdminSession();
  if (!session) {
    redirect('/hq/login');
  }

  const { data: qrs } = await db
    .from('qr_locations')
    .select('id, name, token, capacity, active')
    .eq('active', true)
    .order('id');

  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';

  const qrsWithImages = await Promise.all(
    (qrs || []).map(async (qr) => {
      const link = `${baseUrl}/s/${qr.token}`;
      const dataUrl = await QRCode.toDataURL(link, {
        width: 320,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff',
        },
      });
      return {
        ...qr,
        link,
        dataUrl,
      };
    })
  );

  // Group into pages of 4 (Section 9: 4 per A4 page)
  const pages: (typeof qrsWithImages)[] = [];
  for (let i = 0; i < qrsWithImages.length; i += 4) {
    pages.push(qrsWithImages.slice(i, i + 4));
  }

  return (
    <div className="min-h-screen bg-white text-black p-4 print:p-0">
      {/* Non-print control bar */}
      <div className="mb-6 p-4 bg-slate-900 text-slate-100 rounded-lg flex items-center justify-between print:hidden max-w-4xl mx-auto shadow-lg">
        <div>
          <h1 className="text-base font-bold text-accent">Printable QR Code Sheets</h1>
          <p className="text-xs text-slate-300">
            Formatted for A4 paper with exactly 4 QR beacons per sheet.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/hq/qr"
            className="px-3 py-1.5 text-xs font-semibold rounded bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-600 transition-colors"
          >
            ← Back to HQ
          </a>
          <button
            onClick={() => window.print()}
            className="px-4 py-1.5 text-xs font-bold rounded bg-accent hover:bg-amber-400 text-slate-950 transition-colors"
          >
            Print Sheets (Ctrl+P)
          </button>
        </div>
      </div>

      {pages.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          No active QR locations found. Activate or add QRs in HQ.
        </div>
      ) : (
        pages.map((pageItems, pageIdx) => (
          <div
            key={pageIdx}
            className="page-container w-full max-w-[210mm] mx-auto min-h-[297mm] p-[10mm] border border-dashed border-slate-300 print:border-none print:p-0 flex flex-col justify-between mb-8 print:mb-0"
            style={{ pageBreakAfter: pageIdx < pages.length - 1 ? 'always' : 'auto' }}
          >
            <div className="grid grid-cols-2 grid-rows-2 gap-8 h-full flex-1">
              {pageItems.map((qr) => (
                <div
                  key={qr.id}
                  className="flex flex-col items-center justify-center p-6 border-2 border-slate-800 rounded-2xl text-center shadow-sm"
                >
                  <span className="text-[10px] font-bold tracking-widest uppercase text-slate-500 mb-1">
                    Campus Treasure Hunt Beacon
                  </span>
                  <img
                    src={qr.dataUrl}
                    alt={qr.name}
                    className="w-48 h-48 object-contain my-2"
                  />
                  <h3 className="text-lg font-black tracking-tight text-slate-900 mt-2 uppercase">
                    {qr.name}
                  </h3>
                  <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                    Capacity: {qr.capacity} players
                  </p>
                  <p className="text-[9px] font-mono text-slate-400 mt-1 break-all">
                    {qr.link}
                  </p>
                </div>
              ))}
            </div>

            <div className="text-center pt-4 text-[10px] text-slate-400 border-t border-slate-200 mt-4">
              Page {pageIdx + 1} of {pages.length} — Campus Treasure Hunt QR Poster Sheet
            </div>
          </div>
        ))
      )}
    </div>
  );
}
