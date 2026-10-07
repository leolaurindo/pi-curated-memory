import type { Entry } from "./store.ts";

function words(text: string): string[] {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** Metadata outranks body matches; copied IDs never produce duplicate results. */
export function search(entries: Entry[], query: string, limit = 5): Entry[] {
  const terms = [...new Set(words(query))];
  const seen = new Set<string>();
  return entries.filter(entry => {
    if (entry.scope === "candidate" || seen.has(entry.memory.id)) return false;
    seen.add(entry.memory.id);
    return true;
  }).map(entry => {
    const title = new Set(words(entry.memory.title)), description = new Set(words(entry.memory.description)), body = new Set(words(entry.memory.body));
    const score = terms.reduce((sum, term) => sum + (title.has(term) ? 8 : 0) + (description.has(term) ? 4 : 0) + (body.has(term) ? 1 : 0), 0);
    return { entry, score };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.memory.id.localeCompare(b.entry.memory.id))
    .slice(0, Math.max(0, Math.min(10, limit))).map(item => item.entry);
}
