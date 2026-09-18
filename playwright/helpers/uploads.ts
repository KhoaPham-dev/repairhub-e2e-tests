/**
 * Deterministic "did my upload leave a file behind" checks for the backend's
 * uploads directory, safe under parallel Playwright workers.
 *
 * The naive version of this check — snapshot `readdirSync(dir).length`
 * before and after a request, assert they're equal — is inherently racy:
 * many OTHER specs write to (and clean up from) the same shared uploads
 * directory concurrently, so the total file count fluctuates for reasons
 * that have nothing to do with the request under test. It was flaky under
 * `--workers` > 1 even though the backend's own cleanup is synchronous
 * (multer writes the file, then the route calls `fs.unlinkSync` before ever
 * sending the response) — the flakiness came entirely from counting a
 * directory other tests also touch, not from any real timing race.
 *
 * Instead of counting the whole directory, scope the check to what THIS
 * test's own request could plausibly have produced: record the time right
 * before sending the request (`watchUploads`), then after it resolves, look
 * for any file in the uploads dir with an mtime at/after that time whose
 * size — and, when given, content hash — matches one of the payload(s) this
 * test sent (`findSurvivingUploads`). A rejected request's file should
 * already be gone by the time the HTTP response comes back, so this should
 * always find zero matches; it does so without caring how many unrelated
 * files other concurrent tests are adding or removing at the same time.
 *
 * Callers should make sure the payload they're tracking is content-unique
 * (e.g. via `crypto.randomBytes` mixed into otherwise-fixed test data) if
 * there's any chance another test — in this spec or elsewhere — could
 * plausibly send byte-identical content around the same time (most visibly:
 * a shared fixture buffer that some OTHER test uploads successfully and
 * keeps permanently, which would otherwise look like a false "survivor").
 * See 23-video-uploads.spec.ts for examples.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// The backend's uploads dir, as a sibling repo checkout — same convention
// other specs use (REPAIRHUB_UPLOADS_DIR override, else assume a local dev
// checkout with repairhub-backend/uploads next to this repo).
export const UPLOADS_DIR = process.env.REPAIRHUB_UPLOADS_DIR
  ?? path.join(__dirname, '..', '..', '..', 'repairhub-backend', 'uploads');

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export interface UploadWatch {
  dir: string;
  /** Date.now() at the moment watchUploads() was called. */
  sinceMs: number;
}

/** Call this immediately before sending a request whose rejection must
 * leave no trace on disk. Pass the result to findSurvivingUploads() after
 * the request resolves. */
export function watchUploads(): UploadWatch {
  return { dir: UPLOADS_DIR, sinceMs: Date.now() };
}

export interface ExpectedUpload {
  /** Exact byte length of a payload this test sent. Combine with `sha256`
   * whenever the leftover (if any) would be the full, exact payload. */
  size?: number;
  /** Matches any file at least this large, instead of an exact size.
   * Needed when the leftover's exact final size can't be predicted — e.g.
   * multer aborts a write mid-stream as soon as its fileSize limit trips,
   * so a leftover from an oversized-upload rejection is a truncated,
   * non-deterministic size near that limit, not the full original payload
   * length. Pick a threshold comfortably above anything a legitimate small
   * test fixture could ever be. On its own this only rules out size — pair
   * it with `prefix` whenever more than one test could concurrently
   * produce a same-ballpark-size large file (e.g. two parallel runs of the
   * same oversize-rejection test), so a genuinely different test's
   * still-in-flight or not-yet-deleted file can't false-match. */
  minSize?: number;
  /** sha256 hex digest of the exact bytes sent. Only meaningful together
   * with `size` (an exact length to read back and hash). Strongly
   * recommended whenever `size` alone isn't distinctive enough to rule out
   * an unrelated file coincidentally having the same size — see the module
   * doc comment. */
  sha256?: string;
  /** The payload's own first N bytes. Multer writes a file sequentially
   * from the start, so even a write aborted mid-stream (see `minSize`)
   * still begins with exactly these bytes — matched by reading only the
   * candidate file's first `prefix.length` bytes, so it stays cheap
   * regardless of the file's total size. Make these bytes unique per test
   * *invocation* (e.g. `crypto.randomBytes(32)` as part of the payload)
   * when using this with `minSize`, so two concurrent runs of the same
   * test can't match each other's leftovers. */
  prefix?: Buffer;
}

// A little slack for filesystem mtime resolution / minor clock skew between
// this process and the backend's. This only WIDENS the candidate window —
// it can never hide a real leftover, since every candidate still has to
// match a payload's size/prefix (and hash, when given).
const MTIME_SLACK_MS = 2_000;

function readPrefix(filePath: string, length: number): Buffer | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, head, 0, length, 0);
      return bytesRead === length ? head : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function matchesExpected(full: string, stat: fs.Stats, e: ExpectedUpload): boolean {
  if (e.size !== undefined && stat.size !== e.size) return false;
  if (e.minSize !== undefined && stat.size < e.minSize) return false;
  if (e.size === undefined && e.minSize === undefined && !e.prefix) return false; // nothing to match on

  if (e.prefix) {
    if (stat.size < e.prefix.length) return false;
    const head = readPrefix(full, e.prefix.length);
    if (!head || !head.equals(e.prefix)) return false;
  }

  if (e.sha256) {
    let content: Buffer;
    try {
      content = fs.readFileSync(full);
    } catch {
      return false; // removed between stat() and readFileSync() — not a survivor
    }
    if (sha256Hex(content) !== e.sha256) return false;
  }

  return true;
}

/**
 * Returns the filenames still on disk in `watch.dir` that could be a
 * leftover from any of `expected`'s payloads: created at/after
 * `watch.sinceMs` (minus a small slack) and matching one of them (by exact
 * size, a minimum size, a byte prefix, and/or a content hash — see
 * ExpectedUpload). An empty array means nothing this test could have
 * produced survived.
 *
 * Returns [] without throwing if the uploads dir isn't reachable locally
 * (same fallback the older whole-directory-count check used) — callers
 * should skip the assertion in that case, same as before.
 */
export function findSurvivingUploads(watch: UploadWatch, expected: ExpectedUpload[]): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(watch.dir);
  } catch {
    return [];
  }

  const since = watch.sinceMs - MTIME_SLACK_MS;
  const survivors: string[] = [];

  for (const name of entries) {
    const full = path.join(watch.dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // removed between readdir() and stat() — not a survivor
    }
    if (stat.mtimeMs < since) continue;

    if (expected.some((e) => matchesExpected(full, stat, e))) {
      survivors.push(name);
    }
  }

  return survivors;
}
