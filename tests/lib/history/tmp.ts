import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';

// Temp-dir cleanup for the database suites. A file handle that was just closed can still be busy for a moment on
// some systems (Windows antivirus, slow disks): retry EBUSY / EPERM instead of failing the test.
export function removeTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// SQLite files on a slow or busy disk (CI) can take a while: the history suites allow more than the 5 s default
export const HISTORY_TEST_TIMEOUT_MS = 15_000;

export interface LockHolder {
  release(): Promise<void>;
}

const holders = new Set<ChildProcess>();

// Another process that holds a SQLite lock on a file until release(): the write lock (BEGIN IMMEDIATE), or a read
// lock (an open read transaction), which only blocks other connections from committing. It has to be another
// process: two SQLite libraries in one process (better-sqlite3 and sqlite3) don't see each other's file locks.
export async function holdLock(file: string, kind: 'write' | 'read'): Promise<LockHolder> {
  const script = `
    const db = new (require(process.argv[1]))(process.argv[2]);
    if (process.argv[3] === 'write') {
      db.exec('BEGIN IMMEDIATE');
    } else {
      db.exec('BEGIN');
      db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
    }
    process.stdout.write('locked\\n');
    process.stdin.once('data', () => { db.exec('COMMIT'); db.close(); process.exit(0); });
  `;
  const child = spawn(process.execPath, ['-e', script, require.resolve('better-sqlite3'), file, kind], { stdio: ['pipe', 'pipe', 'inherit'] });
  holders.add(child);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the lock holder exited before it held the lock')));
  });
  return {
    async release() {
      child.stdin!.write('go\n');
      await exited;
      holders.delete(child);
    },
  };
}

// For afterEach: a failed test must not leave a process holding a lock
export function killLockHolders(): void {
  for (const child of holders) child.kill('SIGKILL');
  holders.clear();
}
