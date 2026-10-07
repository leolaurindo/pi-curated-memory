import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { editMemory } from "../src/editor.ts";
import { fixture, draft } from "./helpers.ts";

function editorContext(cwd: string) {
  const terminalEvents: string[] = [];
  const ui = {
    custom: async (factory: Function) => {
      let result: unknown;
      await factory({
        stop: () => terminalEvents.push("stop"),
        start: () => terminalEvents.push("start"),
        requestRender: () => terminalEvents.push("render"),
      }, {}, {}, (value: unknown) => { result = value; });
      return result;
    },
  };
  return { ctx: { cwd, ui, mode: "tui" } as unknown as ExtensionCommandContext, terminalEvents };
}

test("external editor honors VISUAL with arguments, applies valid edits, and restores the terminal", async t => {
  const { root, cwd, store, project } = await fixture(t);
  const visual = process.env.VISUAL, editor = process.env.EDITOR;
  t.after(() => {
    if (visual === undefined) delete process.env.VISUAL; else process.env.VISUAL = visual;
    if (editor === undefined) delete process.env.EDITOR; else process.env.EDITOR = editor;
  });
  const script = join(root, "editor with spaces.cjs");
  await writeFile(script, `
    const fs = require("node:fs");
    const path = process.argv[2];
    fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("Run npm test", "Run pnpm test"));
  `);
  process.env.VISUAL = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  process.env.EDITOR = "nonexistent-editor";
  const entry = (await store.queue(draft, project)).entry;
  const { ctx, terminalEvents } = editorContext(cwd);
  await editMemory(entry, store, ctx);
  assert.equal((await store.list("candidate", project)).entries[0].memory.body, "Run pnpm test before finishing changes.");
  assert.deepEqual(terminalEvents, ["stop", "start", "render"]);
});

test("invalid editor content preserves the original and a recoverable draft", async t => {
  const { root, cwd, store, project } = await fixture(t);
  const previous = process.env.VISUAL;
  t.after(() => { if (previous === undefined) delete process.env.VISUAL; else process.env.VISUAL = previous; });
  const script = join(root, "invalid-editor.cjs");
  await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], "invalid edited memory");');
  process.env.VISUAL = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  const entry = (await store.queue(draft, project)).entry;
  const { ctx, terminalEvents } = editorContext(cwd);
  let recovery = "";
  await assert.rejects(editMemory(entry, store, ctx), (error: Error) => {
    assert.match(error.message, /Expected YAML/);
    recovery = error.message.match(/draft is preserved at (.+)\./)![1];
    return true;
  });
  assert.equal(await readFile(entry.path, "utf8"), entry.raw);
  assert.equal(await readFile(recovery, "utf8"), "invalid edited memory");
  const { rm } = await import("node:fs/promises");
  t.after(() => rm(join(recovery, ".."), { recursive: true, force: true }));
  assert.deepEqual(terminalEvents, ["stop", "start", "render"]);
});
