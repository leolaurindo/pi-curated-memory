import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverAndLoadExtensions, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { fixture, draft } from "./helpers.ts";

test("Pi loads the extension; tools persist candidates, recall only approved data, and notices hide text", async t => {
  const { root, cwd, store, project, config } = await fixture(t);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  await writeFile(join(root, "memory.json"), JSON.stringify({ globalRoot: config.globalRoot }));
  const loaded = await discoverAndLoadExtensions([resolve("index.ts")], cwd, root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions.find(extension => extension.resolvedPath === resolve("index.ts"))!;
  assert.ok(extension);
  const notifications: string[] = [];
  const ctx = { cwd, hasUI: true, mode: "tui", ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionToolContext;
  const write = extension.tools.get("memory_write")!.definition;
  const recall = extension.tools.get("recall_memory")!.definition;
  assert.match(write.promptGuidelines!.join(" "), /even when the user has not explicitly asked/);
  assert.match(write.promptGuidelines!.join(" "), /never approves/);
  assert.match(recall.promptGuidelines!.join(" "), /user preferences/);
  const startup = extension.handlers.get("session_start")![0];
  await startup({ type: "session_start" }, ctx);
  assert.equal(notifications.length, 0);

  const result = await write.execute("write", draft, undefined, undefined, ctx);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /not approved/);
  assert.equal((await store.list("candidate", project)).entries.length, 1);
  assert.equal((await store.list("local", project)).entries.length, 0);
  assert.equal(notifications.length, 1);
  assert.ok(notifications.every(message => !message.includes(draft.body) && !message.includes(draft.title)));
  const call = write.renderCall!(draft, ctx.ui.theme, {} as never).render(80).join("\n");
  assert.ok(!call.includes(draft.title));

  const empty = await recall.execute("recall", { query: "tests" }, undefined, undefined, ctx);
  assert.deepEqual((empty.structuredContent as { results: unknown[] }).results, []);
  const candidate = (await store.list("candidate", project)).entries[0];
  await store.skip(candidate);
  notifications.length = 0;
  await startup({ type: "session_start" }, ctx);
  assert.deepEqual(notifications, ["There are 1 memory candidates. Type /memory review to see them."]);

  await store.move((await store.list("candidate", project)).entries[0], "local", project);
  const recalled = await recall.execute("recall", { query: "tests", scope: "both" }, undefined, undefined, ctx);
  const data = recalled.structuredContent as unknown as { results: { body: string; scope: string; path: string }[] };
  assert.equal(data.results.length, 1);
  assert.equal(data.results[0].body, draft.body);
  assert.equal(data.results[0].scope, "local");
  assert.equal(data.results[0].path, (await store.list("local", project)).entries[0].path);
  await assert.rejects(recall.execute("blank", { query: " " }, undefined, undefined, ctx), /must not be blank/);

  const long = await store.queue({ title: "Verbose memory", description: "Output size contract", body: "x".repeat(5_000) }, project);
  await store.move(long.entry, "global", project);
  const bounded = await recall.execute("bounded", { query: "verbose", scope: "global" }, undefined, undefined, ctx);
  const boundedData = bounded.structuredContent as unknown as { results: { body: string; bodyTruncated: boolean; scope: string }[] };
  assert.equal(boundedData.results.length, 1);
  assert.equal(boundedData.results[0].body.length, 2_000);
  assert.equal(boundedData.results[0].bodyTruncated, true);
  assert.equal(boundedData.results[0].scope, "global");

  const before = notifications.length;
  await assert.rejects(write.execute("invalid", { ...draft, body: " " }, undefined, undefined, ctx), /body must be nonempty/);
  assert.equal(notifications.length, before);
  assert.equal((await store.list("candidate", project)).entries.length, 0);
  const blocked = join(root, "blocked-memory");
  await writeFile(blocked, "not a directory");
  await writeFile(join(root, "memory.json"), JSON.stringify({ globalRoot: blocked }));
  await assert.rejects(write.execute("failed-write", draft, undefined, undefined, ctx), /ENOTDIR/);
  assert.equal(notifications.length, before);
  await writeFile(join(root, "memory.json"), JSON.stringify({ globalRoot: config.globalRoot }));
  const duplicate = await write.execute("duplicate", draft, undefined, undefined, ctx);
  assert.equal((duplicate.structuredContent as { duplicate: boolean }).duplicate, true);
  assert.equal(notifications.length, before);
  await extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown" }, ctx);
});
