import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runMemoryCommand } from "../src/commands.ts";
import { recordAccess } from "../src/usage.ts";
import { fixture, draft } from "./helpers.ts";

function context(cwd: string, choices: (string | undefined)[], confirmations: boolean[] = []) {
  const notifications: string[] = [];
  const titles: string[] = [];
  const ctx = {
    cwd, hasUI: true, mode: "tui", waitForIdle: async () => {},
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (title: string, options: string[]) => {
        titles.push(title);
        const choice = choices.shift();
        if (choice !== undefined) assert.ok(options.includes(choice), `Missing UI action: ${choice}`);
        return choice;
      },
      confirm: async () => confirmations.shift() ?? false,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, titles };
}
async function configured(t: Parameters<typeof fixture>[0]) {
  const setup = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = setup.root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await writeFile(join(setup.root, "memory.json"), JSON.stringify({ globalRoot: setup.config.globalRoot }));
  return setup;
}

test("default review excludes skipped candidates; explicit skipped review can approve globally", async t => {
  const { cwd, store, project } = await configured(t);
  const first = (await store.queue(draft, project)).entry;
  await store.skip(first);
  await store.queue({ ...draft, title: "Second candidate" }, project);
  const { ctx } = context(cwd, ["Add locally"]);
  await runMemoryCommand("review", ctx);
  assert.equal((await store.list("local", project)).entries[0].memory.title, "Second candidate");
  assert.equal((await store.list("candidate", project)).entries[0].memory.state, "skipped");
  const skipped = context(cwd, ["Promote globally"]);
  await runMemoryCommand("review skipped", skipped.ctx);
  assert.equal((await store.list("candidate", project)).entries.length, 0);
  assert.equal((await store.list("global", project)).entries[0].memory.title, draft.title);
});

test("forget requires confirmation; escape and headless review never approve", async t => {
  const { cwd, store, project } = await configured(t);
  await store.queue(draft, project);
  await runMemoryCommand("review", context(cwd, ["Forget", "Close"], [false]).ctx);
  assert.equal((await store.list("candidate", project)).entries.length, 1);
  await runMemoryCommand("review", context(cwd, [undefined]).ctx);
  assert.equal((await store.list("local", project)).entries.length, 0);
  const headless = context(cwd, []);
  headless.ctx.mode = "print";
  assert.match((await runMemoryCommand("review", headless.ctx))!, /interactive terminal/);
  assert.equal((await store.list("candidate", project)).entries.length, 1);
  await runMemoryCommand("review", context(cwd, ["Forget"], [true]).ctx);
  assert.equal((await store.list("candidate", project)).entries.length, 0);
});

test("management exposes separate scopes and demotes globals to the current project", async t => {
  const { cwd, store, project } = await configured(t);
  await store.move((await store.queue(draft, project)).entry, "global", project);
  const memory = (await store.list("global", project)).entries[0].memory;
  const label = `${memory.title} [${memory.id.slice(0, 8)}]`;
  await runMemoryCommand("manage", context(cwd, ["Global", label, "Demote to this project", "Back", undefined]).ctx);
  assert.equal((await store.list("global", project)).entries.length, 0);
  assert.equal((await store.list("local", project)).entries[0].memory.id, memory.id);
});

test("management displays decayed usage without counting browsing as an access", async t => {
  const { cwd, store, project, config } = await configured(t);
  await store.move((await store.queue(draft, project)).entry, "local", project);
  const memory = (await store.list("local", project)).entries[0].memory;
  const old = Date.now() - 30 * 24 * 60 * 60 * 1_000;
  await recordAccess(config.usagePath, [memory.id], old);
  await recordAccess(config.usagePath, [memory.id], old);
  const saved = await readFile(config.usagePath, "utf8");
  const label = `${memory.title} [${memory.id.slice(0, 8)}]`;
  const { ctx, titles } = context(cwd, ["Local", label, "Back", "Back", undefined]);
  await runMemoryCommand("manage", ctx);
  const card = titles.find(title => title.startsWith("Local memory"))!;
  assert.match(card, /Accesses: 2/);
  assert.ok(card.includes(new Date(old).toISOString()));
  assert.match(card, /Recent score: 1\.00/);
  assert.equal(await readFile(config.usagePath, "utf8"), saved);
});

test("status reports paths and skipped counts without exposing memory bodies or requiring UI", async t => {
  const { cwd, store, project, config } = await configured(t);
  await store.skip((await store.queue(draft, project)).entry);
  const { ctx } = context(cwd, []);
  ctx.mode = "print";
  ctx.hasUI = false;
  const status = (await runMemoryCommand("status", ctx))!;
  assert.match(status, /0 pending, 1 skipped/);
  assert.ok(status.includes(config.globalRoot));
  assert.ok(status.includes(config.usagePath));
  assert.ok(status.includes(project.localDir));
  assert.ok(!status.includes(draft.body));
});
