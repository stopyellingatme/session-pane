# session-pane

A Claude Code mod that opens a dense side pane for the current session. The pane shows usage, the goal, tasks, PRs, activity and recent turns.

The mod is read-only and spends zero model tokens. It never calls `$.model.*`, `$.prompt.submit` or `$.agent.spawn`. Every hook passes its event on unchanged.

```text
Usage 1h 4m · $3.12 ─────────────────────────
Context  ██████████░░░░░░ 62% 124k / 200k
5-hour   ████░░░░░░░░░░░░ 23% resets 3:00 PM
7-day    ██████████░░░░░░ 61% resets Mon 9:00 AM
Tokens   41k in · 18k out · cache 2.1M r / 96k w
Agents   12k in · 4k out · cache 380k r / 22k w
Session ─────────────────────────────────────
Now      ● Working · 1m 12s · +1 background
         Adding the retry policy
         Run the billing tests
Goal     All billing tests pass and the PRs are open.
Initial  Refactor the billing module so invoices are
         made per customer.
Tasks 2/4 ───────────────────────────────────
✓ Split invoice code
◐ Add retry policy
○ Update tests
PRs ─────────────────────────────────────────
#42 Split invoices per customer
open · review required · checks: pass
Opened   #43 #44
Activity ────────────────────────────────────
Files changed 7 files · 12 edits
  src/billing/ 3 files ×7
  test/billing/ 2 files ×3
Recent commands 18 run · 2 failed
  ✓ Run the billing tests
  ✗ Type-check the project
Timeline 6 turns ────────────────────────────
2:41 PM  Now add retries to the payment client
         → Added a retry policy with backoff.
         3m 2s · 4 edits · 3 commands
```

## Sections

Sections with nothing to show are left out. The live sections come first, so a short pane still shows them.

| Section | Shows |
| :- | :- |
| **Usage** | The session length and cost in the title row. Context and each plan limit with a bar (green below 50%, yellow to 80%, red above 80%) and the reset time. Tokens for the main conversation and, when they ran, for subagents. |
| **Session** | **Now:** working (time, the in-progress task, what Claude says it does, its latest tool call), background (shells or monitors still run), or idle with the last turn's time and tokens. **Goal:** what the session works toward now. **Initial:** what the session started with. This row shows only when it differs from Goal. |
| **Tasks** | Claude's task list with a done/total count. A list of more than 8 tasks folds its finished tasks into one row. |
| **PRs** | The current branch's PR with its state, review decision and checks. Then the PRs opened this session as links. The section shows 6 PRs at most: the branch PR, then the latest opened ones. |
| **Activity** | Changed files summed by folder. The last 5 commands by Claude's plain-words description, with the run and failed counts. Background shells and monitors with the last line of their output. Running subagents. |
| **Timeline** | The 5 latest turns, newest first: the prompt, the first sentence of the answer, the time taken, and the edits and commands. |

### How the goal is chosen

The goal is worked out in `hooks/goal.ts` without a model.

- A `/goal` condition, or a goal that Claude proposes, holds while it is set.
- Otherwise the newer of the approved plan and the latest real request wins. A real request is not a slash command, a notification or a short reply such as "yes, do it".
- With no request yet, the "Primary request and intent" of a compaction summary stands in. Then the session title stands in.

The initial goal is the first real request of the session. It is kept apart from the turn history, so it stays after old turns drop out. After a compaction, the summary's stated request stands in for it.

## Install

You need Claude Code 2.1.287 or later in a terminal. For the PRs section, you also need `gh`, signed in.

Run these commands on each machine:

```sh
claude plugin marketplace add stopyellingatme/session-pane
claude plugin install session-pane@session-pane
```

Then, in a session, run `/session-pane` to open or close the pane. If a session was open during the install, run `/reload-plugins` in it first.

To update, run `claude plugin marketplace update session-pane`, then `claude plugin update session-pane@session-pane`, then restart Claude Code. An installed copy changes only when the `version` in `.claude-plugin/plugin.json` changes.

### If the mod does not load

Managed settings can block mods that a user installs. Examples are `allowManagedModsOnly`, `allowManagedHooksOnly` and `disableAllHooks`. You cannot override these settings from user settings. To find the cause, run `claude --debug` and read the mod lines in the debug log. Refer to [Check whether mods can load](https://code.claude.com/docs/en/plugins/mods/troubleshoot#check-whether-mods-can-load).

## Behavior

- `/session-pane` is registered with `immediate: true`, so it also works while Claude is in a turn.
- The pane opens only on `/session-pane`. It does not open by itself at session start.
- Usage refreshes on `session.measure`, after each turn. No timer runs for it.
- The PR check runs `gh pr view` every 60 seconds while the pane is open. It also runs after each Bash call that runs `git push` or `gh pr`.
- Background output is read with `tail -c 4096` every 3 seconds while the pane is open.
- Session data lives in `$.state`. It stays after a module reload, and resets on `/clear`, `/resume` and `/branch`. After `/resume`, the timeline and the initial goal are rebuilt from the transcript.
- The terminal and the Desktop Code tab draw the pane. The VS Code chat panel and `claude -p` draw nothing.

## Develop

Load the mod from a clone, with no install:

```sh
claude --plugin-dir /path/to/session-pane
```

When Claude Code loads the mod this way, it writes the engine type declarations into `.claude-plugin/types/`. Git ignores that directory. `tsconfig.json` extends it, so type-checking works only after the first load.

```sh
claude plugin test .              # the tests in hooks/register.test.ts
claude plugin validate --strict . # the manifest, the marketplace and the hooks
```

| File | Holds |
| :- | :- |
| `hooks/register.ts` | The state, the hooks and the pane |
| `hooks/goal.ts` | The goal rules, as pure functions |
| `hooks/register.test.ts` | Tests that draw each section from fixture events |
| `types/index.d.ts` | The `$.state` declarations |
| `.claude-plugin/plugin.json` | The plugin manifest |
| `.claude-plugin/marketplace.json` | The one-plugin marketplace that the install uses |

## References

[Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) · [Interface](https://code.claude.com/docs/en/plugins/mods/interface) · [Events](https://code.claude.com/docs/en/plugins/mods/events) · [API](https://code.claude.com/docs/en/plugins/mods/api) · [Reference](https://code.claude.com/docs/en/plugins/mods/reference)
