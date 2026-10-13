import type {
  EngineInterface,
  On,
  RenderNode,
  SessionContextUsage,
  SessionCost,
  SessionPanePr,
  SessionPaneShell,
  SessionPaneTokens,
  SessionPaneTurnRecord,
  SessionPaneUsage,
  SessionRateLimit,
  ToolCallInput,
  TurnUsage,
} from 'claude-code'
import { atom, read, update } from 'claude-code'
import {
  CONTINUED,
  GOAL_SYSTEM,
  NO_PROMPT,
  briefOf,
  goalOf,
  goalRecordOf,
  goalReplyOf,
  intentOf,
  isAsk,
  isContinuation,
  noteOf,
  startOf,
} from './goal'

// Read-only: every hook passes its event on unchanged, and nothing here submits
// a prompt or spawns an agent. The one model call is a small completion that
// names the goal after each new request.

const PANE = 'session-pane'
const PANE_COLUMNS = 48
const LABEL_WIDTH = 9
// Section titles use Claude Code's own accent, so they follow the theme
const ACCENT = 'claude'
const MAX_COMMANDS = 5
// More are kept than shown, since a command running in the background shows
// under Background instead
const KEPT_COMMANDS = 10
// The branch PR and the PRs opened this session, together
const MAX_PRS = 6
// A longer task list folds its finished tasks into one row
const MAX_TASKS = 8
const PR_POLL_MS = 60_000
const TICK_MS = 1000
const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup'
const PUSH_OR_PR = /\bgit\s+push\b|\bgh\s+pr\b/
const PR_CREATE = /\bgh\s+pr\s+create\b/
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/
const FAILED_CHECKS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED_CHECKS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const ENDED_AGENTS = new Set(['completed', 'failed', 'killed'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
const MAX_TIMELINE = 50
// The goal is named by a small, fast model, with no tools and no history
const GOAL_MODEL = 'haiku'
const GOAL_MAX_TOKENS = 100
const GOAL_TIMEOUT_MS = 20_000
// The starting request is cut to about three lines of the pane
const START_CHARS = 110
// Prompts are kept long enough to show whole as the goal, and cut shorter in
// the timeline
const MAX_PROMPT = 4000
const TIMELINE_PROMPT = 160
// The timeline shows the latest turns; more are kept for the goal and totals
const TIMELINE_ENTRIES = 5
const MAX_OUTCOME = 200
// Ended background shells stay in the list for a while, the latest few
const MAX_ENDED_SHELLS = 3
const MAX_FILE_GROUPS = 4
const OUTPUT_POLL_MS = 3000
const OUTPUT_TAIL_BYTES = '4096'
const NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g
const OUTPUT_FILE = /(\/\S+\/tasks\/[^\s/]+\.output)\b/
const ENDED_SHELLS = new Set(['completed', 'failed', 'killed'])
// Colors and escape sequences a command writes to its terminal
const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007]*\u0007/g

const ZERO: SessionPaneTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const usage = atom({ plugin: 'session-pane', key: 'usage' } as const, null)
const tokens = atom({ plugin: 'session-pane', key: 'tokens' } as const, { main: ZERO, subagents: ZERO })
const turn = atom({ plugin: 'session-pane', key: 'turn' } as const, null)
const lastTurn = atom({ plugin: 'session-pane', key: 'lastTurn' } as const, null)
const files = atom({ plugin: 'session-pane', key: 'files' } as const, [])
const commands = atom({ plugin: 'session-pane', key: 'commands' } as const, [])
const agents = atom({ plugin: 'session-pane', key: 'agents' } as const, [])
const pr = atom({ plugin: 'session-pane', key: 'pr' } as const, { kind: 'pending' })
const createdPrs = atom({ plugin: 'session-pane', key: 'createdPrs' } as const, [])
const tasks = atom({ plugin: 'session-pane', key: 'tasks' } as const, [])
const title = atom({ plugin: 'session-pane', key: 'title' } as const, null)
const goal = atom({ plugin: 'session-pane', key: 'goal' } as const, null)
const plan = atom({ plugin: 'session-pane', key: 'plan' } as const, null)
const intent = atom({ plugin: 'session-pane', key: 'intent' } as const, null)
const start = atom({ plugin: 'session-pane', key: 'start' } as const, null)
const named = atom({ plugin: 'session-pane', key: 'named' } as const, null)
const action = atom({ plugin: 'session-pane', key: 'action' } as const, null)
const note = atom({ plugin: 'session-pane', key: 'note' } as const, null)
const planAt = atom({ plugin: 'session-pane', key: 'planAt' } as const, null)
const timeline = atom({ plugin: 'session-pane', key: 'timeline' } as const, [])
const startedAt = atom({ plugin: 'session-pane', key: 'startedAt' } as const, null)
const shells = atom({ plugin: 'session-pane', key: 'shells' } as const, [])
const totals = atom({ plugin: 'session-pane', key: 'totals' } as const, {
  turns: 0,
  edits: 0,
  commands: 0,
  failed: 0,
  subagents: 0,
})

// Module state that may be lost on reload; session.start rebuilds it.
let cwd = ''
let isPaneOpen = false
let isPrLoading = false
let isOutputLoading = false
const seenAgents = new Set<string>()
// Only the latest goal request counts: a newer one aborts the one before
let goalRun = 0
let goalStop: AbortController | null = null
// A model the engine refuses to call stays refused, so the rules name the goal
let isGoalModelOff = false

type Measured = { context: SessionContextUsage; rateLimits: readonly SessionRateLimit[]; cost?: SessionCost }

function usageOf(measured: Measured): SessionPaneUsage {
  return {
    context: {
      tokens: measured.context.tokens ?? null,
      window: measured.context.window,
      percent: measured.context.percent ?? null,
    },
    rateLimits: measured.rateLimits.map(limit => ({
      kind: limit.kind,
      percentUsed: limit.percentUsed,
      resetsAt: limit.resetsAt ?? null,
    })),
    costUsd: measured.cost?.usd ?? null,
  }
}

function addUsage(total: SessionPaneTokens, used: TurnUsage): SessionPaneTokens {
  return {
    input: total.input + used.input_tokens,
    output: total.output + used.output_tokens,
    cacheRead: total.cacheRead + used.cache_read_input_tokens,
    cacheWrite: total.cacheWrite + used.cache_creation_input_tokens,
  }
}

function relativePath(path: string): string {
  return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

function firstLine(command: string): string {
  const lines = command.trim().split('\n')
  return lines.length > 1 ? lines[0] + ' …' : (lines[0] ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function checksOf(rollup: unknown): 'pass' | 'fail' | 'pending' | 'none' {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none'
  let isPending = false
  for (const check of rollup) {
    if (!isRecord(check)) continue
    // A CheckRun reports status and conclusion; a StatusContext reports state
    const outcome = String(check.conclusion || check.state || '').toUpperCase()
    if (FAILED_CHECKS.has(outcome)) return 'fail'
    if (!PASSED_CHECKS.has(outcome)) isPending = true
  }
  return isPending ? 'pending' : 'pass'
}

function noPrReason(stderr: string): string {
  const text = stderr.trim()
  const branch = /no pull requests found for branch "([^"]+)"/.exec(text)
  if (branch) return 'No PR for branch ' + branch[1]
  if (/gh auth login|not logged in/i.test(text)) return 'gh is not signed in (run gh auth login)'
  if (/not a git repository/i.test(text)) return 'Not a git repository'
  if (/could not determine current branch|detached/i.test(text)) return 'No current branch'
  if (/no git remotes|none of the git remotes/i.test(text)) return 'No GitHub remote'
  return text.split('\n')[0] || 'gh pr view failed'
}

function prOf(stdout: string): SessionPanePr {
  const view: unknown = JSON.parse(stdout)
  if (!isRecord(view)) return { kind: 'none', reason: 'gh pr view returned no PR' }
  return {
    kind: 'pr',
    number: Number(view.number),
    title: String(view.title ?? ''),
    url: String(view.url ?? ''),
    state: String(view.state ?? ''),
    isDraft: view.isDraft === true,
    reviewDecision: String(view.reviewDecision ?? ''),
    checks: checksOf(view.statusCheckRollup),
  }
}

// The repository a PR URL points into, as `owner/name`, on any host
function repoOf(url: string): string {
  const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\//.exec(url)
  return match ? match[1] + '/' + match[2] : url
}

function createdPrOf(command: string, record: unknown, text: string | undefined): { number: number; url: string } | null {
  const operation = isRecord(record) && isRecord(record.gitOperation) ? record.gitOperation.pr : null
  if (isRecord(operation) && operation.action === 'created' && typeof operation.url === 'string') {
    return { number: Number(operation.number), url: operation.url }
  }
  if (!PR_CREATE.test(command)) return null
  const match = PR_URL.exec(text ?? '')
  return match ? { number: Number(match[1]), url: match[0] } : null
}

async function loadUsage($: EngineInterface) {
  const measured = await $.session.usage()
  await update($, usage, () => usageOf(measured))
  await update($, startedAt, () => measured.startedAt)
}

async function loadPr($: EngineInterface): Promise<SessionPanePr> {
  if (!(await $.session.repo())) return { kind: 'none', reason: 'Not a git repository' }
  let run
  try {
    run = await $.process.run(['gh', 'pr', 'view', '--json', PR_FIELDS], { timeoutMs: 20_000 })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'none', reason: /ENOENT|not found|no such file/i.test(message) ? 'gh is not installed' : 'gh did not answer' }
  }
  if (run.exitCode !== 0) return { kind: 'none', reason: noPrReason(run.stderr) }
  try {
    return prOf(run.stdout)
  } catch {
    return { kind: 'none', reason: 'Could not read gh pr view output' }
  }
}

// Runs in the background, so it reports its own failures in the pane
async function refreshPr($: EngineInterface) {
  if (isPrLoading) return
  isPrLoading = true
  try {
    const next = await loadPr($).catch(
      (error: unknown): SessionPanePr => ({ kind: 'none', reason: 'PR check failed: ' + String(error) }),
    )
    await update($, pr, () => next)
  } catch {
    // The state write failed; the next refresh tries again
  } finally {
    isPrLoading = false
  }
}

// Runs in the background; a failed read leaves the last list in place
async function refreshAgents($: EngineInterface) {
  try {
    const list = await $.agent.list()
    for (const agent of list) seenAgents.add(agent.id)
    const running = list
      .filter(agent => !ENDED_AGENTS.has(agent.status))
      .map(agent => ({ id: agent.id, type: agent.type, description: agent.description, status: agent.status }))
    await update($, agents, () => running)
  } catch {
    // The next subagent event refreshes it again
  }
}

// Asks a small model for the goal the session works toward, from a record of
// its requests, plan and tasks. Runs in the background; on any failure the
// last named goal, or the rules in goal.ts, stay in place.
async function nameGoal($: EngineInterface) {
  if (isGoalModelOff) return
  const known = await read($, named)
  const record = goalRecordOf({
    title: await read($, title),
    start: (await read($, start))?.text,
    intent: await read($, intent),
    plan: await read($, plan),
    previous: known?.text,
    tasks: await read($, tasks),
    turns: await read($, timeline),
  })
  if (!record) return
  goalStop?.abort()
  const stop = new AbortController()
  goalStop = stop
  const run = ++goalRun
  try {
    const reply = await $.model.complete(
      { model: GOAL_MODEL, system: GOAL_SYSTEM, prompt: record, effort: 'low', maxTokens: GOAL_MAX_TOKENS, timeoutMs: GOAL_TIMEOUT_MS },
      { signal: stop.signal },
    )
    const text = reply.isAnswered ? goalReplyOf(reply.text) : null
    if (run !== goalRun || !text) return
    const at = await $.clock.now()
    await update($, named, () => ({ text, at }))
  } catch {
    // Only a request the engine refuses to send rejects, as for a blocked model
    isGoalModelOff = true
  }
}

// Adds a background shell, or replaces the one with the same id; ended ones
// past the latest few are dropped
async function addShell($: EngineInterface, shell: SessionPaneShell) {
  await update($, shells, list => keepShells([...list.filter(known => known.id !== shell.id), shell]))
}

function keepShells(list: readonly SessionPaneShell[]): SessionPaneShell[] {
  const ended = list.filter(shell => shell.status !== 'running').slice(-MAX_ENDED_SHELLS)
  return list.filter(shell => shell.status === 'running' || ended.includes(shell))
}

// Marks a background shell ended, and its command in Recent commands with it
async function endShell($: EngineInterface, id: string, status: 'completed' | 'failed' | 'killed', at: number) {
  const known = (await read($, shells)).find(shell => shell.id === id)
  if (!known) return
  await update($, shells, list =>
    keepShells(list.map(shell => (shell.id === id ? { ...shell, status, endedAt: shell.endedAt ?? at } : shell))),
  )
  const toolUseId = known.toolUseId
  if (toolUseId) {
    const done = status === 'completed' ? ('ok' as const) : ('failed' as const)
    await update($, commands, list => list.map(entry => (entry.id === toolUseId ? { ...entry, status: done } : entry)))
  }
}

// Each task a notification text reports ended, by id
function endedTasksOf(text: string): Map<string, 'completed' | 'failed' | 'killed'> {
  const ended = new Map<string, 'completed' | 'failed' | 'killed'>()
  for (const block of text.match(NOTIFICATION) ?? []) {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(block)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(block)?.[1]?.trim()
    if (id && (status === 'completed' || status === 'failed' || status === 'killed')) ended.set(id, status)
  }
  return ended
}

// Finds the background shells still running after a reload, which the pane did
// not see start: each background call in the transcript that no notification
// has ended, and whose output file is still there
async function loadShells($: EngineInterface) {
  if ((await read($, shells)).length > 0) return
  const rows = await $.session.messages()
  const ended = new Set<string>()
  for (const row of rows) if (row.role === 'user') for (const id of endedTasksOf(row.text).keys()) ended.add(id)
  const found: SessionPaneShell[] = []
  for (const row of rows) {
    for (const use of row.toolUses) {
      const record: unknown = use.result
      if (!isRecord(record)) continue
      const id = use.tool === 'Bash' ? record.backgroundTaskId : use.tool === 'Monitor' ? record.taskId : null
      if (typeof id !== 'string' || ended.has(id)) continue
      const outputFile = OUTPUT_FILE.exec(use.text ?? '')?.[1] ?? null
      if (outputFile && !(await $.fs.stat(outputFile).then(() => true, () => false))) continue
      const input = use.input
      const command = typeof input.command === 'string' ? firstLine(input.command) : null
      const described = typeof input.description === 'string' && input.description ? clip(input.description, 120) : null
      found.push({
        id,
        kind: use.tool === 'Monitor' ? 'monitor' : 'shell',
        label: described ?? command ?? id,
        command,
        toolUseId: use.tool_use_id,
        outputFile,
        startedAt: null,
        endedAt: null,
        status: 'running',
        lastLine: null,
      })
    }
  }
  if (found.length > 0) await update($, shells, list => keepShells([...list, ...found]))
}

// The last line a command wrote, as a terminal would show it: a progress bar
// redrawn with carriage returns reads as its latest state
function lastLineOf(output: string): string | null {
  const line = output
    .replace(ANSI, '')
    .split('\n')
    .map(part => (part.split('\r').filter(piece => piece.trim()).pop() ?? '').trim())
    .filter(Boolean)
    .pop()
  return line ? clip(line, 200) : null
}

// Reads the tail of each running shell's output file. Runs in the background;
// a failed read leaves the last line in place.
async function refreshOutput($: EngineInterface) {
  if (isOutputLoading) return
  isOutputLoading = true
  try {
    for (const shell of await read($, shells)) {
      if (shell.status !== 'running' || !shell.outputFile) continue
      const run = await $.process
        .run(['tail', '-c', OUTPUT_TAIL_BYTES, shell.outputFile], { timeoutMs: 5000 })
        .catch(() => null)
      if (!run || run.exitCode !== 0) continue
      const latest = lastLineOf(run.stdout)
      if (latest && latest !== shell.lastLine) {
        await update($, shells, list => list.map(known => (known.id === shell.id ? { ...known, lastLine: latest } : known)))
      }
    }
  } catch {
    // The next poll tries again
  } finally {
    isOutputLoading = false
  }
}

// The folder a changed file is summed under: its first two folders inside the
// working directory, or its own folder outside it. A file at the top stands alone.
function folderOf(path: string): string | null {
  const parts = path.split('/')
  if (parts.length === 1) return null
  if (path.startsWith('/')) return '…/' + parts[parts.length - 2] + '/'
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/') + '/'
}

// Changed files summed by folder, most edited first; a folder with one changed
// file is named by that file
function fileGroupsOf(list: readonly { path: string; edits: number }[]) {
  const groups = new Map<string, { name: string; files: number; edits: number }>()
  for (const file of list) {
    const key = folderOf(file.path) ?? file.path
    const group = groups.get(key)
    if (group) groups.set(key, { name: key, files: group.files + 1, edits: group.edits + file.edits })
    else groups.set(key, { name: file.path, files: 1, edits: file.edits })
  }
  return [...groups.values()].sort((a, b) => b.edits - a.edits || a.name.localeCompare(b.name))
}

function formatCount(n: number): string {
  if (n < 1000) return String(n)
  const [value, unit] = n < 1_000_000 ? [n / 1000, 'k'] : [n / 1_000_000, 'M']
  return (value < 10 ? value.toFixed(1) : value.toFixed(0)).replace(/\.0$/, '') + unit
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return seconds + 's'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's'
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm'
}

function formatReset(iso: string, now: number): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const isToday = at.toDateString() === new Date(now).toDateString()
  return 'resets ' + (isToday ? time : at.toLocaleDateString([], { weekday: 'short' }) + ' ' + time)
}

