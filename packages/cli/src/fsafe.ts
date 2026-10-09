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

/**
 * Make this tool's own data folder (~/.llm-usage) readable by its owner only, even when it already exists with
 * looser rights. Only for a folder this tool owns: never call it on a folder the user chose.
 */
export function ensurePrivateFolder(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Not ours to change (another owner, or a system that has no such rights): the files inside are private anyway
  }
}

/** Append a line to a private file, and refuse to follow a link someone planted in its place. */
export function appendPrivateLine(file: string, line: string): void {
  ensurePrivateFolder(path.dirname(file));
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    // A file made by an older version may be open to others. This one is ours, so it is made private.
    try { fs.fchmodSync(fd, 0o600); } catch { /* nothing more to do */ }
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
