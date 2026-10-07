import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import { MemoryStore } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";

export const exec = promisify(execFile);
export async function fixture(t: TestContext, git = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  if (git) await exec("git", ["init", "-q", cwd]);
  const config = { configPath: join(root, "memory.json"), globalRoot: join(root, "global"), gitExclude: true };
  return { root, cwd, config, store: new MemoryStore(config), project: await resolveProject(cwd) };
}
export const draft = { title: "Test command", description: "How to run project tests", body: "Run npm test before finishing changes." };
