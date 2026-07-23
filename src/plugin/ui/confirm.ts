import { ANSI, isTTY } from './ansi';

export async function confirm(message: string, defaultYes = false): Promise<boolean> {
  if (!isTTY()) {
    return defaultYes;
  }

  const promptStr = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  process.stdout.write(`${ANSI.cyan}│${ANSI.reset}  ${message}${ANSI.dim}${promptStr}${ANSI.reset}`);

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw ?? false;

    const cleanup = () => {
      try {
        stdin.removeListener('data', onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
      } catch {}
    };

    const onData = (data: Buffer) => {
      cleanup();
      const str = data.toString('utf-8').trim().toLowerCase();
      process.stdout.write('\n');

      if (str === 'y' || str === 'yes') {
        resolve(true);
      } else if (str === 'n' || str === 'no') {
        resolve(false);
      } else {
        resolve(defaultYes);
      }
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.once('data', onData);
    } catch {
      cleanup();
      resolve(defaultYes);
    }
  });
}
