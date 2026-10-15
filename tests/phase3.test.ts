import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../lib/messages';

// Pure rule-logic tests that mirror the Section 6.1 database checks.
// We test the logic as standalone predicates so they run without a real DB.

// ---------- helpers ----------
function studentReg(
  registrations: { student_id: string; qr_id: number; run: number }[],
  studentId: string,
  run: number
) {
  return registrations.find((r) => r.student_id === studentId && r.run === run) ?? null;
}

function teamAtQr(
  registrations: { team_id: string; qr_id: number; run: number }[],
  teamId: string,
  qrId: number,
  run: number
) {
  return registrations.find(
    (r) => r.team_id === teamId && r.qr_id === qrId && r.run === run
  ) ?? null;
}

function studentUsedQrBefore(
  registrations: { student_id: string; qr_id: number }[],
  studentId: string,
  qrId: number
) {
  return registrations.some((r) => r.student_id === studentId && r.qr_id === qrId);
}

function teamPieceCount(
  pieces: { team_id: string; run: number }[],
  teamId: string,
  run: number
) {
  return pieces.filter((p) => p.team_id === teamId && p.run === run).length;
}

function qrRegistrationCount(
  registrations: { qr_id: number; run: number }[],
  qrId: number,
  run: number
) {
  return registrations.filter((r) => r.qr_id === qrId && r.run === run).length;
}

// Smallest free integer from 1 to max, not in occupied set
function smallestFree(occupied: number[], max: number): number | null {
  for (let i = 1; i <= max; i++) {
    if (!occupied.includes(i)) return i;
  }
  return null;
}

// ---------- tests ----------

describe('Phase 3: Registration Rules (Section 6.1)', () => {
  const TEAM_ID = 'T01';
  const STUDENT_ID = 'S0101';
  const QR_ID = 1;
  const RUN = 1;
  const CAPACITY = 2;
  const N = 3; // team size

  it('returns ALREADY_REGISTERED when student already has a different QR this run', () => {
    const regs = [{ student_id: STUDENT_ID, qr_id: 99, run: RUN, team_id: TEAM_ID }];
    const existing = studentReg(regs, STUDENT_ID, RUN);
    expect(existing).not.toBeNull();
    // student has a registration at qr_id=99, requesting qr_id=1 → different QR
    expect(existing!.qr_id).not.toBe(QR_ID);
    expect(getErrorMessage('ALREADY_REGISTERED')).toBe('You are already registered for this run.');
  });

  it('returns already=true idempotently when student re-scans same QR', () => {
    const regs = [{ student_id: STUDENT_ID, qr_id: QR_ID, run: RUN, team_id: TEAM_ID }];
    const existing = studentReg(regs, STUDENT_ID, RUN);
    expect(existing).not.toBeNull();
    // same QR → idempotent success
    expect(existing!.qr_id).toBe(QR_ID);
  });

  it('returns TEAMMATE_HERE when a different teammate is at the QR this run', () => {
    const regs = [{ student_id: 'S0102', qr_id: QR_ID, run: RUN, team_id: TEAM_ID }];
    const found = teamAtQr(regs, TEAM_ID, QR_ID, RUN);
    expect(found).not.toBeNull();
    expect(getErrorMessage('TEAMMATE_HERE')).toContain('teammate');
  });

  it('returns QR_USED_BEFORE when student used this QR in a prior run', () => {
    // Student registered at QR_ID in run 1, now trying run 2
    const regs = [{ student_id: STUDENT_ID, qr_id: QR_ID }];
    const usedBefore = studentUsedQrBefore(regs, STUDENT_ID, QR_ID);
    expect(usedBefore).toBe(true);
    expect(getErrorMessage('QR_USED_BEFORE')).toContain('before');
  });

  it('returns TEAM_COMPLETE when team already has N piece assignments', () => {
    const pieces = [
      { team_id: TEAM_ID, run: RUN },
      { team_id: TEAM_ID, run: RUN },
      { team_id: TEAM_ID, run: RUN },
    ];
    expect(teamPieceCount(pieces, TEAM_ID, RUN)).toBe(N);
    expect(getErrorMessage('TEAM_COMPLETE')).toContain('complete');
  });

  it('returns QR_FULL when registrations at capacity', () => {
    const regs = [
      { qr_id: QR_ID, run: RUN },
      { qr_id: QR_ID, run: RUN },
    ];
    expect(qrRegistrationCount(regs, QR_ID, RUN)).toBeGreaterThanOrEqual(CAPACITY);
    expect(getErrorMessage('QR_FULL')).toContain('full');
  });

  it('allocates smallest free slot_no correctly', () => {
    // slots 1 and 3 are taken, capacity 5 → slot 2 is next
    const taken = [1, 3];
    expect(smallestFree(taken, 5)).toBe(2);
    // all taken
    expect(smallestFree([1, 2, 3], 3)).toBeNull();
    // none taken
    expect(smallestFree([], 5)).toBe(1);
  });

  it('allocates smallest free piece_no correctly', () => {
    const taken = [1, 3]; // piece 2 is free
    expect(smallestFree(taken, N)).toBe(2);
    // all pieces taken
    expect(smallestFree([1, 2, 3], N)).toBeNull();
  });

  it('cancel registration frees both slot_no and piece_no', () => {
    // Simulate state before cancel
    let slots = [1, 2, 3];
    let pieces = [1, 2, 3];

    // Cancel slot 2 and piece 2
    slots = slots.filter((s) => s !== 2);
    pieces = pieces.filter((p) => p !== 2);

    expect(smallestFree(slots, 5)).toBe(2); // slot 2 is now free
    expect(smallestFree(pieces, N)).toBe(2); // piece 2 is now free
  });

  it('QR_USED_BEFORE works across both runs (Section 6.1 rule 7)', () => {
    // Student used QR in run 1
    const regsRun1 = [{ student_id: STUDENT_ID, qr_id: QR_ID }];
    // Now trying same QR in run 2
    expect(studentUsedQrBefore(regsRun1, STUDENT_ID, QR_ID)).toBe(true);

    // Different QR in run 2 is fine
    expect(studentUsedQrBefore(regsRun1, STUDENT_ID, 99)).toBe(false);
  });

  it('TEAM_COMPLETE does not trigger until exactly N pieces assigned', () => {
    for (let i = 1; i <= N; i++) {
      const pieces = Array.from({ length: i }, () => ({ team_id: TEAM_ID, run: RUN }));
      const count = teamPieceCount(pieces, TEAM_ID, RUN);
      if (i < N) expect(count < N).toBe(true);
      else expect(count >= N).toBe(true);
    }
  });
});

describe('Phase 3: Error message codes', () => {
  const expectedMessages: Record<string, string> = {
    INVALID_QR: 'This QR code is not valid.',
    QR_INACTIVE: 'This location is closed. Find another location.',
    TEAMMATE_HERE: 'A teammate already registered here. Find another location.',
    QR_USED_BEFORE: 'You used this location before. Find another location.',
    QR_FULL: 'This location is full. Find another location.',
    ALREADY_REGISTERED: 'You are already registered for this run.',
    TEAM_COMPLETE: 'Your team is already complete.',
    NOT_IN_ROUND: 'Your team is not in this round.',
    ABSENT: 'You are marked absent. Ask an organiser.',
    WRONG_PHASE: 'That is not open right now.',
    PAUSED: 'The event is paused. Hang tight.',
  };

  for (const [code, expected] of Object.entries(expectedMessages)) {
    it(`getErrorMessage('${code}') returns correct player text`, () => {
      expect(getErrorMessage(code)).toBe(expected);
    });
  }
});
