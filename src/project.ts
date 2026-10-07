import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWrite, isMissing, withLocks } from "./files.ts";

const exec = promisify(execFile);
export interface Project {
  root: string;
  localDir: string;
  git: boolean;
  available: boolean;
  excludePath?: string;
}
const marker = "# my-pi-memory: begin";
const endMarker = "# my-pi-memory: end";
const block = `${marker}\n/.pi/agent/memory/\n${endMarker}\n`;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;
}

export async function resolveProject(cwd: string): Promise<Project> {
  cwd = await realpath(cwd);
  try {
    await git(cwd, "rev-parse", "--show-toplevel");
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? "");
    if (!isMissing(error) && !stderr.includes("not a git repository")) throw error;
    return { root: cwd, localDir: join(cwd, ".pi", "agent", "memory"), git: false, available: true };
  }
  // Git lists the main worktree first, even when invoked from a linked worktree.
  const listing = await git(cwd, "worktree", "list", "--porcelain", "-z");
  const rootField = listing.split("\0").find(field => field.startsWith("worktree "));
  if (!rootField) throw new Error("Git did not identify the main worktree");
  let root = rootField.slice("worktree ".length);
  let available = true;
  try { root = await realpath(root); available = (await stat(root)).isDirectory(); }
  catch (error) { if (isMissing(error)) available = false; else throw error; }
  const excludePath = (await git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")).trim();
  return { root, localDir: join(root, ".pi", "agent", "memory"), git: true, available, excludePath };
}

export async function configureExclusion(project: Project, enabled: boolean): Promise<void> {
  if (!project.excludePath) return;
  const path = project.excludePath;
  await withLocks([dirname(path)], async () => {
    let original = "";
    try { original = await readFile(path, "utf8"); } catch (error) { if (!isMissing(error)) throw error; }
    const cleaned = original.replace(new RegExp(`${marker}\\r?\\n[\\s\\S]*?${endMarker}\\r?\\n?`, "g"), "");
    const next = enabled ? cleaned + (cleaned && !cleaned.endsWith("\n") ? "\n" : "") + block : cleaned;
    if (next !== original) await atomicWrite(path, next);
  });
}

export function requireLocal(project: Project): string {
  if (!project.available) throw new Error(`Main project is unavailable: ${project.root}. Mount it to use local memory.`);
  return project.localDir;
}
