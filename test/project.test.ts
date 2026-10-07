import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureExclusion, resolveProject } from "../src/project.ts";
import { fixture, draft, exec } from "./helpers.ts";

test("linked worktrees share the main store and ignore copied memory directories", async t => {
  const { root, cwd, project, store } = await fixture(t, true);
  await exec("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "initial"]);
  const linked = join(root, "linked");
  await exec("git", ["-C", cwd, "worktree", "add", "-qb", "linked", linked]);
  const fromLinked = await resolveProject(linked);
  assert.equal(fromLinked.root, project.root);
  assert.equal(fromLinked.localDir, project.localDir);
  await store.move((await store.queue(draft, fromLinked)).entry, "local", fromLinked);
  const local = (await store.list("local", project)).entries[0];
  const copied = join(linked, ".pi", "agent", "memory");
  await mkdir(copied, { recursive: true });
  await writeFile(join(copied, `${local.memory.id}.md`), local.raw.replace("Run npm test", "WRONG copied content"));
  const recalled = (await store.list("local", fromLinked)).entries;
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].memory.body, draft.body);
});

test("Git exclusion is idempotent, preference-controlled, and preserves user entries", async t => {
  const { cwd, project } = await fixture(t, true);
  await writeFile(project.excludePath!, "# User rule\n/private/\n/.pi/agent/memory/\n");
  await configureExclusion(project, true);
  const first = await readFile(project.excludePath!, "utf8");
  await configureExclusion(project, true);
  assert.equal(await readFile(project.excludePath!, "utf8"), first);
  assert.match(first, /my-pi-memory: begin/);
  await configureExclusion(project, false);
  assert.equal(await readFile(project.excludePath!, "utf8"), "# User rule\n/private/\n/.pi/agent/memory/\n");
  await assert.rejects(readFile(join(cwd, ".gitignore")), { code: "ENOENT" });
});

test("non-Git directories use cwd and exclusion is a no-op", async t => {
  const { project } = await fixture(t);
  assert.equal(project.git, false);
  await configureExclusion(project, true);
  await configureExclusion(project, false);
});
