import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { readUsage, recentScore, recordAccess } from "../src/usage.ts";
import { fixture, exec } from "./helpers.ts";

const day = 24 * 60 * 60 * 1_000;
const start = Date.parse("2026-01-01T00:00:00.000Z");

test("usage counts each returned ID once per recall and does not create a log for empty results", async t => {
  const { config } = await fixture(t);
  await recordAccess(config.usagePath, [], start);
  await assert.rejects(readFile(config.usagePath), { code: "ENOENT" });
  await recordAccess(config.usagePath, ["local-id", "global-id", "local-id"], start);
  await recordAccess(config.usagePath, ["local-id"], start);
  const log = JSON.parse(await readFile(config.usagePath, "utf8"));
  assert.deepEqual(log, {
    "local-id": { accessCount: 2, lastAccess: "2026-01-01T00:00:00.000Z", recentScore: 2 },
    "global-id": { accessCount: 1, lastAccess: "2026-01-01T00:00:00.000Z", recentScore: 1 },
  });
});

test("recent score decays with a 30-day half-life on access and consultation", async t => {
  const { config } = await fixture(t);
  await recordAccess(config.usagePath, ["memory"], start);
  await recordAccess(config.usagePath, ["memory"], start);
  let usage = (await readUsage(config.usagePath)).memory;
  assert.equal(recentScore(usage, start + 30 * day), 1);
  assert.equal(recentScore(usage, start + 60 * day), 0.5);
  await recordAccess(config.usagePath, ["memory"], start + 30 * day);
  usage = (await readUsage(config.usagePath)).memory;
  assert.equal(usage.accessCount, 3);
  assert.equal(usage.recentScore, 2);
  assert.equal(usage.lastAccess, "2026-01-31T00:00:00.000Z");
  assert.equal(recentScore(usage, start + 90 * day), 0.5);
  await recordAccess(config.usagePath, ["memory"], start + 90 * day);
  assert.equal((await readUsage(config.usagePath)).memory.recentScore, 1.5);
});

test("out-of-order timestamps cannot increase score through negative decay or move last access backwards", async t => {
  const { config } = await fixture(t);
  await recordAccess(config.usagePath, ["memory"], start + day);
  await recordAccess(config.usagePath, ["memory"], start);
  const usage = (await readUsage(config.usagePath)).memory;
  assert.equal(usage.lastAccess, "2026-01-02T00:00:00.000Z");
  assert.equal(usage.accessCount, 2);
  assert.equal(recentScore(usage, start), 2);
});

test("corrupt usage logs are preserved instead of being silently reset", async t => {
  const { config } = await fixture(t);
  for (const raw of ["broken JSON", JSON.stringify({ memory: { accessCount: -1, lastAccess: new Date(start).toISOString(), recentScore: 1 } })]) {
    await writeFile(config.usagePath, raw);
    await assert.rejects(recordAccess(config.usagePath, ["memory"], start));
    assert.equal(await readFile(config.usagePath, "utf8"), raw);
  }
});

test("separate processes accumulate accesses without lost updates", async t => {
  const { config } = await fixture(t);
  const code = `
    import { recordAccess } from "./src/usage.ts";
    for (let i = 0; i < 5; i++) await recordAccess(process.argv[1], ["shared-memory"], ${start});
  `;
  await Promise.all(Array.from({ length: 4 }, () => exec(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code, config.usagePath],
    { cwd: process.cwd(), timeout: 20_000 })));
  const usage = (await readUsage(config.usagePath))["shared-memory"];
  assert.equal(usage.accessCount, 20);
  assert.equal(usage.recentScore, 20);
});
