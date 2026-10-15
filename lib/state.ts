import {
  mapCaptainBoardQuestionDTO,
  mapPlayerMe,
  questionStatus,
  type CaptainBoardQuestionDTO,
  type MemberQuestionDTO,
  type ScreenType,
  type StateDTO,
} from './dto';

// Raw shape returned by the Postgres function player_state(). It never contains
// correct answers, points, other teams' data or Round 3 content.
export interface RawPlayerState {
  ok: boolean;
  code?: string;
  serverNowMs: number;
  eventNowMs: number;
  paused: boolean;
  phase: 'setup' | 'r1_running' | 'r1_closed' | 'r2_running' | 'r2_break' | 'r3_open' | 'ended';
  triesR2: number;
  student: { id: string; name: string; isCaptain: boolean };
  team: { id: string; name: string; n: number; qualified: boolean; withdrawn: boolean; r3Eligible: boolean };
  run: { run: number; deadlineMs: number; finished: boolean; expired: boolean; teaserDone: boolean } | null;
  registeredByMe: boolean;
  piecesAssigned: number;
  piecesHeld: Array<{ pieceNo: number; text: string | null }>;
  mine: Array<{
    questionNo: number;
    stem: string;
    locationName: string;
    voided: boolean;
    attempts: Array<{ try_no: number; correct: boolean }>;
  }>;
  board: Array<{
    question_no: number;
    id: number;
    options: Array<{ id: string; text: string }>;
    voided: boolean;
    attempts: Array<{ try_no: number; correct: boolean }>;
  }>;
}

/**
 * Turns the raw database snapshot into the player-facing State of Section 8.1.
 * Round 1 and Round 3 payloads arrive in later phases; their screens are chosen here already.
 */
export function buildState(raw: RawPlayerState): StateDTO {
  const me = mapPlayerMe(
    { id: raw.student.id, name: raw.student.name, is_captain: raw.student.isCaptain },
    { id: raw.team.id, name: raw.team.name, n: raw.team.n }
  );
  const clock = { serverNowMs: raw.serverNowMs, eventNowMs: raw.eventNowMs, paused: raw.paused };
  const base = { clock, me };
  const inR2 = raw.team.qualified && !raw.team.withdrawn;

  let screen: ScreenType;
  switch (raw.phase) {
    case 'setup':
      return { ...base, screen: 'WAIT_R1' };
    case 'r1_running':
      return { ...base, screen: 'R1', canSubmit: me.isCaptain, riddles: [] };
    case 'r1_closed':
      return { ...base, screen: 'R1_DONE' };
    case 'r2_break':
      return { ...base, screen: inR2 ? 'R2_BREAK' : 'R2_SPECTATOR', message: inR2 ? undefined : 'Round 2 is for qualified teams. You can watch the fun.' };
    case 'r3_open':
      screen = raw.team.r3Eligible ? 'R3' : 'R3_SPECTATOR';
      return { ...base, screen, message: raw.team.r3Eligible ? undefined : 'You are not among the top 5 teams.' };
    case 'ended':
      return { ...base, screen: 'ENDED' };
    case 'r2_running':
      break;
  }

  if (!inR2) {
    return { ...base, screen: 'R2_SPECTATOR', message: 'Round 2 is for qualified teams. You can watch the fun.' };
  }
  const run = raw.run;
  if (!run || run.finished || run.expired) {
    return { ...base, screen: 'R2_DONE', message: 'Your run is over. Wait for the next step.' };
  }

  const common = { ...base, run: run.run, deadlineEventMs: run.deadlineMs };

  if (!run.teaserDone && !raw.registeredByMe) {
    return {
      ...common,
      screen: 'R2_SCAN',
      message: run.run === 2 ? 'Run 2 is open. Scan any QR.' : undefined,
    };
  }

  if (!run.teaserDone) {
    return {
      ...common,
      screen: 'R2_TEASER',
      piecesHeld: raw.piecesHeld.map((p) => ({ pieceNo: p.pieceNo, text: p.text ?? '' })),
      registered: raw.piecesAssigned,
      total: raw.team.n,
      canAnswer: me.isCaptain && raw.piecesAssigned >= raw.team.n,
    };
  }

  const mine: MemberQuestionDTO[] = raw.mine.map((q) => ({
    questionNo: q.questionNo,
    stem: q.stem,
    locationName: q.locationName,
    status: questionStatus(q.voided, q.attempts, raw.triesR2),
  }));
  const board: CaptainBoardQuestionDTO[] | undefined = me.isCaptain
    ? raw.board.map((q) => mapCaptainBoardQuestionDTO(q, raw.team.id, q.attempts, raw.triesR2))
    : undefined;

  return { ...common, screen: 'R2_QUESTIONS', mine, board };
}
