import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { editMemory } from "./editor.ts";
import { openMemory } from "./runtime.ts";
import { search } from "./search.ts";
import type { Entry, Listing, MemoryStore } from "./store.ts";
import type { Project } from "./project.ts";

const help = "Use /memory review [skipped], /memory manage [search text], or /memory status.";
function report(listing: Listing, ctx: ExtensionCommandContext) {
  if (listing.warnings.length) ctx.ui.notify(`${listing.warnings.length} memory storage warning(s). Use /memory status for details.`, "warning");
}
function card(entry: Entry): string {
  const { memory, scope } = entry;
  const preview = memory.body.split("\n").slice(0, 8).join("\n").slice(0, 700);
  const remaining = preview.length < memory.body.length ? "\n… Open in editor for full text." : "";
  const location = scope === "candidate" ? `Candidate · suggests ${memory.suggestedScope}\nProject: ${memory.projectRoot}` : scope === "local" ? "Local memory" : "Global memory";
  return `${location}\n${memory.title}\n${memory.description}\n\n${preview}${remaining}`;
}

async function refresh(entry: Entry, store: MemoryStore, project: Project): Promise<Entry | undefined> {
  return (await store.list(entry.scope, project)).entries.find(current => current.memory.id === entry.memory.id);
}

async function review(store: MemoryStore, project: Project, skipped: boolean, ctx: ExtensionCommandContext) {
  const listing = await store.list("candidate", project);
  report(listing, ctx);
  const entries = listing.entries.filter(entry => entry.memory.state === (skipped ? "skipped" : "pending"));
  const skippedCount = listing.entries.filter(entry => entry.memory.state === "skipped").length;
  if (!entries.length) {
    ctx.ui.notify(skipped ? "No skipped memory candidates." : `No pending memory candidates.${skippedCount ? ` ${skippedCount} skipped; use /memory review skipped.` : ""}`, "info");
    return;
  }
  for (let i = 0; i < entries.length; i++) {
    let entry: Entry | undefined = entries[i];
    while (entry) {
      const action = await ctx.ui.select(`Memory ${i + 1}/${entries.length}\n${card(entry)}`, [
        "Add locally", "Promote globally", "Forget", "Skip", "Edit in $EDITOR", "Close",
      ]);
      if (!action || action === "Close") return;
      try {
        if (action === "Edit in $EDITOR") {
          await editMemory(entry, store, ctx);
          entry = await refresh(entry, store, project);
          continue;
        }
        if (action === "Forget") {
          if (!await ctx.ui.confirm("Forget candidate?", "Permanently delete this candidate?")) continue;
          await store.delete(entry);
        } else if (action === "Skip") {
          await store.skip(entry);
        } else {
          await store.move(entry, action === "Add locally" ? "local" : "global", project);
          ctx.ui.notify(action === "Add locally" ? "Memory approved in its local project." : "Memory approved globally.", "info");
        }
        break;
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        if (entry) entry = await refresh(entry, store, project);
      }
    }
  }
  ctx.ui.notify("Memory review complete.", "info");
}

async function manage(store: MemoryStore, project: Project, initialQuery: string, ctx: ExtensionCommandContext) {
  while (true) {
    const selectedScope = await ctx.ui.select("Manage memory — choose scope", ["Local", "Global"]);
    if (!selectedScope) return;
    const scope = selectedScope === "Local" ? "local" : "global";
    let query = initialQuery;
    while (true) {
      const listing = await store.list(scope, project);
      report(listing, ctx);
      const entries = query ? search(listing.entries, query, listing.entries.length) : listing.entries;
      const labels = entries.map(entry => `${entry.memory.title.slice(0, 90)} [${entry.memory.id.slice(0, 8)}]`);
      const selection = await ctx.ui.select(`${selectedScope} memories (${entries.length})${query ? ` · ${query}` : ""}`, ["Search…", ...labels, "Back"]);
      if (!selection || selection === "Back") break;
      if (selection === "Search…") {
        const input = await ctx.ui.input("Search memories (empty to show all)", query);
        if (input !== undefined) query = input.trim();
        continue;
      }
      let entry: Entry | undefined = entries[labels.indexOf(selection)];
      while (entry) {
        const action = await ctx.ui.select(card(entry), [
          "Edit in $EDITOR", scope === "local" ? "Promote globally" : "Demote to this project", "Delete", "Back",
        ]);
        if (!action || action === "Back") break;
        try {
          if (action === "Edit in $EDITOR") {
            await editMemory(entry, store, ctx);
            entry = await refresh(entry, store, project);
            continue;
          }
          if (action === "Delete") {
            if (!await ctx.ui.confirm("Delete memory?", "Permanently delete this approved memory?")) continue;
            await store.delete(entry);
          } else {
            await store.move(entry, scope === "local" ? "global" : "local", project);
          }
          break;
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
          if (entry) entry = await refresh(entry, store, project);
        }
      }
    }
  }
}

async function availability(path: string): Promise<string> {
  try {
    await access(path, constants.R_OK);
    try { await access(path, constants.W_OK); return "readable, writable"; }
    catch { return "readable, read-only"; }
  } catch (error) {
    return `unavailable: ${(error as NodeJS.ErrnoException).code}`;
  }
}

export async function runMemoryCommand(args: string, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const [command = "", ...rest] = args.trim().split(/\s+/);
  if (!["review", "manage", "status"].includes(command)) return help;
  if ((command === "status" && rest.length) || (command === "review" && rest.join(" ") !== "" && rest.join(" ") !== "skipped")) return help;
  if (command !== "status" && ctx.mode !== "tui") return "Memory review and management require Pi's interactive terminal mode.";
  if (command !== "status") await ctx.waitForIdle();
  const { store, project, config } = await openMemory(ctx.cwd);
  if (command === "status") {
    const [candidates, local, global] = await Promise.all([
      store.list("candidate", project), store.list("local", project), store.list("global", project),
    ]);
    const candidateDir = join(config.globalRoot, "candidates"), globalDir = join(config.globalRoot, "approved");
    return [
      `Config: ${config.configPath}`,
      `Git exclusion: ${config.gitExclude ? "on (already tracked files remain tracked)" : "off"}`,
      `Project: ${project.root}`,
      `Local: ${project.localDir} (${await availability(project.localDir)}) — ${local.entries.length} memories`,
      `Global: ${globalDir} (${await availability(globalDir)}) — ${global.entries.length} memories`,
      `Candidates: ${candidateDir} (${await availability(candidateDir)}) — ${candidates.entries.filter(entry => entry.memory.state === "pending").length} pending, ${candidates.entries.filter(entry => entry.memory.state === "skipped").length} skipped`,
      "Storage persists only as long as its directory/volume.",
      ...[...candidates.warnings, ...local.warnings, ...global.warnings].slice(0, 20),
    ].join("\n");
  }
  if (command === "review") await review(store, project, rest[0] === "skipped", ctx);
  else await manage(store, project, rest.join(" "), ctx);
}
