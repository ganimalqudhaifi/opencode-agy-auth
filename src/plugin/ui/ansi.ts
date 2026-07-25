export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',

  // Cursor & Screen
  clearScreen: '\x1b[2J',
  clearLine: '\x1b[2K\r',
  hide: '\x1b[?25l',
  show: '\x1b[?25h',

  up: (n = 1) => `\x1b[${n}A`,
  down: (n = 1) => `\x1b[${n}B`,
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`
};

export function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export type KeyAction = 'up' | 'down' | 'enter' | 'escape' | 'escape-start' | null;

export function parseKey(data: Buffer): KeyAction {
  const str = data.toString('utf-8');

  // Single keypresses
  if (str === '\r' || str === '\n') {
    return 'enter';
  }

  if (str === '\x1b') {
    return 'escape-start';
  }

  if (str === '\x1b\x1b' || str === '\x03') {
    return 'escape'; // Esc or Ctrl+C
  }

  // Arrow key escape sequences
  if (str === '\x1b[A' || str === '\x1bOA' || str === 'k' || str === 'K') {
    return 'up';
  }

  if (str === '\x1b[B' || str === '\x1bOB' || str === 'j' || str === 'J') {
    return 'down';
  }

  return null;
}
