export const ERROR_MESSAGES: Record<string, string> = {
  INVALID_LOGIN: 'Student ID or code is wrong.',
  THROTTLED: 'Too many tries. Wait {s} seconds.',
  WRONG_PHASE: 'That is not open right now.',
  PAUSED: 'The event is paused. Hang tight.',
  NOT_IN_ROUND: 'Your team is not in this round.',
  ABSENT: 'You are marked absent. Ask an organiser.',
  INVALID_QR: 'This QR code is not valid.',
  QR_INACTIVE: 'This location is closed. Find another location.',
  TEAMMATE_HERE: 'A teammate already registered here. Find another location.',
  QR_USED_BEFORE: 'You used this location before. Find another location.',
  QR_FULL: 'This location is full. Find another location.',
  ALREADY_REGISTERED: 'You are already registered for this run.',
  TEAM_COMPLETE: 'Your team is already complete.',
  NOT_CAPTAIN: 'Only your captain can submit.',
  TEASER_NOT_READY: 'Wait until every teammate has registered.',
  TEASER_WRONG: 'Not quite. Keep talking to your team.',
  ALREADY_DONE: 'Already answered.',
  LOCKED: 'This question is locked.',
  INVALID_OPTION: 'Choose one of the options.',
  NOT_ELIGIBLE: 'Your team is not in this round.',
  WRONG_PASSWORD: 'That is not it.',
  ALREADY_CLAIMED: 'Another team got there first.',
  CONTENT_MISSING: 'Something is not set up. Tell an organiser.',
  UNAUTHORIZED: 'You must be logged in to access this.',
  DUPLICATE_REQUEST: 'Something went wrong. Reload and try again.',
  RPC_ERROR: 'Something is not set up. Tell an organiser.',
  SETTING_LOCKED: 'This setting is locked and cannot be edited.',
};

export const ANSWER_FEEDBACK: Record<string, string> = {
  correct: 'Correct.',
  wrong_one_left: 'Wrong. One try left.',
  locked: 'Wrong. Locked.',
  wrong: 'Wrong.',
};

export function getErrorMessage(code: string, params?: { s?: number | string }): string {
  let msg = ERROR_MESSAGES[code] || 'An unexpected error occurred.';
  if (params?.s !== undefined) {
    msg = msg.replace('{s}', String(params.s));
  }
  return msg;
}