function limitName(kind: string): string {
  if (kind === 'five_hour') return '5-hour'
  if (kind === 'seven_day') return '7-day'
  if (kind === 'spend_limit') return 'Spend'
  return kind.replace(/_/g, ' ')
}

function levelColor(percent: number): 'error' | 'warning' | 'success' {
  if (percent > 80) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

function reviewName(decision: string): string {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes requested'
  if (decision === 'REVIEW_REQUIRED') return 'review required'
  return 'no review'
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function plural(count: number, word: string, tail = ''): string | null {
  return count === 0 ? null : count + ' ' + word + (count === 1 ? '' : 's') + tail
}

// Collapses whitespace and cuts long text to a few lines of the pane
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat
}

// A prompt as the user typed it: tagged blocks Claude Code adds are dropped,
// and a slash command reads as `/name args`
function promptOf(text: string): string {
  if (isContinuation(text)) return CONTINUED
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)
    return clip((command[1] ?? '') + (args?.[1] ? ' ' + args[1] : ''), MAX_PROMPT)
  }
  return clip(text.replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, ''), MAX_PROMPT)
}

// The bottom line of an answer: the first sentence of its first line of text
function outcomeOf(answer: string): string | null {
  const line = answer
    .split('\n')
    .map(part =>
      part
        .replace(/^\s*(#+|[-*>]|\d+\.)\s+/, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|`/g, '')
        .trim(),
    )
    .find(Boolean)
  if (!line) return null
  const sentence = /^.+?[.!?](?=\s|$)/.exec(line)
  return clip(sentence ? sentence[0] : line, MAX_OUTCOME)
}

// What Claude is doing, in plain words, from the tool call it is making
function actionOf(e: ToolCallInput): string | null {
  switch (e.tool) {
    case 'Bash':
      return clip(e.description || firstLine(e.command), 120)
    case 'Edit':
    case 'Write':
      return 'Editing ' + relativePath(e.file_path)
    case 'NotebookEdit':
      return 'Editing ' + relativePath(e.notebook_path)
    case 'Read':
      return 'Reading ' + relativePath(e.file_path)
    case 'WebFetch':
      return 'Reading ' + clip(e.url, 80)
    case 'WebSearch':
      return 'Searching the web for ' + clip(e.query, 60)
    case 'Agent':
      return 'Running a subagent: ' + clip(e.description, 80)
    case 'Skill':
      return 'Using the ' + e.skill + ' skill'
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList':
    case 'TodoWrite':
      return null
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(e.tool)
  return mcp ? 'Calling ' + mcp[2] + ' on ' + mcp[1] : 'Using ' + e.tool
}

// The first line of an approved plan, which is usually its title
function planTitleOf(text: string): string | null {
  const line = text
    .split('\n')
    .map(part => part.replace(/^\s*#+\s*/, '').trim())
    .find(Boolean)
  return line ? clip(line, 120) : null
}

function bumpLatest(list: readonly SessionPaneTurnRecord[], field: 'edits' | 'commands'): SessionPaneTurnRecord[] {
  const latest = list[list.length - 1]
  return latest ? [...list.slice(0, -1), { ...latest, [field]: latest[field] + 1 }] : [...list]
}

// Fills in the plain-words description of saved commands that lack one, from
// the transcript's record of each Bash call
async function loadDescriptions($: EngineInterface) {
  const saved = await read($, commands)
  if (!saved.some(entry => !entry.description)) return
  const described = new Map<string, string>()
  for (const row of await $.session.messages()) {
    for (const use of row.toolUses) {
      const text = use.tool === 'Bash' ? use.input.description : undefined
      if (typeof text === 'string' && text) described.set(use.tool_use_id, clip(text, 120))
    }
  }
  await update($, commands, list =>
    list.map(entry => (entry.description ? entry : { ...entry, description: described.get(entry.id) ?? null })),
  )
}

// Rebuilds the turn history from the transcript when the pane has none, as
// after a resume, so earlier turns still show
async function loadTimeline($: EngineInterface) {
  const kept = await read($, timeline)
  const needsIntent = (await read($, intent)) === null
  const needsRepair = kept[0]?.prompt.endsWith('…') ?? false
  const needsStart = (await read($, start)) === null
  if (kept.length > 0 && !needsIntent && !needsRepair && !needsStart) return
  const rows = await $.session.messages()
  // After a compaction the first request is gone from the transcript, and the
  // summary's own statement of the request stands in for it
  if (needsIntent) {
    const summary = rows.find(row => row.role === 'user' && isContinuation(row.text))
    const stated = summary ? intentOf(summary.text) : null
    if (stated) await update($, intent, () => stated)
  }
  // The starting request is kept once; the summary's statement outranks the
  // first request left after a compaction
  if (needsStart) {
    const summary = rows.find(row => row.role === 'user' && isContinuation(row.text))
    const first = startOf({
      intent: summary ? intentOf(summary.text) : null,
      prompts: rows.filter(row => row.role === 'user' && !row.toolResults?.length).map(row => ({ text: promptOf(row.text), at: null })),
    })
    if (first) await update($, start, () => first)
  }
  // A first prompt stored cut short is read again whole, since it can stand in
  // for the goal
  if (needsRepair) {
    const firstRow = rows.find(row => row.role === 'user' && !row.toolResults?.length && promptOf(row.text))
    const whole = firstRow ? promptOf(firstRow.text) : null
    if (whole) await update($, timeline, list => list.map((entry, i) => (i === 0 ? { ...entry, prompt: whole } : entry)))
  }
  if (kept.length > 0) return
  const entries: SessionPaneTurnRecord[] = []
  for (const row of rows) {
    const entry = entries[entries.length - 1]
    if (row.role === 'user') {
      if (row.toolResults?.length) continue
      const prompt = promptOf(row.text)
      if (!prompt) continue
      entries.push({
        id: 'transcript-' + entries.length,
        at: null,
        prompt,
        outcome: null,
        durationMs: null,
        edits: 0,
        commands: 0,
        isAborted: false,
      })
    } else if (entry) {
      entry.outcome = outcomeOf(row.text) ?? entry.outcome
      for (const use of row.toolUses) {
        if (EDIT_TOOLS.has(use.tool)) entry.edits += 1
        else if (use.tool === 'Bash') entry.commands += 1
      }
    }
  }
  if (entries.length === 0) return
  await update($, timeline, () => entries.slice(-MAX_TIMELINE))
  await update($, totals, counted => ({
    ...counted,
    turns: counted.turns + entries.length,
    edits: counted.edits + entries.reduce((sum, entry) => sum + entry.edits, 0),
    commands: counted.commands + entries.reduce((sum, entry) => sum + entry.commands, 0),
  }))
}

export function register(on: On) {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    isPaneOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    await loadUsage($)
    await loadTimeline($).catch(() => {})
    await loadDescriptions($).catch(() => {})
    await loadShells($).catch(() => {})
    if ((await read($, named)) === null) void nameGoal($)
    $.clock.every(PR_POLL_MS, () => {
      if (isPaneOpen) void refreshPr($)
    })
    // Keeps the working and shell timers moving while the pane is open
    $.clock.every(TICK_MS, async () => {
      if (!isPaneOpen) return
      const isBusy = (await read($, turn)) !== null || (await read($, shells)).some(shell => shell.status === 'running')
      if (isBusy) $.ui.invalidate('ui.render')
    })
    $.clock.every(OUTPUT_POLL_MS, () => {
      if (isPaneOpen) void refreshOutput($)
    })
    await $.command.register({ name: 'session-pane', description: 'Show or hide the session pane', immediate: true })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const named = e.session_title
    if (named) await update($, title, () => clip(named, MAX_PROMPT))
    // /clear, /resume and /branch reset $.state without a new session.start
    if (e.source === 'compact') {
      await loadTimeline($).catch(() => {})
      void nameGoal($)
    }
    if (e.source === 'resume') await update($, shells, () => [])
    if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
      // A goal named for the session before must not land in the new state
      goalStop?.abort()
      goalRun += 1
      await loadUsage($)
      await loadTimeline($).catch(() => {})
      if (e.source !== 'clear') void nameGoal($)
      if (isPaneOpen) void refreshPr($)
    }
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const named = e.session_title
    if (named) await update($, title, () => clip(named, MAX_PROMPT))
    return next(e)
  })

  // Observes /goal as the user types it: a condition sets the goal, and
  // `clear` or one of its aliases removes it
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    const condition = e.args.trim()
    if (GOAL_CLEAR_WORDS.has(condition.toLowerCase())) {
      await update($, goal, () => null)
    } else if (condition) {
      const setAt = await $.clock.now()
      await update($, goal, () => ({ condition: clip(condition, MAX_PROMPT), setAt, via: 'command' as const }))
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => usageOf(e))
    return next(e)
  })

  on('command.run', { command: 'session-pane' }, async $ => {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.close({ id: PANE })
      isPaneOpen = false
      return {}
    }
    await $.ui.open({ id: PANE, title: 'Session', columns: PANE_COLUMNS })
    isPaneOpen = true
    void refreshPr($)
    void refreshAgents($)
    void refreshOutput($)
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    isPaneOpen = false
    return result
  })

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    const prompt = promptOf(e.text) || NO_PROMPT
    await update($, turn, () => ({ startedAt: at }))
    await update($, action, () => null)
    await update($, note, () => null)
    await update($, totals, counted => ({ ...counted, turns: counted.turns + 1 }))
    const brief = isAsk(prompt) ? briefOf(prompt) : null
    if (brief) await update($, start, first => first ?? { text: brief, at })
    await update($, timeline, list =>
      [
        ...list,
        { id: e.turnId, at, prompt, outcome: null, durationMs: null, edits: 0, commands: 0, isAborted: false },
      ].slice(-MAX_TIMELINE),
    )
    // A short reply keeps the goal, so only a new request names it again
    if (brief) void nameGoal($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId && !seenAgents.has(e.agentId)) {
      seenAgents.add(e.agentId)
      void refreshAgents($)
    }
    const result = yield* next(e)
    const used = result.usage
    if (used) {
      const side = e.agentId ? 'subagents' : 'main'
      await update($, tokens, total => ({ ...total, [side]: addUsage(total[side], used) }))
    }
    // Text written before tool calls says what Claude is about to do; the
    // turn's final answer goes to the timeline instead
    const said = !e.agentId && result.toolUses.length > 0 ? noteOf(result.answer) : null
    if (said) await update($, note, () => said)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      void refreshAgents($)
      return next(e)
    }
    const used = e.usage
    const outcome = outcomeOf(e.answer)
    await loadDescriptions($).catch(() => {})
    await update($, timeline, list =>
      list.map(entry =>
        entry.id === e.turnId ? { ...entry, outcome, durationMs: e.durationMs, isAborted: e.isAborted } : entry,
      ),
    )
    await update($, turn, () => null)
    await update($, action, () => null)
    await update($, lastTurn, () => ({
      durationMs: e.durationMs,
      input: used ? used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens : 0,
      output: used ? used.output_tokens : 0,
      isAborted: e.isAborted,
    }))
    return next(e)
  })

  // The main conversation's latest tool call, as the pane's "Now" line
  on('tool.call', async ($, e, next) => {
    const doing = e.agentId ? null : actionOf(e)
    if (doing) await update($, action, () => doing)
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError) return result
    const path = relativePath(e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path)
    await update($, files, list =>
      list.some(file => file.path === path)
        ? list.map(file => (file.path === path ? { path, edits: file.edits + 1 } : file))
        : [...list, { path, edits: 1 }],
    )
    await update($, timeline, list => bumpLatest(list, 'edits'))
    await update($, totals, counted => ({ ...counted, edits: counted.edits + 1 }))
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    const command = firstLine(e.command)
    const description = e.description ? clip(e.description, 120) : null
    await update($, commands, list =>
      [...list, { id, command, description, status: 'running' as const }].slice(-KEPT_COMMANDS),
    )
    const result = await next(e)
    const isFailed = Boolean(result.deny || result.isError)
    const record: unknown = result.result
    const taskId = !isFailed && isRecord(record) && typeof record.backgroundTaskId === 'string' ? record.backgroundTaskId : null
    const status = isFailed ? ('failed' as const) : taskId ? ('background' as const) : ('ok' as const)
    await update($, commands, list => list.map(entry => (entry.id === id ? { ...entry, status } : entry)))
    // A subagent's background shell reports to the subagent, so only the main
    // conversation's are followed
    if (taskId && !e.agentId) {
      await addShell($, {
        id: taskId,
        kind: 'shell',
        label: description ?? command,
        command,
        toolUseId: id,
        outputFile: OUTPUT_FILE.exec(result.text ?? '')?.[1] ?? null,
        startedAt: await $.clock.now(),
        endedAt: null,
        status: 'running',
        lastLine: null,
      })
    }
    if (!result.deny) {
      await update($, timeline, list => bumpLatest(list, 'commands'))
      await update($, totals, counted => ({
        ...counted,
        commands: counted.commands + 1,
        failed: counted.failed + (result.isError ? 1 : 0),
      }))
    }
    const created = isFailed ? null : createdPrOf(e.command, result.result, result.text)
    if (created) {
      await update($, createdPrs, list => (list.some(known => known.url === created.url) ? list : [...list, created]))
    }
    if (PUSH_OR_PR.test(e.command)) void refreshPr($)
    return result
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($)
    if (!result.deny) await update($, totals, counted => ({ ...counted, subagents: counted.subagents + 1 }))
    return result
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const result = await next(e)
    const record: unknown = result.result
    if (result.deny || result.isError || e.agentId || !isRecord(record) || typeof record.taskId !== 'string') return result
    const command = e.command ? firstLine(e.command) : (e.ws?.url ?? null)
    await addShell($, {
      id: record.taskId,
      kind: 'monitor',
      label: clip(e.description || command || 'Monitor', 120),
      command,
      toolUseId: e.tool_use_id,
      outputFile: OUTPUT_FILE.exec(result.text ?? '')?.[1] ?? null,
      startedAt: await $.clock.now(),
      endedAt: null,
      status: 'running',
      lastLine: null,
    })
    return result
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const result = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id && !result.deny && !result.isError) await endShell($, id, 'killed', await $.clock.now())
    return result
  })

  // A background task's notification says how it ended
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const at = await $.clock.now()
      for (const [id, status] of endedTasksOf(e.text)) await endShell($, id, status, at)
    }
    return next(e)
  })

  // At each turn's end the engine lists the background work still in flight:
  // a shell no longer on it has ended, and one the pane missed (started before
  // a reload) is added
  on('classic.Stop', async ($, e, next) => {
    const inFlight = e.background_tasks
    if (inFlight) {
      const at = await $.clock.now()
      const ids = new Set(inFlight.map(task => task.id))
      for (const shell of await read($, shells)) {
        if (shell.status === 'running' && !ids.has(shell.id)) await endShell($, shell.id, 'completed', at)
      }
      const known = new Set((await read($, shells)).map(shell => shell.id))
      for (const task of inFlight) {
        if ((task.type !== 'shell' && task.type !== 'monitor') || known.has(task.id) || ENDED_SHELLS.has(task.status)) continue
        await addShell($, {
          id: task.id,
          kind: task.type,
          label: clip(task.description || task.command || task.id, 120),
          command: task.command ? firstLine(task.command) : null,
          toolUseId: null,
          outputFile: null,
          startedAt: at,
          endedAt: null,
          status: 'running',
          lastLine: null,
        })
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'ProposeGoal' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError) return result
    const setAt = await $.clock.now()
    await update($, goal, () => ({ condition: clip(e.condition, MAX_PROMPT), setAt, via: 'tool' as const }))
    return result
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError) return result
    const record: unknown = result.result
    const approved = isRecord(record) && typeof record.plan === 'string' ? planTitleOf(record.plan) : null
    if (approved) {
      const at = await $.clock.now()
      await update($, plan, () => approved)
      await update($, planAt, () => at)
      void nameGoal($)
    }
    return result
  })

  on('tool.call', { tool: ['TaskCreate', 'TaskUpdate', 'TodoWrite'] }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || result.isError) return result
    const record: unknown = result.result
    if (e.tool === 'TaskCreate') {
      const task = isRecord(record) && isRecord(record.task) ? record.task : null
      if (task) {
        const created = {
          id: String(task.id),
          subject: String(task.subject ?? e.subject),
          status: 'pending' as const,
          activeForm: e.activeForm ?? null,
        }
        await update($, tasks, list => [...list.filter(known => known.id !== created.id), created])
      }
    } else if (e.tool === 'TaskUpdate') {
      if (isRecord(record) && record.success === false) return result
      const { taskId, status, subject, activeForm } = e
      await update($, tasks, list =>
        status === 'deleted'
          ? list.filter(task => task.id !== taskId)
          : list.map(task =>
              task.id === taskId
                ? {
                    ...task,
                    subject: subject ?? task.subject,
                    status: status ?? task.status,
                    activeForm: activeForm ?? task.activeForm ?? null,
                  }
                : task,
            ),
      )
    } else if (!e.agentId) {
      // TodoWrite sends the whole list each time; a subagent's list is its own
      const todos = e.todos.map((todo, i) => ({
        id: String(i + 1),
        subject: todo.content,
        status: todo.status,
        activeForm: todo.activeForm,
      }))
      await update($, tasks, () => todos)
    }
    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Link } = $.ui.resolve(e)
    const now = await $.clock.now()
    const width = e.props.bodyColumns

    const measured = await read($, usage)
    const counted = await read($, tokens)
    const current = await read($, turn)
    const last = await read($, lastTurn)
    const changed = await read($, files)
    const recent = await read($, commands)
    const running = await read($, agents)
    const branchPr = await read($, pr)
    const created = await read($, createdPrs)
    const taskList = await read($, tasks)
    const sessionTitle = await read($, title)
    const currentGoal = await read($, goal)
    const approvedPlan = await read($, plan)
    const doing = await read($, action)
    const said = await read($, note)
    const turns = await read($, timeline)
    const since = await read($, startedAt)
    const sums = await read($, totals)
    const background = await read($, shells)
    const runningShells = background.filter(shell => shell.status === 'running')

    type Style = { color?: string; dimColor?: boolean; bold?: boolean; wrap?: 'wrap' | 'truncate-end' | 'truncate-start' }
    const text = (value: string, style: Style = {}) => {
      // Leave unset styles out of the props instead of passing undefined
      const props = Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined && v !== false))
      return Text({ wrap: 'truncate-end', ...props, children: [value] })
    }
    const dim = (value: string) => text(value, { dimColor: true })
    const wrapped = (value: string, style: Style = {}) => text(value, { ...style, wrap: 'wrap' })
    const row = (...children: RenderNode[]) => Box({ flexDirection: 'row', columnGap: 1, children })
    const label = (value: string) => text(value.padEnd(LABEL_WIDTH), { dimColor: true })
    // A label column beside a value that wraps within the space left
    const field = (name: string, value: RenderNode) =>
      Box({
        flexDirection: 'row',
        children: [
          Box({ width: LABEL_WIDTH, flexShrink: 0, children: [label(name)] }),
          Box({ flexGrow: 1, flexShrink: 1, children: [value] }),
        ],
      })
    // Pieces of one line, each with its own color, that wrap as one text, so a
    // separator never starts or ends a row by itself
    const line = (pieces: (RenderNode | null)[]) => {
      const kept = pieces.filter((piece): piece is RenderNode => piece !== null)
      return Text({ wrap: 'wrap', children: kept.flatMap((piece, i) => (i === 0 ? [piece] : [dim(' · '), piece])) })
    }
    // A bold accent title and a rule to the pane's edge, so each section is
    // easy to find
    const section = (name: string, children: RenderNode[], detail?: string) => {
      const head = name + (detail ? ' ' + detail : '')
      return Box({
        flexDirection: 'column',
        children: [
          row(
            text(name, { bold: true, color: ACCENT }),
            ...(detail ? [dim(detail)] : []),
            dim('─'.repeat(Math.max(0, width - head.length - 1))),
          ),
          ...children,
        ],
      })
    }
    const meter = (percent: number | null) => {
      const barWidth = Math.max(8, Math.min(20, width - 32))
      const value = percent ?? 0
      const filled = Math.min(barWidth, Math.round((value / 100) * barWidth))
      const color = percent === null ? undefined : levelColor(value)
      return row(
        Box({
          flexDirection: 'row',
          children: [text('█'.repeat(filled), { color }), dim('░'.repeat(barWidth - filled))],
        }),
        text(percent === null ? '—' : value + '%', { color, bold: true }),
      )
    }

    const usageRows: RenderNode[] = []
    if (!measured) {
      usageRows.push(dim('No reading yet. It updates after each turn.'))
    } else {
      const { context } = measured
      usageRows.push(
        field(
          'Context',
          row(
            meter(context.percent),
            dim((context.tokens === null ? '—' : formatCount(context.tokens)) + ' / ' + formatCount(context.window)),
          ),
        ),
      )
      for (const limit of measured.rateLimits) {
        usageRows.push(
          field(
            limitName(limit.kind),
            row(meter(limit.percentUsed), dim(limit.resetsAt ? formatReset(limit.resetsAt, now) : '')),
          ),
        )
      }
    }
    const tokenLine = (side: SessionPaneTokens) =>
      line([
        dim(formatCount(side.input) + ' in'),
        dim(formatCount(side.output) + ' out'),
        dim('cache ' + formatCount(side.cacheRead) + ' r / ' + formatCount(side.cacheWrite) + ' w'),
      ])
    // Each side gets a row once it has spent any tokens
    const hasSpent = (side: SessionPaneTokens) => Object.values(side).some(n => n > 0)
    if (hasSpent(counted.main)) usageRows.push(field('Tokens', tokenLine(counted.main)))
    if (hasSpent(counted.subagents)) usageRows.push(field('Agents', tokenLine(counted.subagents)))
    const usageDetail = [
      since === null ? null : formatDuration(now - since),
      measured?.costUsd == null ? null : '$' + measured.costUsd.toFixed(2),
    ].filter(Boolean)

    const sessionRows: RenderNode[] = []
    const focus = taskList.find(task => task.status === 'in_progress')
    const focusText = focus ? (focus.activeForm ?? focus.subject) : null
    const lastText = last
      ? 'Last turn ' + formatDuration(last.durationMs) + ' · ' + formatCount(last.input) + ' in · ' + formatCount(last.output) + ' out'
      : null
    const lastLine = last ? [dim(lastText ?? ''), last.isAborted ? text('interrupted', { color: 'error' }) : null] : []
    if (current) {
      const elsewhere = runningShells.length > 0 ? dim('+' + runningShells.length + ' background') : null
      sessionRows.push(
        field('Now', line([text('● Working · ' + formatDuration(now - current.startedAt), { color: 'warning', bold: true }), elsewhere])),
      )
      if (focusText) sessionRows.push(field('', wrapped(focusText, { color: 'warning' })))
      if (said) sessionRows.push(field('', wrapped(said)))
      sessionRows.push(field('', dim(doing ?? 'Thinking')))
    } else if (runningShells.length > 0) {
      // Claude waits for the background work to report, so the session is not idle
      const times = runningShells.flatMap(shell => (shell.startedAt === null ? [] : [shell.startedAt]))
      const elapsed = times.length > 0 ? ' · ' + formatDuration(now - Math.min(...times)) : ''
      sessionRows.push(
        field(
          'Now',
          line([
            text('◐ Background' + elapsed, { color: 'suggestion', bold: true }),
            text(runningShells.length + ' running', { color: 'suggestion' }),
          ]),
        ),
      )
      if (last) sessionRows.push(field('', line(lastLine)))
    } else {
      sessionRows.push(field('Now', line([dim('○ Idle'), ...lastLine])))
    }
    // The goal follows the session: the /goal condition while one is set, else
    // the goal the small model named, else the rules in goal.ts. The request
    // the session started from shows under it once there is more than one.
    const stated = await read($, intent)
    const aim =
      (currentGoal ? null : await read($, named)) ??
      goalOf({
        goal: currentGoal?.condition,
        plan: approvedPlan ? { text: approvedPlan, at: await read($, planAt) } : null,
        intent: stated,
        prompts: turns.map(entry => ({ text: entry.prompt, at: entry.at })),
        title: sessionTitle,
      })
    const first = await read($, start)
    const hasMoved = currentGoal !== null || stated !== null || turns.filter(entry => isAsk(entry.prompt)).length > 1
    if (aim) sessionRows.push(field('Goal', wrapped(aim.text, { bold: true })))
    if (aim && first && hasMoved && first.text !== aim.text) {
      sessionRows.push(field('Initial', wrapped(clip(first.text, START_CHARS), { dimColor: true })))
    }

    const done = taskList.filter(task => task.status === 'completed').length
    const taskRows: RenderNode[] = []
    // A long list folds its finished tasks into one row
    const isFolded = taskList.length > MAX_TASKS && done > 0
    if (isFolded) taskRows.push(row(text('✓', { color: 'success' }), dim(plural(done, 'task', ' done') ?? '')))
    for (const task of taskList) {
      const isDone = task.status === 'completed'
      if (isDone && isFolded) continue
      const isActive = task.status === 'in_progress'
      taskRows.push(
        row(
          text(isDone ? '✓' : isActive ? '◐' : '○', { color: isDone ? 'success' : isActive ? 'warning' : undefined, dimColor: !isDone && !isActive }),
          wrapped(task.subject, { dimColor: isDone, bold: isActive }),
        ),
      )
    }

    const prRows: RenderNode[] = []
    const branchUrl = branchPr.kind === 'pr' ? branchPr.url : null
    if (branchPr.kind === 'pr') {
      const stateColor = { OPEN: 'success', MERGED: 'merged', CLOSED: 'error' }[branchPr.state]
      const review = reviewName(branchPr.reviewDecision)
      const reviewColor = { approved: 'success', 'changes requested': 'error', 'review required': 'warning' }[review]
      const checksColor = { pass: 'success', fail: 'error', pending: 'warning', none: undefined }[branchPr.checks]
      prRows.push(Link({ href: branchPr.url, label: '#' + branchPr.number + ' ' + branchPr.title }))
      prRows.push(
        line([
          text(branchPr.state.toLowerCase(), { color: stateColor, bold: true }),
          branchPr.isDraft ? text('draft', { color: 'inactive' }) : null,
          text(review, { color: reviewColor, dimColor: !reviewColor }),
          text('checks: ' + branchPr.checks, { color: checksColor }),
        ]),
      )
    }
    // The branch PR is often one Claude opened, so it is not listed twice. The
    // latest ones fill what is left of the PR limit.
    const opened = created.filter(made => made.url !== branchUrl)
    const room = Math.max(0, MAX_PRS - (branchUrl ? 1 : 0))
    const shownPrs = room > 0 ? opened.slice(-room) : []
    if (shownPrs.length > 0) {
      // PRs in more than one repository are named with their repository, and
      // with its owner too when two repositories share a name
      const repos = new Set([branchUrl, ...shownPrs.map(made => made.url)].flatMap(url => (url ? [repoOf(url)] : [])))
      const names = new Set([...repos].map(repo => repo.split('/').pop()))
      const prLabel = (made: { number: number; url: string }) => {
        const repo = repoOf(made.url)
        const name = names.size < repos.size ? repo : (repo.split('/').pop() ?? repo)
        return (repos.size > 1 ? name : '') + '#' + made.number
      }
      const hidden = opened.length - shownPrs.length
      prRows.push(
        field(
          'Opened',
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            columnGap: 1,
            children: [
              ...(hidden > 0 ? [dim('+' + hidden + ' earlier')] : []),
              ...shownPrs.map(made => Link({ href: made.url, label: prLabel(made) })),
            ],
          }),
        ),
      )
    }

    const activityRows: RenderNode[] = []
    const subhead = (name: string, ...detail: (RenderNode | null)[]) =>
      row(text(name, { bold: true }), ...(detail.some(Boolean) ? [line(detail)] : []))
    if (changed.length > 0) {
      const edits = changed.reduce((sum, file) => sum + file.edits, 0)
      activityRows.push(subhead('Files changed', dim(plural(changed.length, 'file') + ' · ' + plural(edits, 'edit'))))
      // A summary by folder, most edited first, so a long session stays short
      const groups = fileGroupsOf(changed)
      // A "+1 more" row would take the row of the one group it hides
      const shownGroups = groups.length === MAX_FILE_GROUPS + 1 ? groups.length : MAX_FILE_GROUPS
      for (const group of groups.slice(0, shownGroups)) {
        activityRows.push(
          row(
            text('  ' + group.name, { wrap: 'truncate-start' }),
            ...(group.files > 1 ? [dim(plural(group.files, 'file') ?? '')] : []),
            text('×' + group.edits, { color: 'suggestion' }),
          ),
        )
      }
      if (groups.length > shownGroups) {
        const rest = groups.slice(shownGroups)
        const restFiles = rest.reduce((sum, group) => sum + group.files, 0)
        activityRows.push(dim('  +' + plural(restFiles, 'more file', ' in ') + plural(rest.length, 'other place')))
      }
    }
    // A command still running in the background shows under Background
    // instead, unless a subagent ran it, since the pane does not follow those
    const followed = new Set(background.map(shell => shell.toolUseId))
    const shownCommands = recent.filter(entry => entry.status !== 'background' || !followed.has(entry.id)).slice(-MAX_COMMANDS)
    if (shownCommands.length > 0) {
      activityRows.push(
        subhead(
          'Recent commands',
          sums.commands > 0 ? dim(sums.commands + ' run') : null,
          sums.failed > 0 ? text(sums.failed + ' failed', { color: 'error' }) : null,
        ),
      )
    }
    for (const entry of [...shownCommands].reverse()) {
      const mark = { ok: '✓', failed: '✗', background: '◐', running: '…' }[entry.status]
      const color = { ok: 'success', failed: 'error', background: 'suggestion', running: undefined }[entry.status]
      activityRows.push(row(text('  ' + mark, { color }), text(entry.description ?? entry.command, { dimColor: entry.status === 'running' })))
    }
    if (background.length > 0) activityRows.push(subhead('Background', dim(runningShells.length + ' running')))
    for (const shell of [...background].reverse()) {
      const isRunning = shell.status === 'running'
      const mark = { running: '◐', completed: '✓', failed: '✗', killed: '■' }[shell.status]
      const color = { running: 'suggestion', completed: 'success', failed: 'error', killed: 'inactive' }[shell.status]
      const took = shell.startedAt === null ? null : formatDuration((shell.endedAt ?? now) - shell.startedAt)
      const state = isRunning ? took : took ? shell.status + ' after ' + took : shell.status
      const facts = [shell.kind === 'monitor' ? 'monitor' : null, state].filter(Boolean).join(' · ')
      activityRows.push(
        Box({
          flexDirection: 'row',
          columnGap: 1,
          children: [
            text('  ' + mark, { color }),
            Box({
              flexDirection: 'column',
              flexGrow: 1,
              flexShrink: 1,
              children: [
                line([text(shell.label, { dimColor: !isRunning }), facts ? dim(facts) : null]),
                ...(shell.command && shell.command !== shell.label ? [dim('$ ' + shell.command)] : []),
                ...(isRunning && shell.lastLine ? [text('› ' + shell.lastLine, { color: 'suggestion' })] : []),
              ],
            }),
          ],
        }),
      )
    }
    if (sums.subagents > 0 || running.length > 0) {
      activityRows.push(subhead('Agents', dim(running.length + ' running'), sums.subagents > 0 ? dim(sums.subagents + ' run') : null))
    }
    for (const agent of running) {
      const status = agent.status === 'running' ? '' : ' · ' + agent.status
      activityRows.push(row(text('  ' + agent.type, { color: 'suggestion' }), dim(agent.description + status)))
    }

    const timelineRows: RenderNode[] = []
    const latest = turns[turns.length - 1]
    for (const entry of turns.slice(-TIMELINE_ENTRIES).reverse()) {
      const isRunning = entry === latest && current !== null && entry.outcome === null
      const outcome = entry.outcome ?? (isRunning ? 'Working…' : 'No written answer')
      const arrowColor = isRunning ? 'warning' : entry.isAborted ? 'error' : entry.outcome ? 'success' : undefined
      const facts = [
        entry.durationMs === null ? null : formatDuration(entry.durationMs),
        plural(entry.edits, 'edit'),
        plural(entry.commands, 'command'),
      ].filter(Boolean)
      timelineRows.push(
        Box({
          flexDirection: 'column',
          children: [
            field(entry.at === null ? '' : formatClock(entry.at), wrapped(isContinuation(entry.prompt) ? CONTINUED : clip(entry.prompt, TIMELINE_PROMPT), { bold: true })),
            field(
              '',
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  text('→', { color: arrowColor, dimColor: !arrowColor }),
                  Box({
                    flexGrow: 1,
                    flexShrink: 1,
                    children: [wrapped(outcome, { color: isRunning ? 'warning' : undefined, dimColor: !entry.outcome && !isRunning })],
                  }),
                ],
              }),
            ),
            ...(facts.length > 0 || entry.isAborted
              ? [
                  field(
                    '',
                    line([
                      facts.length > 0 ? dim(facts.join(' · ')) : null,
                      entry.isAborted ? text('interrupted', { color: 'error' }) : null,
                    ]),
                  ),
                ]
              : []),
          ],
        }),
      )
    }

    // Sections with nothing to show are left out. The live ones come first, so
    // a short pane still shows them.
    return Box({
      flexDirection: 'column',
      children: [
        section('Usage', usageRows, usageDetail.join(' · ')),
        ...(sessionRows.length > 0 ? [section('Session', sessionRows)] : []),
        ...(taskList.length > 0 ? [section('Tasks', taskRows, done + '/' + taskList.length)] : []),
        ...(prRows.length > 0 ? [section('PRs', prRows)] : []),
        ...(activityRows.length > 0 ? [section('Activity', activityRows)] : []),
        ...(timelineRows.length > 0 ? [section('Timeline', timelineRows, plural(turns.length, 'turn') ?? '')] : []),
      ],
    })
  })
}
