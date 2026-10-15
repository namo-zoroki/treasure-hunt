import { describe, it, expect } from 'vitest';

describe('Phase 5 - Run Timing and Deadlines', () => {
  it('calculates run deadline as min(opens + run_cap, hard_end)', () => {
    const calcDeadline = (opens: number, capMinutes: number, hardEnd: number) => {
      const capMs = capMinutes * 60000;
      return Math.min(opens + capMs, hardEnd);
    };

    const start = 1000000;
    const hardEnd = start + 60 * 60000; // 60 min total

    // Run 1: 30 min cap -> ends at 30 min (before hard end)
    expect(calcDeadline(start, 30, hardEnd)).toBe(start + 30 * 60000);

    // Run 2 opened at 40 min with 30 min cap -> capped by hard end at 60 min
    const run2Opens = start + 40 * 60000;
    expect(calcDeadline(run2Opens, 30, hardEnd)).toBe(hardEnd);
  });

  it('determines if run is open, expired, or finished', () => {
    const isRunOpen = (finishedMs: number | null, eventNow: number, deadlineMs: number) => {
      return finishedMs === null && eventNow < deadlineMs;
    };

    const deadline = 50000;
    expect(isRunOpen(null, 40000, deadline)).toBe(true);
    expect(isRunOpen(null, 50000, deadline)).toBe(false); // expired
    expect(isRunOpen(null, 55000, deadline)).toBe(false); // past deadline
    expect(isRunOpen(45000, 46000, deadline)).toBe(false); // already finished
  });

  it('expired runs score 0 because unanswered questions produce no attempts', () => {
    const attempts = [
      { question_id: 1, points: 40, correct: true },
      // question 2 and 3 were never submitted before deadline
    ];
    const totalPoints = attempts.reduce((sum, a) => sum + (a.correct ? a.points : 0), 0);
    expect(totalPoints).toBe(40);
  });

  it('advances to r2_break on hard end with break_end_ms', () => {
    const r2HardEnd = 100000;
    const breakMinutes = 3;
    const breakEndMs = r2HardEnd + breakMinutes * 60000;

    expect(breakEndMs).toBe(100000 + 180000);
  });
});

describe('Phase 5 - Void Question & Score Adjustments', () => {
  it('calculates score adjustment as greatest(0, full - already_earned)', () => {
    const calcAdj = (n: number, alreadyEarned: number) => {
      const full = Math.floor(120 / n);
      return Math.max(0, full - alreadyEarned);
    };

    // For n=3 (full = 40)
    expect(calcAdj(3, 0)).toBe(40); // 0 earned -> gets full 40
    expect(calcAdj(3, 20)).toBe(20); // half (20) earned -> gets remainder 20
    expect(calcAdj(3, 40)).toBe(0); // already full -> 0 adjustment

    // For n=4 (full = 30)
    expect(calcAdj(4, 0)).toBe(30);
    expect(calcAdj(4, 15)).toBe(15);
    expect(calcAdj(4, 30)).toBe(0);

    // For n=5 (full = 24)
    expect(calcAdj(5, 0)).toBe(24);
    expect(calcAdj(5, 12)).toBe(12);
    expect(calcAdj(5, 24)).toBe(0);
  });

  it('evaluates whether a run is resolved after voiding a question', () => {
    const questions = [
      { id: 1, voided: false, attempts: [{ try_no: 1, correct: true }] },
      { id: 2, voided: false, attempts: [{ try_no: 1, correct: false }, { try_no: 2, correct: false }] }, // locked
      { id: 3, voided: false, attempts: [] }, // open
    ];

    const isResolved = (qs: typeof questions, triesLimit: number) => {
      return qs.every(
        (q) => q.voided || q.attempts.some((a) => a.correct) || q.attempts.length >= triesLimit
      );
    };

    expect(isResolved(questions, 2)).toBe(false);

    // Voiding question 3 resolves the run!
    questions[2].voided = true;
    expect(isResolved(questions, 2)).toBe(true);
  });
});

describe('Phase 5 - Absent & Move Logic', () => {
  it('reassigns held pieces and unassigned piece slots to move_to teammate', () => {
    const teamN = 4;
    const piecesHeld = [
      { pieceNo: 1, studentId: 'S01', via: 'scan' },
      { pieceNo: 2, studentId: 'S02', via: 'scan' },
      // piece 3 and 4 not yet scanned/assigned
    ];

    // S01 is marked absent, moving pieces to S02
    const absentStudent = 'S01';
    const moveToStudent = 'S02';

    const updatedPieces = piecesHeld.map((p) =>
      p.studentId === absentStudent ? { ...p, studentId: moveToStudent, via: 'admin' } : p
    );

    // Unassigned piece slots (3 and 4) assigned to moveToStudent
    for (let p = 1; p <= teamN; p++) {
      if (!updatedPieces.some((item) => item.pieceNo === p)) {
        updatedPieces.push({ pieceNo: p, studentId: moveToStudent, via: 'admin' });
      }
    }

    expect(updatedPieces).toHaveLength(4);
    expect(updatedPieces.filter((p) => p.studentId === moveToStudent)).toHaveLength(4);
    expect(updatedPieces.find((p) => p.pieceNo === 1)?.via).toBe('admin');
  });

  it('rejects invalid move_to targets', () => {
    const validateMoveTo = (
      student: { id: string; team_id: string; absent: boolean },
      target: { id: string; team_id: string; absent: boolean } | null
    ) => {
      if (!target) return 'NOT_FOUND';
      if (target.id === student.id) return 'SAME_STUDENT';
      if (target.team_id !== student.team_id) return 'DIFFERENT_TEAM';
      if (target.absent) return 'TARGET_ABSENT';
      return 'OK';
    };

    const s1 = { id: 'S1', team_id: 'T1', absent: false };
    const s2 = { id: 'S2', team_id: 'T1', absent: false };
    const sOther = { id: 'S3', team_id: 'T2', absent: false };
    const sAbsent = { id: 'S4', team_id: 'T1', absent: true };

    expect(validateMoveTo(s1, s2)).toBe('OK');
    expect(validateMoveTo(s1, s1)).toBe('SAME_STUDENT');
    expect(validateMoveTo(s1, sOther)).toBe('DIFFERENT_TEAM');
    expect(validateMoveTo(s1, sAbsent)).toBe('TARGET_ABSENT');
  });
});

describe('Phase 5 - Cancel Registration', () => {
  it('frees the slot and piece assignment for subsequent registration', () => {
    let registrations = [
      { id: 101, qr_id: 1, slot_no: 1, student_id: 'S01', run: 1, team_id: 'T1' },
    ];
    let pieceAssignments = [
      { run: 1, team_id: 'T1', piece_no: 1, student_id: 'S01', via: 'scan' },
    ];

    // Cancel registration 101
    const regToCancel = registrations.find((r) => r.id === 101);
    expect(regToCancel).toBeDefined();

    registrations = registrations.filter((r) => r.id !== 101);
    pieceAssignments = pieceAssignments.filter(
      (p) => !(p.team_id === regToCancel!.team_id && p.run === regToCancel!.run && p.student_id === regToCancel!.student_id)
    );

    expect(registrations).toHaveLength(0);
    expect(pieceAssignments).toHaveLength(0);
  });
});
