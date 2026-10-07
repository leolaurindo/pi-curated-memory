import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "shell-quote";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Entry, MemoryStore } from "./store.ts";

/** Interpret editor arguments without executing shell operators or interpolating the filename. */
export async function editMemory(entry: Entry, store: MemoryStore, ctx: ExtensionCommandContext): Promise<void> {
  const command = process.env.VISUAL?.trim() || process.env.EDITOR?.trim();
  if (!command) throw new Error("Set $VISUAL or $EDITOR to edit memory files.");
  const arguments_ = parse(command, name => process.env[name] ?? "");
  if (!arguments_.length || arguments_.some(argument => typeof argument !== "string")) {
    throw new Error("$VISUAL/$EDITOR must be an executable with arguments, not a shell pipeline.");
  }
  const [executable, ...args] = arguments_ as string[];
  const directory = await mkdtemp(join(tmpdir(), "pi-memory-edit-"));
  const path = join(directory, `${entry.memory.id}.md`);
  await writeFile(path, entry.raw, { mode: 0o600 });
  try {
    const error = await ctx.ui.custom<Error | undefined>(async (tui, _theme, _keys, done) => {
      let failure: Error | undefined;
      tui.stop();
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable, [...args, path], { stdio: "inherit", cwd: ctx.cwd });
          child.on("error", reject);
          child.on("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Editor exited with ${signal ?? code}; original memory was not changed.`));
          });
        });
      } catch (error) { failure = error as Error; }
      finally {
        tui.start();
        tui.requestRender(true);
      }
      done(failure);
      return new Text("", 0, 0);
    });
    if (error) throw error;
    const edited = await readFile(path, "utf8");
    if (edited !== entry.raw) await store.edit(entry, edited);
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`${(error as Error).message}\nYour editor draft is preserved at ${path}.`);
  }
}
