import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite, isMissing, withLocks } from "./files.ts";

export interface MemoryUsage {
  accessCount: number;
  lastAccess: string;
  recentScore: number;
}
export type UsageLog = Record<string, MemoryUsage>;
const halfLifeMs = 30 * 24 * 60 * 60 * 1_000;

/** The saved score is anchored at lastAccess; reading its current value never writes. */
export function recentScore(usage: MemoryUsage, now = Date.now()): number {
  return usage.recentScore * 0.5 ** (Math.max(0, now - Date.parse(usage.lastAccess)) / halfLifeMs);
}

export async function readUsage(path: string): Promise<UsageLog> {
  const log: UsageLog = Object.create(null);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (isMissing(error)) return log; throw error; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid memory usage log");
  for (const [id, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid memory usage record: ${id}`);
    const { accessCount, lastAccess, recentScore } = value as MemoryUsage;
    if (!Number.isSafeInteger(accessCount) || accessCount < 1 || typeof lastAccess !== "string" ||
        !Number.isFinite(Date.parse(lastAccess)) || !Number.isFinite(recentScore) || recentScore < 0) {
      throw new Error(`Invalid memory usage record: ${id}`);
    }
    log[id] = { accessCount, lastAccess, recentScore };
  }
  return log;
}

/** Count each returned ID once per recall; never overwrite a corrupt log with empty data. */
export async function recordAccess(path: string, ids: string[], now = Date.now()): Promise<void> {
  if (!ids.length) return;
  await withLocks([dirname(path)], async () => {
    const log = await readUsage(path);
    for (const id of new Set(ids)) {
      const previous = log[id];
      const timestamp = Math.max(now, previous ? Date.parse(previous.lastAccess) : now);
      const accessCount = (previous?.accessCount ?? 0) + 1;
      if (!Number.isSafeInteger(accessCount)) throw new Error(`Memory access counter overflow: ${id}`);
      log[id] = {
        accessCount, lastAccess: new Date(timestamp).toISOString(),
        recentScore: (previous ? recentScore(previous, timestamp) : 0) + 1,
      };
    }
    await atomicWrite(path, JSON.stringify(log, null, 2) + "\n");
  });
}
