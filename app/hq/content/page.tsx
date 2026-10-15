'use client';

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const HQNav = () => (
  <nav className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs font-medium text-slate-400">
    <Link href="/hq" className="hover:text-accent transition-colors">Dashboard</Link>
    <Link href="/hq/teams" className="hover:text-accent transition-colors">Teams & Students</Link>
    <Link href="/hq/content" className="text-accent">Content</Link>
    <Link href="/hq/qr" className="hover:text-accent transition-colors">QR Locations</Link>
    <Link href="/hq/interventions" className="hover:text-accent transition-colors">Interventions</Link>
    <Link href="/hq/logs" className="hover:text-accent transition-colors">Log & Export</Link>
    <Link href="/hq/settings" className="hover:text-accent transition-colors">Settings</Link>
  </nav>
);

type Tab = 'riddles' | 'questions' | 'teasers' | 'round3';

interface Option { id: string; text: string; }
interface Riddle { id: number; position: number; text: string; options: Option[]; correctOptionId: string; hasAttempts: boolean; }
interface Question { id: number; run: number; slot: number; variant: number; qrId: number; qrName: string; stem: string; options: Option[]; correctOptionId: string; hasAttempts: boolean; }
interface Teaser { id: number; run: number; size: number; pieces: string[]; answerNorm: string; }
interface QR { id: number; name: string; }
interface Round3Config { clueText: string; passwordNorm: string; keyInfo: string; room: string; }

function optionsFromText(text: string): Option[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^([a-z]):\s*(.+)$/i);
    if (m) return { id: m[1].toLowerCase(), text: m[2].trim() };
    return null;
  }).filter(Boolean) as Option[];
}

function optionsToText(opts: Option[]): string {
  return opts.map((o) => `${o.id}: ${o.text}`).join('\n');
}

