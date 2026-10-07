import assert from "node:assert/strict";
import { test } from "node:test";
import { search } from "../src/search.ts";
import type { Entry } from "../src/store.ts";

function entry(id: string, title: string, description: string, body: string, scope: Entry["scope"] = "local"): Entry {
  return {
    memory: { version: 1, id, title, description, body, state: scope === "candidate" ? "pending" : "approved", created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" },
    path: `/memories/${id}.md`, scope, raw: "",
  };
}

test("recall ranks title then description then body, normalizes accents, and excludes candidates", () => {
  const records = [
    entry("body", "Build", "Development commands", "Use café mode for tests."),
    entry("description", "Preferences", "Café preferences", "Keep this setting."),
    entry("title", "CAFÉ", "A preference", "Keep this setting."),
    entry("candidate", "Café", "Café", "Café", "candidate"),
  ];
  assert.deepEqual(search(records, "cafe").map(record => record.memory.id), ["title", "description", "body"]);
  assert.deepEqual(search(records, "unrelated"), []);
  assert.deepEqual(search(records, "cafe", 1).map(record => record.memory.id), ["title"]);
});

test("interrupted move copies are returned once with local canonical content", () => {
  const local = entry("same", "Tests", "Test runner", "Use npm test.");
  const copy = { ...local, scope: "global" as const };
  assert.deepEqual(search([local, copy], "tests"), [local]);
});
