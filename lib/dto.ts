import { seededShuffle } from './shuffle';

export type ScreenType =
  | 'WAIT_R1'
  | 'R1'
  | 'R1_DONE'
  | 'R2_SPECTATOR'
  | 'R2_SCAN'
  | 'R2_TEASER'
  | 'R2_QUESTIONS'
  | 'R2_DONE'
  | 'R2_BREAK'
  | 'R3'
  | 'R3_SPECTATOR'
  | 'ENDED';

export interface PlayerMeDTO {
  studentId: string;
  name: string;
  teamId: string;
  teamName: string;
  isCaptain: boolean;
  n: number;
}

export interface ClockDTO {
  serverNowMs: number;
  eventNowMs: number;
  paused: boolean;
}

export interface OptionDTO {
  id: string;
  text: string;
}

export interface RiddleDTO {
  id: number;
  position: number;
  text: string;
  options: OptionDTO[];
  status: 'open' | 'correct' | 'wrong';
}

export interface TeaserPieceDTO {
  pieceNo: number;
  text: string;
}

export interface MemberQuestionDTO {
  questionNo: number;
  stem: string;
  locationName: string;
}

export interface CaptainBoardQuestionDTO {
  questionNo: number;
  options: OptionDTO[];
  status: 'open' | 'one_try_left' | 'correct' | 'locked' | 'voided';
}

export interface StateDTO {
  clock: ClockDTO;
  me: PlayerMeDTO;
  screen: ScreenType;
  deadlineEventMs?: number;
  // Screen-specific payloads
  riddles?: RiddleDTO[];
  canSubmit?: boolean;
  run?: number;
  message?: string;
  piecesHeld?: TeaserPieceDTO[];
  registered?: number;
  total?: number;
  canAnswer?: boolean;
  mine?: MemberQuestionDTO[];
  board?: CaptainBoardQuestionDTO[];
  clue?: string;
  claimed?: boolean;
  keyInfo?: string;
  room?: string;
  winnerTeamId?: string;
}

/**
 * Mapper for player profile
 */
export function mapPlayerMe(
  student: { id: string; name: string; is_captain: boolean },
  team: { id: string; name: string; n: number }
): PlayerMeDTO {
  return {
    studentId: student.id,
    name: student.name,
    teamId: team.id,
    teamName: team.name,
    isCaptain: student.is_captain,
    n: team.n,
  };
}

/**
 * Safe mapper for Riddles (options shuffled deterministically, correct_option_id stripped)
 */
export function mapRiddleDTO(
  riddle: { id: number; position: number; text: string; options: OptionDTO[] },
  teamId: string,
  attempt?: { correct: boolean } | null
): RiddleDTO {
  const seed = `${teamId}:r1:${riddle.id}`;
  const shuffledOptions = seededShuffle(riddle.options, seed);

  let status: 'open' | 'correct' | 'wrong' = 'open';
  if (attempt) {
    status = attempt.correct ? 'correct' : 'wrong';
  }

  return {
    id: riddle.id,
    position: riddle.position,
    text: riddle.text,
    options: shuffledOptions,
    status,
  };
}

/**
 * Safe mapper for Captain Board (NO stems, only options shuffled deterministically and status)
 */
export function mapCaptainBoardQuestionDTO(
  question: { question_no: number; id: number; options: OptionDTO[]; voided: boolean },
  teamId: string,
  attempts: Array<{ try_no: number; correct: boolean }>
): CaptainBoardQuestionDTO {
  const seed = `${teamId}:r2:${question.id}`;
  const shuffledOptions = seededShuffle(question.options, seed);

  let status: 'open' | 'one_try_left' | 'correct' | 'locked' | 'voided' = 'open';
  if (question.voided) {
    status = 'voided';
  } else if (attempts.some((a) => a.correct)) {
    status = 'correct';
  } else if (attempts.length === 1) {
    status = 'one_try_left';
  } else if (attempts.length >= 2) {
    status = 'locked';
  }

  return {
    questionNo: question.question_no,
    options: shuffledOptions,
    status,
  };
}

/**
 * Safe mapper for Round 3 (only entitled team gets key & room, clue only for r3_eligible)
 */
export function mapRound3DTO(
  r3: { clue_text: string; key_info: string; room: string },
  eligible: boolean,
  claim: { team_id: string } | null,
  myTeamId: string
): { clue?: string; claimed: boolean; keyInfo?: string; room?: string; winnerTeamId?: string } {
  if (!eligible) {
    return { claimed: !!claim };
  }

  const isWinner = claim && claim.team_id === myTeamId;
  return {
    clue: r3.clue_text,
    claimed: !!claim,
    keyInfo: isWinner ? r3.key_info : undefined,
    room: isWinner ? r3.room : undefined,
    winnerTeamId: claim ? claim.team_id : undefined,
  };
}