export default function ContentPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('riddles');
  const [riddles, setRiddles] = useState<Riddle[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [teasers, setTeasers] = useState<Teaser[]>([]);
  const [qrs, setQrs] = useState<QR[]>([]);
  const [r3, setR3] = useState<Round3Config>({ clueText: '', passwordNorm: '', keyInfo: '', room: '' });
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Edit states
  const [editRiddle, setEditRiddle] = useState<number | null>(null);
  const [editQuestion, setEditQuestion] = useState<number | null>(null);
  const [editTeaser, setEditTeaser] = useState<number | null>(null);
  const [editForms, setEditForms] = useState<Record<string, any>>({});

  // New form states
  const [newRiddle, setNewRiddle] = useState({ position: '', text: '', optionsText: '', correctOptionId: '' });
  const [newQuestion, setNewQuestion] = useState({ run: '1', slot: '1', variant: '1', qrId: '', stem: '', optionsText: '', correctOptionId: '' });
  const [newTeaser, setNewTeaser] = useState({ run: '1', size: '3', piecesText: '', answerNorm: '' });
  const [showNewRiddle, setShowNewRiddle] = useState(false);
  const [showNewQuestion, setShowNewQuestion] = useState(false);
  const [showNewTeaser, setShowNewTeaser] = useState(false);

  const showMsg = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text });
    setTimeout(() => setMsg(null), 4000);
  };

  const fetchAll = useCallback(async () => {
    try {
      const [rRes, qRes, tRes, qrRes, r3Res] = await Promise.all([
        fetch('/api/admin/riddles'),
        fetch('/api/admin/questions'),
        fetch('/api/admin/teasers'),
        fetch('/api/admin/qr'),
        fetch('/api/admin/round3'),
      ]);
      if (rRes.status === 401) { router.push('/hq/login'); return; }
      const [rd, qd, td, qrd, r3d] = await Promise.all([rRes.json(), qRes.json(), tRes.json(), qrRes.json(), r3Res.json()]);
      if (rd.ok) setRiddles(rd.riddles);
      if (qd.ok) setQuestions(qd.questions);
      if (td.ok) setTeasers(td.teasers);
      if (qrd.ok) setQrs(qrd.qrs.map((q: any) => ({ id: q.id, name: q.name })));
      if (r3d.ok) setR3(r3d);
    } catch (e: any) {
      showMsg('err', e.message || 'Network error');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchAll();
    const iv = setInterval(fetchAll, 5000);
    return () => clearInterval(iv);
  }, [fetchAll]);

  async function callApi(url: string, method: string, body?: object) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }

  // Riddle actions
  async function saveRiddle(id: number) {
    const f = editForms[`r:${id}`] || {};
    const data = await callApi(`/api/admin/riddles/${id}`, 'PATCH', {
      ...(f.text !== undefined && { text: f.text }),
      ...(f.position !== undefined && { position: parseInt(f.position) }),
      ...(f.optionsText !== undefined && { options: optionsFromText(f.optionsText) }),
      ...(f.correctOptionId !== undefined && { correctOptionId: f.correctOptionId }),
    });
    if (data.ok) { showMsg('ok', 'Riddle updated'); setEditRiddle(null); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function deleteRiddle(id: number) {
    if (!confirm('Delete this riddle?')) return;
    const data = await callApi(`/api/admin/riddles/${id}`, 'DELETE');
    if (data.ok) { showMsg('ok', 'Riddle deleted'); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function createRiddle() {
    const opts = optionsFromText(newRiddle.optionsText);
    const data = await callApi('/api/admin/riddles', 'POST', {
      position: parseInt(newRiddle.position),
      text: newRiddle.text,
      options: opts,
      correctOptionId: newRiddle.correctOptionId,
    });
    if (data.ok) { showMsg('ok', 'Riddle created'); setShowNewRiddle(false); setNewRiddle({ position: '', text: '', optionsText: '', correctOptionId: '' }); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  // Question actions
  async function saveQuestion(id: number) {
    const f = editForms[`q:${id}`] || {};
    const body: any = {};
    if (f.stem !== undefined) body.stem = f.stem;
    if (f.qrId !== undefined) body.qrId = parseInt(f.qrId);
    if (f.optionsText !== undefined) body.options = optionsFromText(f.optionsText);
    if (f.correctOptionId !== undefined) body.correctOptionId = f.correctOptionId;
    const data = await callApi(`/api/admin/questions/${id}`, 'PATCH', body);
    if (data.ok) { showMsg('ok', 'Question updated'); setEditQuestion(null); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function deleteQuestion(id: number) {
    if (!confirm('Delete this question?')) return;
    const data = await callApi(`/api/admin/questions/${id}`, 'DELETE');
    if (data.ok) { showMsg('ok', 'Question deleted'); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function createQuestion() {
    const opts = optionsFromText(newQuestion.optionsText);
    const data = await callApi('/api/admin/questions', 'POST', {
      run: parseInt(newQuestion.run),
      slot: parseInt(newQuestion.slot),
      variant: parseInt(newQuestion.variant),
      qrId: parseInt(newQuestion.qrId),
      stem: newQuestion.stem,
      options: opts,
      correctOptionId: newQuestion.correctOptionId,
    });
    if (data.ok) { showMsg('ok', 'Question created'); setShowNewQuestion(false); setNewQuestion({ run: '1', slot: '1', variant: '1', qrId: '', stem: '', optionsText: '', correctOptionId: '' }); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  // Teaser actions
  async function saveTeaser(id: number) {
    const f = editForms[`t:${id}`] || {};
    const body: any = {};
    if (f.piecesText !== undefined) body.pieces = f.piecesText.split('\n').map((s: string) => s.trim()).filter(Boolean);
    if (f.answerNorm !== undefined) body.answerNorm = f.answerNorm;
    const data = await callApi(`/api/admin/teasers/${id}`, 'PATCH', body);
    if (data.ok) { showMsg('ok', 'Teaser updated'); setEditTeaser(null); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function deleteTeaser(id: number) {
    if (!confirm('Delete this teaser?')) return;
    const data = await callApi(`/api/admin/teasers/${id}`, 'DELETE');
    if (data.ok) { showMsg('ok', 'Teaser deleted'); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function createTeaser() {
    const pieces = newTeaser.piecesText.split('\n').map((s) => s.trim()).filter(Boolean);
    const data = await callApi('/api/admin/teasers', 'POST', {
      run: parseInt(newTeaser.run),
      size: parseInt(newTeaser.size),
      pieces,
      answerNorm: newTeaser.answerNorm,
    });
    if (data.ok) { showMsg('ok', 'Teaser created'); setShowNewTeaser(false); setNewTeaser({ run: '1', size: '3', piecesText: '', answerNorm: '' }); await fetchAll(); }
    else showMsg('err', data.message || data.code);
  }

  async function saveR3() {
    const data = await callApi('/api/admin/round3', 'PUT', r3);
    if (data.ok) showMsg('ok', 'Round 3 config saved');
    else showMsg('err', data.message || data.code);
  }

  function ef(key: string, field: string, val: any) {
    setEditForms((p) => ({ ...p, [key]: { ...(p[key] || {}), [field]: val } }));
  }

  const inputClass = 'w-full px-2.5 py-1.5 text-xs rounded bg-slate-900 text-slate-100 border border-slate-700 focus:outline-none focus:border-accent';
  const labelClass = 'block text-[10px] font-semibold uppercase text-slate-400 mb-1';
  const BtnSave = ({ onClick, disabled }: any) => (
    <button onClick={onClick} disabled={disabled} className="px-3 py-1 text-xs font-bold rounded bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-40">Save</button>
  );
  const BtnCancel = ({ onClick }: any) => (
    <button onClick={onClick} className="px-3 py-1 text-xs font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-300">Cancel</button>
  );

  const tabs: { key: Tab; label: string }[] = [
    { key: 'riddles', label: 'Riddles' },
    { key: 'questions', label: 'Questions' },
    { key: 'teasers', label: 'Teasers' },
    { key: 'round3', label: 'Round 3' },
  ];

  // Group questions by run/slot
  const questionsByRunSlot: Record<string, Question[]> = {};
  for (const q of questions) {
    const k = `R${q.run} Slot ${q.slot}`;
    if (!questionsByRunSlot[k]) questionsByRunSlot[k] = [];
    questionsByRunSlot[k].push(q);
  }

  return (
    <div className="w-full max-w-5xl mx-auto py-6 px-4">
      <div className="pb-4 border-b border-slate-700">
        <div>
          <span className="px-2 py-0.5 text-xs font-semibold uppercase bg-accent/20 text-accent rounded">HQ</span>
          <h1 className="text-xl font-bold text-slate-100 mt-1">Content Management</h1>
        </div>
        <HQNav />
      </div>

      {msg && (
        <div className={`mt-3 p-2.5 rounded text-xs border ${msg.type === 'ok' ? 'bg-emerald-950/60 border-emerald-700 text-emerald-300' : 'bg-red-950/60 border-red-800 text-red-200'}`}>
          {msg.text}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mt-4 border-b border-slate-700 pb-0">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-xs font-bold rounded-t border-b-2 transition-colors ${tab === t.key ? 'border-accent text-accent bg-slate-800/80' : 'border-transparent text-slate-400 hover:text-slate-200 bg-transparent'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="mt-8 text-center text-xs text-slate-400">Loading content...</p>
      ) : (
        <div className="mt-4">
          {/* ─── RIDDLES ─── */}
          {tab === 'riddles' && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setShowNewRiddle((s) => !s)} className="px-3 py-1.5 text-xs font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600">
                  {showNewRiddle ? '✕ Cancel' : '+ Add Riddle'}
                </button>
              </div>

              {showNewRiddle && (
                <div className="p-4 rounded-xl bg-slate-800/80 border border-accent/40">
                  <h3 className="text-xs font-bold text-accent uppercase mb-3">New Riddle</h3>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className={labelClass}>Position</label>
                      <input className={inputClass} type="number" value={newRiddle.position} onChange={(e) => setNewRiddle((p) => ({ ...p, position: e.target.value }))} />
                    </div>
                    <div>
                      <label className={labelClass}>Correct Option ID</label>
                      <input className={inputClass} value={newRiddle.correctOptionId} onChange={(e) => setNewRiddle((p) => ({ ...p, correctOptionId: e.target.value }))} placeholder="e.g. a" />
                    </div>
                  </div>
                  <div className="mb-3">
                    <label className={labelClass}>Question Text</label>
                    <textarea className={`${inputClass} h-20 resize-none`} value={newRiddle.text} onChange={(e) => setNewRiddle((p) => ({ ...p, text: e.target.value }))} />
                  </div>
                  <div className="mb-3">
                    <label className={labelClass}>Options (one per line: &quot;a: Option text&quot;)</label>
                    <textarea className={`${inputClass} h-28 resize-none font-mono`} value={newRiddle.optionsText} onChange={(e) => setNewRiddle((p) => ({ ...p, optionsText: e.target.value }))} placeholder={'a: First option\nb: Second option\nc: Third option'} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={createRiddle} className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-700 hover:bg-emerald-600 text-white">Create Riddle</button>
                    <button onClick={() => setShowNewRiddle(false)} className="px-3 py-1.5 text-xs font-bold rounded bg-slate-700 text-slate-300">Cancel</button>
                  </div>
                </div>
              )}

              {riddles.map((r) => (
                <div key={r.id} className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div>
                      <span className="text-[10px] text-slate-400 uppercase font-bold">#{r.position} · ID {r.id}</span>
                      {r.hasAttempts && <span className="ml-2 px-1.5 py-0.5 text-[9px] uppercase font-bold rounded bg-amber-500/20 text-amber-400">Options Locked</span>}
                    </div>
                    <div className="flex gap-1.5">
                      {editRiddle !== r.id && (
                        <>
                          <button onClick={() => { setEditRiddle(r.id); setEditForms((p) => ({ ...p, [`r:${r.id}`]: { text: r.text, position: r.position, optionsText: optionsToText(r.options), correctOptionId: r.correctOptionId } })); }}
                            className="px-2 py-1 text-[10px] rounded bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600">Edit</button>
                          {!r.hasAttempts && (
                            <button onClick={() => deleteRiddle(r.id)} className="px-2 py-1 text-[10px] rounded bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800">Delete</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {editRiddle !== r.id ? (
                    <p className="text-xs text-slate-300">{r.text}</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={labelClass}>Position</label>
                          <input className={inputClass} type="number" value={editForms[`r:${r.id}`]?.position ?? r.position}
                            onChange={(e) => ef(`r:${r.id}`, 'position', e.target.value)} />
                        </div>
                        <div>
                          <label className={labelClass}>Correct Option ID{r.hasAttempts && ' (locked)'}</label>
                          <input className={inputClass} value={editForms[`r:${r.id}`]?.correctOptionId ?? r.correctOptionId}
                            onChange={(e) => ef(`r:${r.id}`, 'correctOptionId', e.target.value)}
                            disabled={r.hasAttempts} />
                        </div>
                      </div>
                      <div>
                        <label className={labelClass}>Question Text</label>
                        <textarea className={`${inputClass} h-20 resize-none`} value={editForms[`r:${r.id}`]?.text ?? r.text}
                          onChange={(e) => ef(`r:${r.id}`, 'text', e.target.value)} />
                      </div>
                      {!r.hasAttempts && (
                        <div>
                          <label className={labelClass}>Options (a: text)</label>
                          <textarea className={`${inputClass} h-28 resize-none font-mono`}
                            value={editForms[`r:${r.id}`]?.optionsText ?? optionsToText(r.options)}
                            onChange={(e) => ef(`r:${r.id}`, 'optionsText', e.target.value)} />
                        </div>
                      )}
                      <div className="flex gap-2">
                        <BtnSave onClick={() => saveRiddle(r.id)} />
                        <BtnCancel onClick={() => setEditRiddle(null)} />
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {riddles.length === 0 && !showNewRiddle && (
                <p className="text-center text-xs text-slate-400 py-8">No riddles yet.</p>
              )}
            </div>
          )}

          {/* ─── QUESTIONS ─── */}
          {tab === 'questions' && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setShowNewQuestion((s) => !s)} className="px-3 py-1.5 text-xs font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600">
                  {showNewQuestion ? '✕ Cancel' : '+ Add Question'}
                </button>
              </div>

              {showNewQuestion && (
                <div className="p-4 rounded-xl bg-slate-800/80 border border-accent/40">
                  <h3 className="text-xs font-bold text-accent uppercase mb-3">New Question</h3>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div>
                      <label className={labelClass}>Run</label>
                      <select className={inputClass} value={newQuestion.run} onChange={(e) => setNewQuestion((p) => ({ ...p, run: e.target.value }))}>
                        <option value="1">Run 1</option><option value="2">Run 2</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>Slot (1-5)</label>
                      <input className={inputClass} type="number" min={1} max={5} value={newQuestion.slot} onChange={(e) => setNewQuestion((p) => ({ ...p, slot: e.target.value }))} />
                    </div>
                    <div>
                      <label className={labelClass}>Variant</label>
                      <input className={inputClass} type="number" min={1} value={newQuestion.variant} onChange={(e) => setNewQuestion((p) => ({ ...p, variant: e.target.value }))} />
                    </div>
                    <div>
                      <label className={labelClass}>QR Location</label>
                      <select className={inputClass} value={newQuestion.qrId} onChange={(e) => setNewQuestion((p) => ({ ...p, qrId: e.target.value }))}>
                        <option value="">Select QR...</option>
                        {qrs.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>Correct Option ID</label>
                      <input className={inputClass} value={newQuestion.correctOptionId} onChange={(e) => setNewQuestion((p) => ({ ...p, correctOptionId: e.target.value }))} placeholder="e.g. a" />
                    </div>
                  </div>
                  <div className="mb-3">
                    <label className={labelClass}>Stem (Question Text)</label>
                    <textarea className={`${inputClass} h-20 resize-none`} value={newQuestion.stem} onChange={(e) => setNewQuestion((p) => ({ ...p, stem: e.target.value }))} />
                  </div>
                  <div className="mb-3">
                    <label className={labelClass}>Options (a: text)</label>
                    <textarea className={`${inputClass} h-28 resize-none font-mono`} value={newQuestion.optionsText} onChange={(e) => setNewQuestion((p) => ({ ...p, optionsText: e.target.value }))} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={createQuestion} className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-700 hover:bg-emerald-600 text-white">Create Question</button>
                    <button onClick={() => setShowNewQuestion(false)} className="px-3 py-1.5 text-xs font-bold rounded bg-slate-700 text-slate-300">Cancel</button>
                  </div>
                </div>
              )}

              {Object.entries(questionsByRunSlot).map(([group, qs]) => (
                <div key={group} className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
                  <h3 className="text-xs font-bold text-slate-300 uppercase mb-3">{group}</h3>
                  <div className="space-y-3">
                    {qs.map((q) => (
                      <div key={q.id} className="p-3 rounded-lg bg-slate-900/60 border border-slate-700/80">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <div>
                            <span className="text-[10px] text-slate-400">ID {q.id} · v{q.variant} · {q.qrName}</span>
                            {q.hasAttempts && <span className="ml-2 px-1.5 py-0.5 text-[9px] uppercase font-bold rounded bg-amber-500/20 text-amber-400">Options Locked</span>}
                          </div>
                          <div className="flex gap-1.5">
                            {editQuestion !== q.id ? (
                              <>
                                <button onClick={() => { setEditQuestion(q.id); setEditForms((p) => ({ ...p, [`q:${q.id}`]: { stem: q.stem, qrId: String(q.qrId), optionsText: optionsToText(q.options), correctOptionId: q.correctOptionId } })); }}
                                  className="px-2 py-1 text-[10px] rounded bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600">Edit</button>
                                {!q.hasAttempts && (
                                  <button onClick={() => deleteQuestion(q.id)} className="px-2 py-1 text-[10px] rounded bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800">Delete</button>
                                )}
                              </>
                            ) : null}
                          </div>
                        </div>
                        {editQuestion !== q.id ? (
                          <p className="text-xs text-slate-300">{q.stem}</p>
                        ) : (
                          <div className="space-y-2 mt-2">
                            <div>
                              <label className={labelClass}>Stem</label>
                              <textarea className={`${inputClass} h-16 resize-none`} value={editForms[`q:${q.id}`]?.stem ?? q.stem}
                                onChange={(e) => ef(`q:${q.id}`, 'stem', e.target.value)} />
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className={labelClass}>QR Location</label>
                                <select className={inputClass} value={editForms[`q:${q.id}`]?.qrId ?? String(q.qrId)}
                                  onChange={(e) => ef(`q:${q.id}`, 'qrId', e.target.value)}>
                                  {qrs.map((qr) => <option key={qr.id} value={qr.id}>{qr.name}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className={labelClass}>Correct Option ID{q.hasAttempts && ' (locked)'}</label>
                                <input className={inputClass} value={editForms[`q:${q.id}`]?.correctOptionId ?? q.correctOptionId}
                                  onChange={(e) => ef(`q:${q.id}`, 'correctOptionId', e.target.value)} disabled={q.hasAttempts} />
                              </div>
                            </div>
                            {!q.hasAttempts && (
                              <div>
                                <label className={labelClass}>Options (a: text)</label>
                                <textarea className={`${inputClass} h-28 resize-none font-mono`}
                                  value={editForms[`q:${q.id}`]?.optionsText ?? optionsToText(q.options)}
                                  onChange={(e) => ef(`q:${q.id}`, 'optionsText', e.target.value)} />
                              </div>
                            )}
                            <div className="flex gap-2">
                              <BtnSave onClick={() => saveQuestion(q.id)} />
                              <BtnCancel onClick={() => setEditQuestion(null)} />
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              {questions.length === 0 && !showNewQuestion && (
                <p className="text-center text-xs text-slate-400 py-8">No questions yet.</p>
              )}
            </div>
          )}

          {/* ─── TEASERS ─── */}
          {tab === 'teasers' && (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button onClick={() => setShowNewTeaser((s) => !s)} className="px-3 py-1.5 text-xs font-bold rounded bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600">
                  {showNewTeaser ? '✕ Cancel' : '+ Add Teaser'}
                </button>
              </div>

              {showNewTeaser && (
                <div className="p-4 rounded-xl bg-slate-800/80 border border-accent/40">
                  <h3 className="text-xs font-bold text-accent uppercase mb-3">New Teaser</h3>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    <div>
                      <label className={labelClass}>Run</label>
                      <select className={inputClass} value={newTeaser.run} onChange={(e) => setNewTeaser((p) => ({ ...p, run: e.target.value }))}>
                        <option value="1">Run 1</option><option value="2">Run 2</option>
                      </select>
                    </div>
                    <div>
                      <label className={labelClass}>Size (team N: 3-5)</label>
                      <select className={inputClass} value={newTeaser.size} onChange={(e) => setNewTeaser((p) => ({ ...p, size: e.target.value }))}>
                        <option value="3">3</option><option value="4">4</option><option value="5">5</option>
                      </select>
                    </div>
                  </div>
                  <div className="mb-3">
                    <label className={labelClass}>Pieces (one per line, exactly {newTeaser.size} pieces)</label>
                    <textarea className={`${inputClass} h-24 resize-none`} value={newTeaser.piecesText} onChange={(e) => setNewTeaser((p) => ({ ...p, piecesText: e.target.value }))} />
                  </div>
                  <div className="mb-3">
                    <label className={labelClass}>Answer (normalized)</label>
                    <input className={inputClass} value={newTeaser.answerNorm} onChange={(e) => setNewTeaser((p) => ({ ...p, answerNorm: e.target.value }))} />
                  </div>
                  <div className="flex gap-2">
                    <button onClick={createTeaser} className="px-3 py-1.5 text-xs font-bold rounded bg-emerald-700 hover:bg-emerald-600 text-white">Create Teaser</button>
                    <button onClick={() => setShowNewTeaser(false)} className="px-3 py-1.5 text-xs font-bold rounded bg-slate-700 text-slate-300">Cancel</button>
                  </div>
                </div>
              )}

              {teasers.map((t) => (
                <div key={t.id} className="p-4 rounded-xl bg-slate-800/80 border border-slate-700">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-300">Run {t.run} · Size {t.size} <span className="text-slate-500 font-normal">(ID {t.id})</span></span>
                    <div className="flex gap-1.5">
                      {editTeaser !== t.id ? (
                        <>
                          <button onClick={() => { setEditTeaser(t.id); setEditForms((p) => ({ ...p, [`t:${t.id}`]: { piecesText: t.pieces.join('\n'), answerNorm: t.answerNorm } })); }}
                            className="px-2 py-1 text-[10px] rounded bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600">Edit</button>
                          <button onClick={() => deleteTeaser(t.id)} className="px-2 py-1 text-[10px] rounded bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800">Delete</button>
                        </>
                      ) : null}
                    </div>
                  </div>
                  {editTeaser !== t.id ? (
                    <div className="space-y-1">
                      {t.pieces.map((piece, i) => (
                        <div key={i} className="text-xs text-slate-400"><span className="text-slate-500">#{i + 1}</span> {piece}</div>
                      ))}
                      <div className="mt-2 text-xs text-amber-400 font-mono">Answer: {t.answerNorm}</div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div>
                        <label className={labelClass}>Pieces ({t.size} lines)</label>
                        <textarea className={`${inputClass} h-24 resize-none`}
                          value={editForms[`t:${t.id}`]?.piecesText ?? t.pieces.join('\n')}
                          onChange={(e) => ef(`t:${t.id}`, 'piecesText', e.target.value)} />
                      </div>
                      <div>
                        <label className={labelClass}>Answer (normalized)</label>
                        <input className={inputClass} value={editForms[`t:${t.id}`]?.answerNorm ?? t.answerNorm}
                          onChange={(e) => ef(`t:${t.id}`, 'answerNorm', e.target.value)} />
                      </div>
                      <div className="flex gap-2">
                        <BtnSave onClick={() => saveTeaser(t.id)} />
                        <BtnCancel onClick={() => setEditTeaser(null)} />
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {teasers.length === 0 && !showNewTeaser && (
                <p className="text-center text-xs text-slate-400 py-8">No teasers yet.</p>
              )}
            </div>
          )}

          {/* ─── ROUND 3 ─── */}
          {tab === 'round3' && (
            <div className="p-5 rounded-xl bg-slate-800/80 border border-slate-700">
              <h2 className="text-sm font-semibold text-slate-200 uppercase mb-4">Round 3 Configuration</h2>
              <div className="space-y-3">
                <div>
                  <label className={labelClass}>Enciphered Clue Text</label>
                  <textarea className={`${inputClass} h-24 resize-none`} value={r3.clueText} onChange={(e) => setR3((p) => ({ ...p, clueText: e.target.value }))} placeholder="The clue players will see (can be ciphered text)" />
                </div>
                <div>
                  <label className={labelClass}>Password (will be normalized: lowercase, trimmed)</label>
                  <input className={inputClass} value={r3.passwordNorm} onChange={(e) => setR3((p) => ({ ...p, passwordNorm: e.target.value }))} placeholder="The correct password teams must enter" />
                </div>
                <div>
                  <label className={labelClass}>Key Info (shown to winner only)</label>
                  <input className={inputClass} value={r3.keyInfo} onChange={(e) => setR3((p) => ({ ...p, keyInfo: e.target.value }))} placeholder="Decryption key or extra info for the winning team" />
                </div>
                <div>
                  <label className={labelClass}>Room (shown to winner only)</label>
                  <input className={inputClass} value={r3.room} onChange={(e) => setR3((p) => ({ ...p, room: e.target.value }))} placeholder="The room number / location" />
                </div>
                <button onClick={saveR3} className="w-full py-2.5 text-xs font-bold rounded bg-accent hover:bg-amber-400 text-slate-950 transition-colors">
                  Save Round 3 Config
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
