# My Pi Memory

> This is 100% vibe-coded and still under experimentation.
> In fact, the only part I read is this block that I am writing.
> Use at your own account. If you like and you're reading this message, fork because I may delete this if I don't like using it.
> not on npm yet.
> ~ Leo


User-reviewed project memories and global preferences for Pi. Two model tools propose and recall memories; only you approve them.

## Try it

Requires Node.js 22+, Git, and Pi 1.x. The initial runtime targets Linux/macOS filesystems and terminals.

```sh
npm ci
pi -e ./index.ts
```

To load it in every project, install the package by its absolute directory:

```sh
pi install /absolute/path/to/my-pi-memory
```

Ask Pi to remember a stable preference or project decision. It can call `memory_write`, which saves a candidate and quietly notifies you. Approval is never automatic.

## Commands

| Command | Behavior |
|---|---|
| `/memory review` | Review pending candidates: add locally, promote globally, forget, skip, or edit. |
| `/memory review skipped` | Revisit deferred candidates. |
| `/memory manage` | Choose local/global scope, browse/search, edit, delete, promote, or demote. |
| `/memory manage search text` | Start management with a search filter. |
| `/memory status` | Show resolved paths, counts, availability, and storage warnings. |

Review and management use Pi's interactive terminal dialogs. Escape closes without approving anything. Forget/delete require confirmation and permanently delete the file. Skipped candidates stay queued but are omitted from normal review.

On startup, a nonzero candidate count produces a short notice pointing to `/memory review`. The count includes skipped candidates and candidates from other projects.

### External editor

Choose **Edit in $EDITOR** while reviewing or managing. The plugin prefers `$VISUAL`, then `$EDITOR`, and suspends Pi's terminal while the editor runs.

```sh
export EDITOR='nvim'
# GUI editors must wait until editing finishes:
export VISUAL='code --wait'
```

Executable arguments and quoted paths work; shell pipelines/operators do not. Set one of these variables before launching Pi.

Editing uses a temporary draft. On successful exit, validated changes replace the original atomically. Invalid metadata, failed editors, or concurrent changes leave the original untouched and report the saved draft's recovery path. You may edit the title, description, and Markdown body, but not IDs or lifecycle metadata.

## Global configuration

Edit `~/.pi/agent/memory.json`:

```json
{
  "globalRoot": "~/.pi/agent/memory",
  "gitExclude": true
}
```

Both keys are optional. Config is global only; project configuration is not loaded.

- `globalRoot`: candidate/global storage root. Relative paths resolve from the Pi agent directory; `~` expands to the home directory.
- `gitExclude`: defaults to `true`. Manage only the plugin's marked entry in Git's resolved exclude file, never `.gitignore`. Set it to `false` to remove that entry and optionally version local memories. User-written exclusions remain untouched; already tracked files remain tracked.
- If `PI_CODING_AGENT_DIR` is set, it replaces `~/.pi/agent` for both config and the default global root.

Config is read for each operation. Reload Pi after changing the Git exclusion preference so it is applied at startup.

## Plain-file storage

```text
~/.pi/agent/memory/
  candidates/                         # pending and skipped candidates
  approved/                           # approved global memories

<main-worktree-root>/.pi/agent/memory/  # approved local memories
```

Every memory is an ID-named `.md` file with a YAML header and Markdown body:

```markdown
---
version: 1
id: 9e8854eb-4868-4e67-9ab6-afed9df085cc
created: 2026-01-01T00:00:00.000Z
updated: 2026-01-01T00:00:00.000Z
state: approved
title: Test command
description: How to run this project's tests
---

Run npm test before finishing changes.
```

Candidates also have `projectRoot` and `suggestedScope` metadata. Their local approval targets the recorded project, never silently the project where review happens. If that destination is missing, keep the candidate or approve globally.

Promotion moves a local memory to global without retaining repository-origin metadata. **Demote to this project** explicitly moves a global memory into the current project's store. There is no origin registry, historical demotion destination, or repository-ID file.

Approved local files travel with the project and can be versioned in Git when exclusion is disabled. Global files can be versioned through your dotfiles; the plugin does not manage versioning. Outside Git, the current working directory is the local root.

### Worktrees

All worktrees use the main worktree's memory directory, resolved through Git metadata. A copied directory in a linked worktree is ignored rather than merged. This prevents duplicate or stale memories from bloating recall.

Git metadata and the main store must be accessible. A broken/unmounted Git metadata path produces an explicit error, not a second local store. If Git can identify an inaccessible main worktree, local recall reports a warning while global recall can still work.

## Tools

