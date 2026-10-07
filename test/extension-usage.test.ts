import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { readUsage } from "../src/usage.ts";
import { fixture, draft } from "./helpers.ts";

async function setup(t: TestContext) {
  const setup = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = setup.root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await writeFile(join(setup.root, "memory.json"), JSON.stringify({ globalRoot: setup.config.globalRoot }));
  const loaded = await discoverAndLoadExtensions([resolve("index.ts")], setup.cwd, setup.root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(extension => extension.resolvedPath === resolve("index.ts"))!;
  const notifications: string[] = [];
  const ctx = { cwd: setup.cwd, hasUI: true, mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionToolContext;
  return { ...setup, recall: extension.tools.get("recall")!.definition, ctx, notifications };
}

test("recall counts only returned memories after limits/dedup and preserves usage through promotion", async t => {
  const { store, project, config, recall, ctx } = await setup(t);
  const candidate = (await store.queue(draft, project)).entry;
  await recall.execute("pending", { query: "tests" }, undefined, undefined, ctx);
  await assert.rejects(readFile(config.usagePath), { code: "ENOENT" });
  await store.move(candidate, "local", project);
  const local = (await store.list("local", project)).entries[0];
  const second = (await store.queue({ title: "Tests", description: "Test runner preference", body: "Use a separate test command." }, project)).entry;
  await store.move(second, "global", project);
  await recall.execute("limited", { query: "tests", limit: 1 }, undefined, undefined, ctx);
  let log = await readUsage(config.usagePath);
  assert.equal(log[second.memory.id].accessCount, 1);
  assert.equal(log[local.memory.id], undefined);
  await recall.execute("local", { query: "tests", scope: "local" }, undefined, undefined, ctx);
  await store.move(local, "global", project);
  await recall.execute("promoted", { query: "tests", scope: "global" }, undefined, undefined, ctx);
  log = await readUsage(config.usagePath);
  assert.equal(log[local.memory.id].accessCount, 2);
  assert.equal(log[second.memory.id].accessCount, 2);

  // A leftover local copy after an interrupted move must not count twice.
  await writeFile(local.path, local.raw);
  await recall.execute("copied", { query: "tests", scope: "both" }, undefined, undefined, ctx);
  log = await readUsage(config.usagePath);
  assert.equal(log[local.memory.id].accessCount, 3);
  assert.equal(log[second.memory.id].accessCount, 3);
  const saved = await readFile(config.usagePath, "utf8");
  assert.ok(!saved.includes(draft.body));
  assert.ok(!saved.includes(project.root));
  await recall.execute("no-match", { query: "zzzz" }, undefined, undefined, ctx);
  assert.equal(await readFile(config.usagePath, "utf8"), saved);
  assert.equal(recall.annotations?.readOnlyHint, false);
  assert.equal(recall.annotations?.idempotentHint, false);
});

test("usage log failures preserve the log and recall results, warning only once", async t => {
  const { store, project, config, recall, ctx, notifications } = await setup(t);
  await store.move((await store.queue(draft, project)).entry, "global", project);
  await writeFile(config.usagePath, "broken JSON");
  for (let i = 0; i < 2; i++) {
    const result = await recall.execute(`recall-${i}`, { query: "tests" }, undefined, undefined, ctx);
    const data = result.structuredContent as unknown as { results: { body: string }[]; warnings: string[] };
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].body, draft.body);
    assert.deepEqual(data.warnings, []);
  }
  assert.equal(await readFile(config.usagePath, "utf8"), "broken JSON");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /usage statistics could not be saved/);

  // A filesystem error, not just a parser failure, is also nonfatal.
  const { rm, mkdir } = await import("node:fs/promises");
  await rm(config.usagePath);
  await mkdir(config.usagePath);
  const result = await recall.execute("unwritable", { query: "tests" }, undefined, undefined, ctx);
  assert.equal((result.structuredContent as unknown as { results: unknown[] }).results.length, 1);
  assert.equal(notifications.length, 1);
});
