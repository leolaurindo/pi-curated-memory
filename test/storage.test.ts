import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { decode, encode } from "../src/store.ts";
import { fixture, draft, exec } from "./helpers.ts";

test("global config defaults, path overrides, and invalid preferences", async t => {
  const { root } = await fixture(t);
  assert.equal((await loadConfig(root)).globalRoot, join(root, "memory"));
  assert.equal((await loadConfig(root)).usagePath, join(root, "memory-usage.json"));
  assert.equal((await loadConfig(root)).gitExclude, true);
  await writeFile(join(root, "memory.json"), JSON.stringify({ globalRoot: "dotfiles/memories", gitExclude: false }));
  const config = await loadConfig(root);
  assert.equal(config.globalRoot, join(root, "dotfiles/memories"));
  assert.equal(config.usagePath, join(root, "memory-usage.json"));
  assert.equal(config.gitExclude, false);
  await writeFile(join(root, "memory.json"), '{"gitExclude":"false"}');
  await assert.rejects(loadConfig(root), /must be boolean/);
  await writeFile(join(root, "memory.json"), '{"unknown":true}');
  await assert.rejects(loadConfig(root), /Unknown memory config key/);
});

test("candidate lifecycle keeps pending data outside projects and approval targets its project", async t => {
  const { root, store, project } = await fixture(t);
  const queued = await store.queue(draft, project);
  assert.equal(queued.duplicate, false);
  assert.equal(decode(await readFile(queued.entry.path, "utf8")).body, draft.body);
  assert.equal((await store.list("local", project)).entries.length, 0);
  assert.equal((await store.queue(draft, project)).duplicate, true);
  await store.skip(queued.entry);
  const skipped = (await store.list("candidate", project)).entries[0];
  assert.equal(skipped.memory.state, "skipped");

  const other = join(root, "other");
  await mkdir(other);
  const { resolveProject } = await import("../src/project.ts");
  const otherProject = await resolveProject(other);
  await store.move(skipped, "local", otherProject);
  assert.equal((await store.list("candidate", project)).entries.length, 0);
  assert.equal((await store.list("local", otherProject)).entries.length, 0);
  const local = (await store.list("local", project)).entries[0];
  assert.equal(local.memory.body, draft.body);
  assert.equal(local.memory.state, "approved");
  assert.equal(local.memory.projectRoot, undefined);
  assert.equal((await store.queue(draft, project)).duplicate, true);
});

test("promotion drops origin and demotion targets the current project", async t => {
  const { root, store, project } = await fixture(t);
  await store.move((await store.queue(draft, project)).entry, "global", project);
  const global = (await store.list("global", project)).entries[0];
  assert.equal(global.memory.projectRoot, undefined);
  const other = join(root, "other");
  await mkdir(other);
  const { resolveProject } = await import("../src/project.ts");
  const target = await resolveProject(other);
  await store.move(global, "local", target);
  assert.equal((await store.list("global", project)).entries.length, 0);
  const local = (await store.list("local", target)).entries[0];
  assert.equal(local.memory.id, global.memory.id);
  assert.equal(local.memory.body, draft.body);
  await store.delete(local);
  assert.equal((await store.list("local", target)).entries.length, 0);
});

test("missing candidate destinations retain the candidate but do not prevent global approval", async t => {
  const { root, store, project } = await fixture(t);
  const missingProject = { ...project, root: join(root, "unmounted-project"), localDir: join(root, "unmounted-project", ".pi", "agent", "memory") };
  const { entry } = await store.queue(draft, missingProject);
  await assert.rejects(store.move(entry, "local", project), /Candidate project is unavailable/);
  assert.equal((await store.list("candidate", project)).entries.length, 1);
  await store.move(entry, "global", project);
  const approved = (await store.list("global", project)).entries[0].memory;
  assert.equal(approved.body, draft.body);
  assert.equal(approved.projectRoot, undefined);
});

test("invalid or conflicting external edits cannot overwrite a memory", async t => {
  const { store, project } = await fixture(t);
  const { entry } = await store.queue(draft, project);
  await assert.rejects(store.edit(entry, "not a memory"), /Expected YAML/);
  await assert.rejects(store.edit(entry, encode({ ...entry.memory, id: "changed" })), /protected metadata/);
  await store.edit(entry, encode({ ...entry.memory, body: "Run pnpm test instead." }));
  assert.equal((await store.list("candidate", project)).entries[0].memory.body, "Run pnpm test instead.");
  await assert.rejects(store.delete(entry), /changed in another session/);
  assert.equal((await store.list("candidate", project)).entries.length, 1);
});

test("failed moves retain their source and interrupted copies can be retried", async t => {
  const { store, project } = await fixture(t);
  const { entry } = await store.queue(draft, project);
  const directory = store.directory("global", project);
  await mkdir(directory, { recursive: true });
  const destination = join(directory, `${entry.memory.id}.md`);
  const { projectRoot: _root, suggestedScope: _scope, ...approved } = entry.memory;
  await writeFile(destination, encode({ ...approved, state: "approved", body: "Conflicting body" }));
  await assert.rejects(store.move(entry, "global", project), /conflicting memory/);
  assert.equal(await readFile(entry.path, "utf8"), entry.raw);
  await writeFile(destination, encode({ ...approved, state: "approved" }));
  await store.move(entry, "global", project);
  assert.equal((await store.list("candidate", project)).entries.length, 0);
  assert.equal((await store.list("global", project)).entries.length, 1);
});

test("corrupt records are reported without hiding valid memories", async t => {
  const { store, project } = await fixture(t);
  await store.queue(draft, project);
  await writeFile(join(store.directory("candidate", project), "bad.md"), "---\nversion: 1\n---\nbroken");
  const listing = await store.list("candidate", project);
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.warnings.length, 1);
  assert.match(listing.warnings[0], /bad\.md/);
  await store.queue({ ...draft, body: "A second candidate" }, project);
  const after = await store.list("candidate", project);
  assert.equal(after.entries.length, 2);
  assert.equal(after.warnings.length, 1);
});

test("separate processes serialize candidate writes and suppress exact duplicates", async t => {
  const { cwd, config, store, project } = await fixture(t);
  const code = `
    import { MemoryStore } from "./src/store.ts";
    import { resolveProject } from "./src/project.ts";
    const store = new MemoryStore(JSON.parse(process.argv[1]));
    await store.queue(JSON.parse(process.argv[3]), await resolveProject(process.argv[2]));
  `;
  await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, JSON.stringify(config), cwd, JSON.stringify(draft)],
    { cwd: process.cwd(), timeout: 20_000 })));
  const listing = await store.list("candidate", project);
  assert.equal(listing.warnings.length, 0);
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].memory.body, draft.body);
});
