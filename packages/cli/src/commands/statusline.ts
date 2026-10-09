import { Command } from 'commander';
import { parseStatusLine, parseWindows, shouldRecord, recordSample, lastSample } from '../limits.js';

/** Read all of stdin, but give up after a short wait so the status line never hangs. */
function readStdin(timeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => {
      process.stdin.pause();
      resolve(data);
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { data += chunk; });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Status line for Claude Code. Claude Code runs this on each update and sends JSON on stdin.
 * It prints your live 5-hour and weekly percentages and saves them for `llm-usage-analyzer limits`.
 */
export const statuslineCommand = new Command('statusline')
  .description('Claude Code status-line command: shows live limit % and records it (Pro and Max)')
  .action(async () => {
    const raw = await readStdin();
    let input: unknown = null;
    try {
      input = JSON.parse(raw);
    } catch {
      // Not JSON, so there is nothing to show
    }

    const sample = parseStatusLine(input);
    if (sample) {
      try {
        if (shouldRecord(lastSample(), sample)) recordSample(sample);
      } catch {
        // Recording is best effort. Never break the status line over it.
      }
    }

    // Show whichever windows Claude Code sent. Either can be missing on its own.
    const { five, seven } = parseWindows(input);
    const show = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value)}%`);
    console.log(`5h ${show(five)} · 7d ${show(seven)}`);
  });
