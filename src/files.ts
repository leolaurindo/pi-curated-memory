import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true });
  }
}

/** Sorted directory locks prevent deadlock on moves involving multiple stores. */
export async function withLocks<T>(directories: string[], operation: () => Promise<T>): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  let compromised: Error | undefined;
  try {
    for (const directory of [...new Set(directories.map(path => resolve(path)))].sort()) {
      await mkdir(directory, { recursive: true });
      releases.push(await lockfile.lock(directory, {
        realpath: false, lockfilePath: join(directory, ".memory.lock"),
        stale: 10_000, update: 2_000,
        retries: { retries: 30, minTimeout: 100, maxTimeout: 500, randomize: true },
        onCompromised: error => { compromised = error; },
      }));
    }
    if (compromised) throw compromised;
    const result = await operation();
    if (compromised) throw compromised;
    return result;
  } finally {
    for (const release of releases.reverse()) await release();
  }
}
