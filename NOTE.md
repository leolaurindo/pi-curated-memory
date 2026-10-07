# Pi memory plugin design

Build a memory plugin inspired by [`inspiration/packages/pi-memory`](inspiration/packages/pi-memory), with a deliberately user-led review and recall workflow.

## Agreed storage and configuration

Use readable Markdown files with a small metadata header, not SQLite. Users can edit files externally and version global storage through dotfiles.

```text
~/.pi/agent/memory.json        # global plugin configuration only
~/.pi/agent/memory-usage.json  # aggregate recall statistics, keyed by memory ID
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

## Usage statistics

- Keep one global aggregate JSON log at `~/.pi/agent/memory-usage.json`, respecting `PI_CODING_AGENT_DIR`, independently of the configured memory storage root.
- Per ID, record `accessCount`, `lastAccess`, and `recentScore`. Count each returned memory once per recall after limits/deduplication, regardless of local/global scope; preserve history across promotion/demotion.
- Do not count candidates, scanned/unmatched files, direct reads, or browsing. No-result calls do not update/create the log.
- Use exponential decay with a fixed 30-day half-life: on access, `savedScore * 0.5^(elapsedDays / 30) + 1`; on consultation, use the same decay without adding a point. Clamp elapsed time to nonnegative and keep last-access timestamps monotonic.
- The saved score is anchored at `lastAccess`; no periodic worker is needed. Show its current decayed value on approved-memory cards and the log path in status.
- Store only IDs and numeric/time statistics, not titles, bodies, queries, paths, or a full event history. Preserve aggregate records when a memory is deleted.
- Do not use statistics for ranking or inject them into model results/prompts.
- Atomic writes and cross-process locking protect increments. Failed logging must not fail recall; warn once per interactive extension runtime. Preserve malformed files instead of silently resetting them.
- Recall is no longer declared read-only/idempotent because of these bookkeeping writes; approved memories remain unchanged.

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

Feature sequence (implemented):
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
- Tools implemented: `memory_write` persists unapproved candidates and suppresses exact duplicates; `recall` searches only approved stores, ranks metadata above body matches, deduplicates IDs, and bounds returned text.
- Small prompt guidance uses Pi's native tool `promptGuidelines`, rather than replacing the system prompt. Candidate tool rendering and notifications do not expose the proposed text.
- Startup notices count pending and skipped candidates; orderly shutdown waits for in-flight writing-tool operations.
- Verification: `npm run check` and 13 tests pass, including loading the actual extension through Pi's extension loader and invoking both tools.
- Review/manage/status commands implemented with built-in dialogs, explicit deletion confirmation, pending/skipped separation, separate approved scopes, and promotion/demotion to the current project.
- External editing launches `$VISUAL` or `$EDITOR` safely with arguments, suspends/restores Pi's terminal, and edits a temporary draft. Valid changes are atomically applied; invalid/conflicting drafts are retained with a recovery path and the original remains unchanged. Protected lifecycle metadata is not editable through this action.
- Review/manage require TUI mode; status is available without a TUI. Editor commands require `$VISUAL` or `$EDITOR` and do not accept shell pipelines.
- Verification: `npm run check` and 19 tests pass. Dialog tests use scripted UI fixtures with real stores; editor tests launch real subprocesses.
- Worktree hardening: missing/broken Git metadata now fails explicitly rather than silently treating a linked worktree as an independent non-Git project. Its regression test was observed failing before the fix and passing afterward.
- Malformed candidates are reported/skipped without blocking new candidate capture. The regression test was observed failing before removing that unnecessary write-time block and passing afterward. Missing candidate destinations retain their candidate and still permit global approval.

### V1 verification and remaining boundaries

- `npm run check`: passed.
- `npm test`: all 21 tests passed. Coverage includes bounded recall text and failed writes producing no success notice.
- `npm pack --dry-run`: passed; the package includes the extension, source modules, and README, not inspiration/test fixtures.
- Native Pi TUI smoke check passed in an isolated pseudo-terminal: startup notice, candidate review, actual external editor launch/reload, local approval, status, and orderly exit. No model request or real-user configuration changes were needed.
- Initial v1 size: 689 production TypeScript lines; 462 test/helper lines (including blank lines).
- Usage/configuration and reliability boundaries are documented in `README.md`.
- Candidate destinations are absolute paths: host/container local approval requires that project path to be accessible. There is no automatic host/container translation. Approved global memories have no such origin dependency.
- Initial runtime is verified on Linux; macOS/Windows and an actual Docker deployment are not verified. The plain-file storage itself remains portable.
- Locking coordinates plugin mutations, not arbitrary external writers. Cross-store moves are copy-before-delete and retryable, not a single cross-filesystem transaction; temporary duplicates are deduplicated during recall.
- No separate extraction worker was built: the accepted writing-tool design replaces it. Built-in dialogs replace a bespoke flash-card component. External edits use validated temporary drafts rather than exposing the authoritative file to incomplete editor saves.

### Usage tracking follow-up

- Implemented ID-keyed aggregate logging, access-time and read-time exponential decay, and best-effort integration into recall after limits/ID deduplication. No ranking change or extra model calls.
- Management cards show current usage statistics without counting browsing; status shows the log path and parse errors. This is a small UI addition so the decayed score can be inspected without interpreting the saved timestamp manually.
- No new configuration keys/dependencies or background worker. The log stays beside global Pi config, not inside `globalRoot`; container persistence must include this separate path if desired.
- Validation: `npm run check` and all 29 tests pass. Focused tests cover half-life math, monotonic timestamps, exact per-call counts, separate-process increments, corrupt-log preservation, result limits/deduplication, promotion continuity, and nonfatal logging failures. Management tests confirm browsing displays decayed scores without rewriting/counting usage.
- Native Pi PTY smoke check passed with the usage statistics shown on an approved-memory card, alongside review, external editing, approval, status, and orderly exit. All checks used isolated directories, not real user memories.
- The installed local package needs only `/reload` to load this update. No installation/settings changes were made for this feature.

Update this section with important design changes and verification evidence as work continues.

## Alternatives rejected

- All memories outside the project: unnecessary repository-ID/mount complexity and weaker project portability.
- SQLite: not the desired editable/versionable plain-file model.
- Exclusive recall access by hiding approved local memories: unnecessary; grep access is acceptable.
- Container detection and blocking ephemeral writes: brittle plumbing that takes persistence choices away from the user.
- Historical origin-based demotion: unnecessary; demote explicitly to the current project instead.
- Separate background model extraction: replaced by the writing tool and durable asynchronous filesystem writes.
