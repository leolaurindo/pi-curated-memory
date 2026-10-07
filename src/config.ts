import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isMissing } from "./files.ts";

export interface Config {
  configPath: string;
  globalRoot: string;
  gitExclude: boolean;
}

export async function loadConfig(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): Promise<Config> {
  agentDir = resolve(agentDir);
  const configPath = join(agentDir, "memory.json");
  let input: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
    input = parsed as Record<string, unknown>;
  } catch (error) {
    if (!isMissing(error)) throw new Error(`Cannot load ${configPath}: ${(error as Error).message}`);
  }
  for (const key of Object.keys(input)) {
    if (!["globalRoot", "gitExclude"].includes(key)) throw new Error(`Unknown memory config key: ${key}`);
  }
  if (input.gitExclude !== undefined && typeof input.gitExclude !== "boolean") throw new Error("gitExclude must be boolean");
  if (input.globalRoot !== undefined && (typeof input.globalRoot !== "string" || !input.globalRoot.trim())) {
    throw new Error("globalRoot must be a nonempty path");
  }
  let globalRoot = (input.globalRoot as string | undefined) ?? join(agentDir, "memory");
  if (globalRoot === "~" || globalRoot.startsWith("~/")) globalRoot = join(homedir(), globalRoot.slice(2));
  if (!isAbsolute(globalRoot)) globalRoot = resolve(agentDir, globalRoot);
  return { configPath, globalRoot, gitExclude: input.gitExclude !== false };
}
