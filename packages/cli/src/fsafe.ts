import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Remove control characters (terminal escape codes, line breaks) from text taken from a file before it is printed. */
export const plain = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

/**
 * Write a file that only the owner can read, all at once: a new temp file with a random name (a planted
 * file or link is never reused), then a rename over the target. Whatever was there before is replaced,
 * not written through.
 */
export function writePrivateFile(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    throw err;
  }
}

/** Append a line to a private file, and refuse to follow a link someone planted in its place. */
export function appendPrivateLine(file: string, line: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

/** True when the folder, or one above it, is a git repository. */
export function insideGitRepo(dir: string): boolean {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