- `memory_write({ title, description, body, scope? })`: durably save an unapproved candidate. `scope` is only a suggestion (`local` or `global`). Exact duplicates in the project's candidates/local memories or global approved memories are suppressed.
- `recall({ query, scope?, limit? })`: search approved memories. Scope defaults to `both`; limit defaults to 5 and is capped at 10. Titles rank above descriptions and body text. Matching ignores case and accents.

Recall labels scopes, deduplicates IDs, and returns at most 2,000 characters of each memory body plus its full path. Model-facing text is further bounded to 16 KB/300 lines; use a narrower query or read the returned approved file for full text. Candidates are never returned.

Pi receives only short tool guidelines, not an automatically injected memory dump. There are no background extraction model calls: writing saves a candidate during the tool call, and review happens later.

Approved local files may be found by grep. Recall adds convenience and approval filtering, not exclusive access or a security boundary. Memory text is reference data, not trusted instructions. Do not propose secrets or temporary details; the plugin cannot guarantee sensitive-data detection.

## Usage statistics

The plugin keeps an aggregate log at `~/.pi/agent/memory-usage.json`, respecting `PI_CODING_AGENT_DIR`. This path stays in the Pi agent directory even when `globalRoot` is overridden.

```json
{
  "9e8854eb-4868-4e67-9ab6-afed9df085cc": {
    "accessCount": 12,
    "lastAccess": "2026-07-17T14:30:00.000Z",
    "recentScore": 3.8
  }
}
```

- Count each memory ID once per recall result set, after search limits and deduplication. Candidates, unmatched/scanned files, direct filesystem reads, and UI browsing do not count. No-result recalls do not create/update the log.
- Both local and global memories use the same ID-keyed log. Promotion/demotion keeps their history; deleting a memory does not erase its aggregate statistics.
- The log contains only IDs, counts, timestamps, and scores—not memory contents, titles, queries, or repository paths. It is not an append-only event history.
- `recentScore` is saved at `lastAccess`. Its half-life is fixed at **30 days**:

```text
scoreOnAccess = savedScore × 0.5^(elapsedDays / 30) + 1
scoreNow      = savedScore × 0.5^(elapsedDays / 30)
```

No timer is needed. `/memory manage` displays the current decayed score, access count, and last access on approved-memory cards without writing/counting a new access. `/memory status` shows the log path and reports malformed logs. Scores do **not** affect recall ranking or enter the model's memory results.

Log updates use atomic writes and cross-process locks. Logging failures do not fail recall; interactive Pi warns once per extension runtime. Corrupt logs remain untouched—repair/remove the file to resume tracking. Recall is declared non-read-only and non-idempotent because it now updates statistics, but it never changes approved memories.

Persist the Pi agent directory or this log separately if you want container usage statistics to survive; mounting only `globalRoot` does not include the log.

## Containers

No container detection, mount inspection, or persistence blocking is performed.

- Mounting the **main project** carries approved local memories.
- Optionally mount the host global memory root at a fixed container path, such as `/memory`, and set the container's global config to `{ "globalRoot": "/memory" }`.
- Without that mount, candidates/global memories use the container's own home, even if ephemeral. This is allowed; persist its directory/volume if you want to keep them.
- A read-only global mount permits recall; mutations fail with the actual filesystem error.
- Mounting only a linked worktree does not necessarily include Git metadata or the main memory store.
- Candidate destinations are absolute paths. To approve the same queued candidates locally from host and container, expose their project at the same absolute path. Automatic host/container path translation is deliberately not implemented.
- Mounting the whole global root exposes all its files to the container. Scope filtering does not isolate them from other filesystem tools.

**"Queued" means saved on the configured filesystem.** It does not promise survival after deleting the container or volume.

## Reliability and limits

- Asynchronous filesystem writes, atomic replacement, file/directory sync, and directory-level cross-process locks protect plugin mutations.
- Orderly shutdown waits for in-flight writing/command operations.
- Cross-store moves save the destination before removing the source. If interrupted after copying, retry the same action; a conflicting destination is never overwritten. Recall deduplicates IDs during this temporary overlap.
- External changes are checked before applying a mutation. Reopen a memory if another session changed it. Editors outside the plugin do not honor plugin locks.
- Malformed files are skipped with warnings rather than hiding valid memories; `/memory status` reports details.
- Limits: 200-character titles, 500-character descriptions, 20,000-character bodies, and 64 KiB record files.
- No embeddings, sync daemon, automatic repository linking, history system, or background extractor in v1.

## Development

```sh
npm run check
npm test
```

Tests cover real Git worktrees, separate-process writes, storage lifecycles/conflicts, lexical recall, actual Pi extension loading, scripted review/manage dialogs, and real editor subprocesses. See `NOTE.md` for the agreed design and implementation verification.
