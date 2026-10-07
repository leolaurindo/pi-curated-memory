# Pi memory plugin design

Build a memory plugin inspired by [`inspiration/packages/pi-memory`](inspiration/packages/pi-memory), with a deliberately user-led review and recall workflow.

## Agreed storage and configuration

Use readable Markdown files with a small metadata header, not SQLite. Users can edit files externally and version global storage through dotfiles.

```text
~/.pi/agent/memory.json  # global plugin configuration only
~/.pi/agent/memory/
  candidates/          # pending and skipped candidates from all projects
  approved/            # approved global memories

<main-worktree-root>/.pi/agent/memory/
                       # approved local memories, shared across worktrees
```

- Configuration is global, never project-specific. Allow a global storage-path override.
- Candidates stay outside project greps. Approved local memories travel with the project and may be versioned in project Git if the user wants.
- Global and local approved memories are physically separate stores.
- Candidate approval moves the candidate into its intended local project or the global store, according to the user's action.
- Candidates record their intended local destination; reviewing one from another project must not silently approve it there.
- Global approved memories do not need originating-repository metadata or a repository-location registry.
- Promote moves a local memory to global. **Demote to this project** moves a global memory into the project where the user currently is, not its historical origin.
- Outside Git, use the current working directory as the local root.

## Worktrees

- All worktrees of one Git repository share one authoritative local memory store in the main worktree.
- Resolve it through Git metadata; no generated repository-ID file is needed for v1.
- Ignore memory directories copied into linked worktrees; do not merge them or return duplicate memories.
- Recall and writes, including demotion, target the shared main-worktree store.
- If only a linked worktree is mounted into a container and the main store is inaccessible, report that limitation. Do not silently create a second store.

## Model tools and instructions

Provide exactly two model-facing tools:

- `memory_write`: propose a candidate, optionally suggesting local/global scope. It never approves a memory.
- `recall`: search approved local and global memories, never candidates.

Use a very small system instruction:

> Use `recall` for project memories and user preferences when relevant. Use `memory_write` to propose durable project knowledge or user preferences, especially when the user explicitly asks you to remember something or corrects you. Writing queues a candidate for user review; it does not approve it.

- The writing tool replaces a separate background model extractor. No extra model calls or extraction worker are needed.
- Persist candidates with asynchronous filesystem operations during the tool call; user review remains deferred. This deliberately replaces the initial idea of a fully background extraction/storage queue with a simpler durable tool call.
- Notify briefly only after successful persistence, without exposing candidate text. Never acknowledge an in-memory-only candidate.
- "Queued" means saved to the configured filesystem, not guaranteed to survive deletion of a container or volume.
- Finish pending writes on orderly shutdown; there is no unfinished background extraction to cancel.
- Prefer simple cross-process locking and atomic durable writes. Cross-store moves must write the destination before removing the source and be retryable without data loss.
- Avoid storing raw tool output, secrets, speculation, or temporary task details. Extraction guidance is not a guarantee of sensitive-data detection.

## Recall

- Search short titles and descriptions first using normalized lexical matching, with body text as a fallback.
- Return bounded results with visible local/global scope. Do not automatically inject memory text into the conversation.
- Keep retrieval replaceable; do not start with embeddings.
- Ordinary grep may find approved local memories. This is fine: recall is a focused interface, not exclusive access or a security boundary.
- Deduplicate results by memory ID to avoid context bloat after interrupted moves.

## User commands and UI

Use built-in Pi dialogs first, rather than a bespoke terminal UI.

- `/memory review`: compact card-style review with **add locally**, **forget**, **skip**, **promote globally**, and **edit**.
- `/memory review skipped`: explicitly revisit skipped candidates; omit them from the default review pass.
- `/memory manage`: browse/search approved local and global memories with visibly separate scopes; edit, delete, promote, or demote to this project.
- `/memory status`: display resolved configuration/storage paths and availability for troubleshooting.
- On startup, show an unobtrusive notice only when candidates exist:
  > There are 12 memory candidates. Type `/memory review` to see them.
- Count pending and skipped candidates in the notice; review can expose the skipped count/filter.
- External editing uses `$VISUAL`, then `$EDITOR`; wait for exit and reload/validate the edited file.
- Forget/delete permanently removes the file after confirmation. No elaborate history/undo system in v1.
- Escape closes an interaction without approving anything.
- Approval, promotion, demotion, and deletion are user commands/actions, not model tools. Never approve globally without an explicit user action.

## Git exclusion preference

- A global JSON boolean preference controls Git exclusion; default **on**.
- When enabled, manage the plugin's own exclude entry for `/.pi/agent/memory/` through Git's resolved exclude path, including worktrees.
- Preserve user entries and never modify `.gitignore`.
- Disable exclusion to version local memories. Exclusion does not untrack files already committed.
- Outside Git, silently do nothing.

## Containers and sandboxes

Allow ephemeral storage; do not detect containers, inspect mounts, or block capture based on guessed persistence.

- Resolve the global default inside Pi's environment; create storage directories when writing and report actual filesystem errors.
- The user can mount their host global memory root at a fixed container path and configure that path to share candidates/global memories.
- Without that mount, candidates and global memories use the container's own home, even if ephemeral. Do not migrate them to the host automatically.
- Mounting the main project carries local approved memories; mounting only a linked worktree does not necessarily carry the shared store.
- Document that storage lasts only as long as its directory/volume. Users choose which directories to persist.
- Mounting the whole global root exposes all its files to the container. Recall's scope filtering is not access control.
- No per-repository mounting or manual ID management.

## Implementation follow-up

Implementation is authorized. Make focused commits per feature so the history is easy to follow.

Suggested sequence:
1. Storage/configuration, Markdown records, Git/worktree resolution, locking, and lifecycle tests.
2. Writing/recall tools, bounded retrieval, startup notices, and small prompt guidance.
3. Review/manage/status commands and external editor integration.
4. Documentation and end-to-end validation.

### Progress

- Storage foundation implemented: global `memory.json` config, YAML-header Markdown records, durable atomic writes, directory-level cross-process locks, exact duplicate suppression, safe edits/deletes, and retryable copy-before-delete moves.
- Git/worktree resolution uses the main worktree's local store. Git exclusion is preference-controlled and preserves user entries.
- Candidates retain only their intended local destination; approved globals have no origin metadata.
- Verification: `npm run check` and 10 storage/project tests pass, including real Git worktrees and concurrent writes from separate Node processes.
- Config defaults honor `PI_CODING_AGENT_DIR` when set; otherwise use `~/.pi/agent`. Relative storage overrides resolve from that agent directory.

Update this section as implementation progresses. Record important deviations and verification evidence.

## Alternatives rejected

- All memories outside the project: unnecessary repository-ID/mount complexity and weaker project portability.
- SQLite: not the desired editable/versionable plain-file model.
- Exclusive recall access by hiding approved local memories: unnecessary; grep access is acceptable.
- Container detection and blocking ephemeral writes: brittle plumbing that takes persistence choices away from the user.
- Historical origin-based demotion: unnecessary; demote explicitly to the current project instead.
- Separate background model extraction: replaced by the writing tool and durable asynchronous filesystem writes.
