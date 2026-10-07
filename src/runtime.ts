import { loadConfig } from "./config.ts";
import { resolveProject } from "./project.ts";
import { MemoryStore } from "./store.ts";

export async function openMemory(cwd: string) {
  const [config, project] = await Promise.all([loadConfig(), resolveProject(cwd)]);
  return { config, project, store: new MemoryStore(config) };
}
