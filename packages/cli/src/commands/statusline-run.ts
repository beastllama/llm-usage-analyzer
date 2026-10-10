import { parseStatusLine, parseWindows, shouldRecord, recordSample, lastSample } from '../limits.js';

// Claude Code sends a few kilobytes. Anything past this is not a status-line message, so reading stops there.
const MAX_STDIN_CHARS = 256 * 1024;

/**
 * Read stdin until the JSON message is complete, it ends, or a short wait is over, so the status line never hangs.
 * Stops reading at a size limit, so a flood on stdin cannot fill memory.
 */
export function readStdin(timeoutMs = 1500): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_STDIN_CHARS) return finish();
      // A complete JSON object means there is nothing more to wait for, even when the sender keeps the pipe open
      if (data.trimEnd().endsWith('}')) {
        try {
          JSON.parse(data);
          finish();
        } catch { /* not complete yet */ }
      }
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const show = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value)}%`);

/**
 * Status line for Claude Code. Claude Code runs this on each update and sends JSON on stdin.
 * It prints your live 5-hour and weekly percentages and saves them for `llm-usage-analyzer limits`.
 * It must be quick, and it must never fail: whatever goes wrong, a line is printed and the exit code is 0.
 * (It lives apart from the other commands on purpose, so starting it loads almost nothing.)
 */
export async function runStatusline(): Promise<void> {
  let line = '5h — · 7d —';
  try {
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
    line = `5h ${show(five)} · 7d ${show(seven)}`;
  } catch {
    // The placeholder line is printed
  }
  // Leave only after the line is out: stdin may still be open, and would keep this process alive
  process.stdout.write(`${line}\n`, () => process.exit(0));
}
