import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { parse, stringify } from "yaml";
import type { Config } from "./config.ts";
import { atomicWrite, isMissing, syncDirectory, withLocks } from "./files.ts";
import { configureExclusion, requireLocal, resolveProject, type Project } from "./project.ts";

export type Scope = "candidate" | "local" | "global";
export interface Memory {
  version: 1;
  id: string;
  title: string;
  description: string;
  body: string;
  created: string;
  updated: string;
  state: "pending" | "skipped" | "approved";
  projectRoot?: string;
  suggestedScope?: "local" | "global";
}
export interface Entry { memory: Memory; path: string; scope: Scope; raw: string }
export interface Listing { entries: Entry[]; warnings: string[] }
export interface Draft { title: string; description: string; body: string; scope?: "local" | "global" }

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${field} must be nonempty text (at most ${max} characters)`);
  }
  return value.trim();
}

export function decode(raw: string): Memory {
  if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("Memory exceeds 64 KiB");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error("Expected YAML metadata between --- lines followed by Markdown");
  const metadata = parse(match[1]);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("Invalid metadata");
  if (metadata.version !== 1 || typeof metadata.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(metadata.id)) throw new Error("Invalid version or ID");
  if (!["pending", "skipped", "approved"].includes(metadata.state)) throw new Error("Invalid state");
  for (const key of ["created", "updated"]) {
    if (typeof metadata[key] !== "string" || !Number.isFinite(Date.parse(metadata[key]))) throw new Error(`Invalid ${key}`);
  }
  const result: Memory = {
    version: 1, id: metadata.id, state: metadata.state,
    title: text(metadata.title, "title", 200), description: text(metadata.description, "description", 500),
    body: text(match[2], "body", 20_000), created: metadata.created, updated: metadata.updated,
  };
  if (result.state !== "approved") {
    if (typeof metadata.projectRoot !== "string" || !isAbsolute(metadata.projectRoot)) throw new Error("Candidate requires an absolute projectRoot");
    if (!["local", "global"].includes(metadata.suggestedScope)) throw new Error("Invalid suggestedScope");
    result.projectRoot = metadata.projectRoot;
    result.suggestedScope = metadata.suggestedScope;
  }
  return result;
}

export function encode(memory: Memory): string {
  const { body, ...metadata } = memory;
  return `---\n${stringify(metadata).trimEnd()}\n---\n\n${body.trim()}\n`;
}

const fingerprint = (memory: Memory) => JSON.stringify([memory.title, memory.description, memory.body]);

export class MemoryStore {
  constructor(readonly config: Config) {}

  directory(scope: Scope, project: Project): string {
    if (scope === "local") return requireLocal(project);
    return join(this.config.globalRoot, scope === "candidate" ? "candidates" : "approved");
  }

  async list(scope: Scope, project: Project): Promise<Listing> {
    const entries: Entry[] = [], warnings: string[] = [];
    if (scope === "local" && !project.available) return { entries, warnings: [`Local memory unavailable: ${project.root}`] };
    const directory = this.directory(scope, project);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) {
      if (!isMissing(error)) warnings.push(`${directory}: ${(error as Error).message}`);
      return { entries, warnings };
    }
    for (const name of names.filter(name => name.endsWith(".md")).sort()) {
      const path = join(directory, name);
      try {
        if ((await stat(path)).size > 64 * 1024) throw new Error("Memory exceeds 64 KiB");
        const raw = await readFile(path, "utf8"), memory = decode(raw);
        if (name !== `${memory.id}.md`) throw new Error("Filename must match memory ID");
        if ((scope === "candidate") === (memory.state === "approved")) throw new Error("State does not match store");
        entries.push({ memory, path, scope, raw });
      } catch (error) {
        if (!isMissing(error)) warnings.push(`${path}: ${(error as Error).message}`);
      }
    }
    entries.sort((a, b) => a.memory.created.localeCompare(b.memory.created) || a.memory.id.localeCompare(b.memory.id));
    return { entries, warnings };
  }

  async queue(draft: Draft, project: Project): Promise<{ entry: Entry; duplicate: boolean }> {
    const now = new Date().toISOString();
    const memory = decode(encode({
      version: 1, id: randomUUID(), created: now, updated: now, state: "pending",
      projectRoot: project.root, suggestedScope: draft.scope ?? "local",
      title: draft.title, description: draft.description, body: draft.body,
    }));
    const directory = this.directory("candidate", project);
    return withLocks([directory], async () => {
      const candidates = await this.list("candidate", project);
      if (candidates.warnings.length) throw new Error(candidates.warnings.join("\n"));
      const local = await this.list("local", project), global = await this.list("global", project);
      const duplicate = [...candidates.entries.filter(entry => entry.memory.projectRoot === project.root), ...local.entries, ...global.entries]
        .find(entry => fingerprint(entry.memory) === fingerprint(memory));
      if (duplicate) return { entry: duplicate, duplicate: true };
      const path = join(directory, `${memory.id}.md`), raw = encode(memory);
      await atomicWrite(path, raw);
      return { entry: { memory, path, raw, scope: "candidate" }, duplicate: false };
    });
  }

  private async check(entry: Entry): Promise<void> {
    if (await readFile(entry.path, "utf8") !== entry.raw) throw new Error("Memory changed in another session. Reopen it before modifying.");
  }

  async edit(entry: Entry, edited: string): Promise<void> {
    const memory = decode(edited);
    for (const key of ["id", "version", "created", "state", "projectRoot", "suggestedScope"] as const) {
      if (memory[key] !== entry.memory[key]) throw new Error(`Do not edit protected metadata: ${key}`);
    }
    memory.updated = new Date().toISOString();
    await withLocks([dirname(entry.path)], async () => {
      await this.check(entry);
      await atomicWrite(entry.path, encode(memory));
    });
  }

  async skip(entry: Entry): Promise<void> {
    if (entry.scope !== "candidate") throw new Error("Only candidates can be skipped");
    await withLocks([dirname(entry.path)], async () => {
      await this.check(entry);
      await atomicWrite(entry.path, encode({ ...entry.memory, state: "skipped", updated: new Date().toISOString() }));
    });
  }

  async delete(entry: Entry): Promise<void> {
    await withLocks([dirname(entry.path)], async () => {
      await this.check(entry);
      await rm(entry.path);
      await syncDirectory(dirname(entry.path));
    });
  }

  async move(entry: Entry, scope: "local" | "global", currentProject: Project): Promise<void> {
    let target = currentProject;
    if (scope === "local" && entry.scope === "candidate") {
      // Resolve the recorded destination, never substitute the reviewer's cwd.
      target = await resolveProject(entry.memory.projectRoot!);
      if (target.root !== entry.memory.projectRoot) throw new Error("Candidate destination changed. Keep it queued or approve globally.");
    }
    if (scope === "local") await configureExclusion(target, this.config.gitExclude);
    const directory = this.directory(scope, target), destination = join(directory, `${entry.memory.id}.md`);
    if (destination === entry.path) return;
    const { projectRoot: _origin, suggestedScope: _suggestion, ...approved } = entry.memory;
    const memory: Memory = { ...approved, state: "approved", updated: new Date().toISOString() };
    await withLocks([directory, dirname(entry.path)], async () => {
      await this.check(entry);
      try {
        const existing = decode(await readFile(destination, "utf8"));
        if (existing.id !== memory.id || existing.state !== "approved" || fingerprint(existing) !== fingerprint(memory)) {
          throw new Error("Destination already contains a conflicting memory; nothing was removed");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        await atomicWrite(destination, encode(memory));
      }
      await rm(entry.path);
      await syncDirectory(dirname(entry.path));
    });
  }
}
