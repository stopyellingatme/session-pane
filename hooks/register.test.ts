import type { On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { briefOf, goalOf as sessionGoalOf, intentOf } from './goal'

// What Claude Code passes to a ui.render hook for this pane
const PANE = {
  plugin: 'session-pane',
  component: 'Pane',
  requestId: 'session-pane',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-09T18:00:00Z')

// /goal as the user types it, before its arguments
const GOAL = {
  command: 'goal',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

// /session-pane as the user types it in a fullscreen terminal
const TOGGLE = {
  command: 'session-pane',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const USAGE = {
  startedAt: NOW,
  context: { tokens: 170_000, window: 200_000, percent: 85 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 23, resetsAt: '2026-10-09T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 61, resetsAt: '2026-10-12T14:00:00Z' },
  ],
  cost: { usd: 1.234 },
}

const STEP_USAGE = {
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 2000,
  model: 'claude-test',
}

const OPEN_PR = JSON.stringify({
  number: 42,
  title: 'Add the session pane',
  url: 'https://github.com/acme/app/pull/42',
  state: 'OPEN',
  isDraft: true,
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', state: 'PENDING' },
  ],
})

// Answers what the mod asks Claude Code for when the session starts
function stubSession(on: On) {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return clock
}

// Answers the pane commands, keeping track of whether the pane is open
function stubPane(on: On) {
  const pane = { isOpen: false }
  on('ui.panes', () => ({
    value: pane.isOpen ? [{ id: 'session-pane', title: 'Session', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.open', () => {
    pane.isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    pane.isOpen = false
    return { value: undefined }
  })
  return pane
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

// Sends one model request through the mod's turn.step hook
async function step($: Engine, agentId?: string) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
  let next = await stream.next()
  while (next.done !== true) next = await stream.next()
}

// The text drawn in the Goal row, just after its label
function goalOf(lines: string[]) {
  return lines[lines.indexOf('Goal'.padEnd(9)) + 1]
}

// Draws the pane once and returns every line of text and link label in it
async function draw($: Engine) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = await ui.findAll({ type: 'Text' })
  const links = await ui.findAll({ type: 'Link' })
  await ui.unmount()
  return { texts, lines: [...texts, ...links].map(element => element.text) }
}

// Draws until the PR check the command started in the background has landed
// The PR check runs in the background, so this draws until `until` holds,
// or gives it 20 draws to settle when there is nothing to wait for
async function drawAfterPrCheck($: Engine, until: (lines: string[]) => boolean = () => false) {
  let drawn = await draw($)
  for (let attempt = 0; attempt < 20 && !until(drawn.lines); attempt++) drawn = await draw($)
  return drawn
}

test('/session-pane opens the pane, and runs again to close it', async ($, on) => {
  stubSession(on)
  const pane = stubPane(on)
  on('session.repo', () => ({ value: null }))
  on('agent.list', () => ({ value: [] }))

  await start($)
  expect(await $.command.run(TOGGLE)).toEqual({})
  expect(pane.isOpen).toBe(true)
  expect(await $.command.run(TOGGLE)).toEqual({})
  expect(pane.isOpen).toBe(false)
})

test('Usage shows context, plan limits and cost, and splits tokens by agent', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE }
  })

  await start($)
  await $.session.measure({ ...USAGE, changed: ['context', 'rateLimits', 'cost'] })
  await step($)
  await step($)
  await step($, 'agent-1')

  const { texts, lines } = await draw($)
  // Usage and Session lead, each under an accent title
  const titleAt = (name: string) => texts.findIndex(element => element.text === name && element.props.color === 'claude')
  const order = ['Usage', 'Session'].map(titleAt)
  expect(order.every(at => at >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // Sections with nothing to show yet are left out
  for (const name of ['Tasks', 'PRs', 'Activity', 'Timeline']) expect(titleAt(name)).toBe(-1)
  const context = texts.find(element => /85%$/.test(element.text))
  expect(context?.props.color).toBe('error')
  expect(texts.find(element => element.text === '23%')?.props.color).toBe('success')
  expect(lines).toContain('170k / 200k')
  expect(lines).toContain('23%')
  expect(texts.find(element => element.text === '61%')?.props.color).toBe('warning')
  expect(lines.some(line => /^resets /.test(line))).toBe(true)
  // The session length and cost sit in the Usage title row
  expect(lines[lines.indexOf('Usage') + 1]).toBe('0s · $1.23')
  // Tokens for the main conversation, then for subagents, one row each
  const tokens = lines.indexOf('Tokens'.padEnd(9))
  expect(lines[tokens + 1]).toBe('2k in · 1k out · cache 80k r / 4k w')
  const agents = lines.indexOf('Agents'.padEnd(9))
  expect(lines[agents + 1]).toBe('1k in · 500 out · cache 40k r / 2k w')
})

test('Activity shows the turn, changed files and recent commands', async ($, on) => {
  const clock = stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Edit' && e.file_path.endsWith('denied.ts')) return { deny: 'The user declined this edit.' }
    if (e.tool === 'Bash' && e.command === 'npm test') return { result: 'Exit code 1', text: 'Exit code 1', isError: true }
    return { result: 'ok' }
  })

  await start($)
  await $.turn.start({ text: 'fix the build', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/app.ts', old_string: 'b', new_string: 'c' })
  await $.tool.call({ tool: 'Write', file_path: '/work/README.md', content: '# App' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/denied.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await clock.advance(72_000)

  const working = await draw($)
  expect(working.lines).toContain('● Working · 1m 12s')
  expect(working.lines).toContain('Files changed')
  expect(working.lines).toContain('2 files · 3 edits')
  expect(working.lines).toContain('  src/app.ts')
  expect(working.lines).toContain('×2')
  expect(working.lines).toContain('  README.md')
  expect(working.lines.some(line => line.includes('denied.ts'))).toBe(false)
  expect(working.lines).toContain('git status')
  expect(working.texts.find(element => element.text === '  ✗')?.props.color).toBe('error')

  await $.turn.complete({ turnId: 't1', answer: 'Done', durationMs: 42_000, isAborted: false, reason: 'answer', usage: STEP_USAGE })
  const idle = await draw($)
  expect(idle.lines).toContain('○ Idle')
  expect(idle.lines).toContain('Last turn 42s · 43k in · 500 out')
})

test('PRs shows the branch PR with its checks, and PRs created this session', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('agent.list', () => ({ value: [] }))
  on('session.repo', () => ({ value: { root: '/work', remote: 'git@github.com:acme/app.git', internal: false, name: null } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: OPEN_PR, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({
    result: {
      stdout: 'https://github.com/acme/app/pull/43\n',
      stderr: '',
      interrupted: false,
      gitOperation: { pr: { number: 43, url: 'https://github.com/acme/app/pull/43', action: 'created' } },
    },
    text: 'https://github.com/acme/app/pull/43',
  }))

  await start($)
  await $.command.run(TOGGLE)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  const { texts, lines } = await drawAfterPrCheck($, lines => lines.includes('#42 Add the session pane'))
  expect(lines).toContain('#42 Add the session pane')
  expect(texts.find(element => element.text === 'open')?.props.color).toBe('success')
  expect(lines).toContain('draft')
  expect(texts.find(element => element.text === 'review required')?.props.color).toBe('warning')
  expect(texts.find(element => element.text === 'checks: fail')?.props.color).toBe('error')
  expect(lines).toContain('Opened'.padEnd(9))
  expect(lines).toContain('#43')
})

test('PRs is left out when the branch has no PR', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('agent.list', () => ({ value: [] }))
  on('session.repo', () => ({ value: { root: '/work', remote: null, internal: false, name: null } }))
  on('process.run', () => ({
    value: {
      exitCode: 1,
      stdout: '',
      stderr: 'no pull requests found for branch "feat/pane"\n',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  await start($)
  await $.command.run(TOGGLE)

  const { texts } = await drawAfterPrCheck($)
  expect(texts.some(element => element.text === 'PRs')).toBe(false)
})

test('Tasks mirrors TaskCreate and TaskUpdate', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: e.subject === 'Write tests' ? '1' : '2', subject: e.subject } } }
    return { result: { success: true, taskId: '1', updatedFields: ['status'] } }
  })

  await start($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Write tests', description: 'Cover each section' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Ship it', description: 'Open a PR' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const { texts, lines } = await draw($)
  expect(lines).toContain('1/2')
  expect(texts.find(element => element.text === '✓')?.props.color).toBe('success')
  expect(texts.find(element => element.text === 'Write tests')?.props.dimColor).toBe(true)
  expect(texts.find(element => element.text === '◐')?.props.color).toBe('warning')
  expect(lines).toContain('Ship it')
})

test('Tasks takes the whole list from TodoWrite', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('tool.call', () => ({ result: { oldTodos: [], newTodos: [] } }))

  await start($)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the spec', status: 'completed', activeForm: 'Reading the spec' },
      { content: 'Write the mod', status: 'in_progress', activeForm: 'Writing the mod' },
      { content: 'Test it', status: 'pending', activeForm: 'Testing it' },
    ],
  })

  const { lines } = await draw($)
  expect(lines).toContain('1/3')
  expect(lines).toContain('○')
  expect(lines).toContain('Test it')
})

test('Session shows an overview, the goal and what Claude is doing', async ($, on) => {
  const clock = stubSession(on)
  stubPane(on)
  on('command.run', () => ({}))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', ($, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: '1', subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await start($)
  await $.command.run({ ...GOAL, args: 'all tests in test/auth pass' })
  await $.turn.start({ text: 'make the auth tests pass', turnId: 't1' })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Fix the auth tests',
    description: 'Get test/auth green',
    activeForm: 'Fixing the auth tests',
  })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'Bash', command: 'npm test -- test/auth', description: 'Run the auth tests' })
  await clock.advance(5 * 60_000)

  const working = await draw($)
  for (const piece of ['5m 0s · $1.23', '1 run', '0/1', '1 turn']) expect(working.lines).toContain(piece)
  expect(working.lines).toContain('all tests in test/auth pass')
  // The first request shows under the /goal condition, dimmed, as Initial
  expect(working.lines).toContain('Initial'.padEnd(9))
  expect(working.lines.filter(line => line === 'make the auth tests pass').length).toBeGreaterThan(0)
  expect(working.lines).toContain('Fixing the auth tests')
  expect(working.lines).toContain('Run the auth tests')

  expect(working.lines).not.toContain('Asked'.padEnd(9))

  // Without a goal, the first prompt stands in for it, with no line naming the source
  await $.command.run({ ...GOAL, args: 'clear' })
  const cleared = await draw($)
  expect(cleared.lines).not.toContain('all tests in test/auth pass')
  expect(goalOf(cleared.lines)).toBe('make the auth tests pass')
  // Initial and current goal are the same, so there is one row
  expect(cleared.lines).not.toContain('Initial'.padEnd(9))
})

test('Session shows a long goal whole, and the timeline shortens it', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const prompt = 'Build the session pane so it shows usage, what Claude has done and the current goal, '.repeat(3).trim()

  await start($)
  await $.turn.start({ text: prompt, turnId: 't1' })

  const { lines } = await draw($)
  expect(goalOf(lines)).toBe(prompt)
  expect(lines.some(line => line.length < prompt.length && line.endsWith('…'))).toBe(true)
})

test('A first prompt stored cut short is shown whole after a reload', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  const prompt = 'Build the session pane so it shows usage, what Claude has done and the current goal, '.repeat(3).trim()
  const transcript: SessionMessage[] = [{ role: 'user', text: prompt, toolUses: [] }]
  on('session.messages', () => ({ value: transcript }))

  await $.turn.start({ text: prompt.slice(0, 100) + '…', turnId: 't1' })
  await start($)

  const { lines } = await draw($)
  expect(goalOf(lines)).toBe(prompt)
})

test('Activity keeps the five most recent commands', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await start($)
  for (let i = 1; i <= 7; i++) await $.tool.call({ tool: 'Bash', command: 'echo ' + i })

  const { lines } = await draw($)
  expect(lines.filter(line => line === '  ✓')).toHaveLength(5)
  expect(lines).toContain('echo 7')
  expect(lines).toContain('echo 3')
  expect(lines).not.toContain('echo 2')
})

test('Timeline lists each turn with its outcome, time taken and work done', async ($, on) => {
  const clock = stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))

  await start($)
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/src/login.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.turn.complete({
    turnId: 't1',
    answer: '**Fixed the login bug.** The token check now runs first.\n\n## Details\nMore here.',
    durationMs: 42_000,
    isAborted: false,
    reason: 'answer',
    usage: STEP_USAGE,
  })
  await clock.advance(60_000)
  await $.turn.start({ text: 'now open a PR', turnId: 't2' })

  const { lines } = await draw($)
  expect(lines).toContain('2 turns')
  expect(lines.some(line => /^\d{1,2}:\d{2}\s?[AP]M\s*$/.test(line))).toBe(true)
  expect(lines).toContain('Fixed the login bug.')
  expect(lines).toContain('42s · 1 edit · 1 command')
  expect(lines).toContain('Working…')
  // The timeline is the last section, and its newest turn comes first
  const newest = lines.lastIndexOf('now open a PR')
  const oldest = lines.lastIndexOf('fix the login bug')
  expect(newest).toBeGreaterThan(lines.indexOf('Timeline'))
  expect(newest).toBeLessThan(oldest)
})

test('Timeline is rebuilt from the transcript after /resume', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('classic.SessionStart', () => ({}))
  const transcript: SessionMessage[] = [
      { role: 'user', text: 'add a dark mode toggle', toolUses: [] },
      {
        role: 'assistant',
        text: 'I will read the theme code first.',
        toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/work/src/theme.ts' } }],
      },
      {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [{ tool_use_id: 'r1', text: 'export const theme = {}', isError: false }],
      },
      {
        role: 'assistant',
        text: 'Added the toggle. It remembers the choice.',
        toolUses: [
          { tool_use_id: 'e1', tool: 'Edit', input: { file_path: '/work/src/theme.ts' } },
          { tool_use_id: 'b1', tool: 'Bash', input: { command: 'npm test' } },
        ],
      },
      { role: 'user', text: '<command-name>/review</command-name>\n<command-args>src/theme.ts</command-args>', toolUses: [] },
  ]
  on('session.messages', () => ({ value: transcript }))

  await $.classic.SessionStart({ source: 'resume', session_title: 'Dark mode toggle' })

  const { lines } = await draw($)
  // The first request says more than the short session title
  expect(goalOf(lines)).toBe('add a dark mode toggle')
  expect(lines).toContain('2 turns')
  expect(lines).toContain('add a dark mode toggle')
  expect(lines).toContain('Added the toggle.')
  expect(lines).toContain('1 edit · 1 command')
  expect(lines).toContain('/review src/theme.ts')
  expect(lines).toContain('No written answer')
})

test('Goal skips a compaction summary and keeps to three sentences', async ($, on) => {
  stubSession(on)
  stubPane(on)
  const transcript: SessionMessage[] = [
    { role: 'user', text: 'This session is being continued from a previous conversation. Summary: 1. Primary request…', toolUses: [] },
    { role: 'user', text: '<command-name>/effort</command-name>', toolUses: [] },
    {
      role: 'user',
      text: 'Build a session pane. It shows usage. It shows PRs. It also shows tasks and much more detail.',
      toolUses: [],
    },
  ]
  on('session.messages', () => ({ value: transcript }))

  await start($)

  const { lines } = await draw($)
  expect(goalOf(lines)).toBe('Build a session pane. It shows usage. It shows PRs.')
  expect(lines).toContain('Continued from an earlier conversation')
})

test('Goal reads a compaction summary\'s stated request', async ($, on) => {
  stubSession(on)
  stubPane(on)
  const summary = [
    'This session is being continued from a previous conversation that ran out of context.',
    '',
    'Summary:',
    '1. **Primary request and intent**',
    '   - The user wants to build their own Claude Code mod: a side pane that tracks the session\'s work, PRs and tasks.',
    '   - They asked for a short spec session before building.',
    '2. **Key technical concepts**',
    '   - Mods are plugins.',
  ].join('\n')
  const transcript: SessionMessage[] = [
    { role: 'user', text: summary, toolUses: [] },
    { role: 'user', text: 'continue', toolUses: [] },
  ]
  on('session.messages', () => ({ value: transcript }))

  await start($)

  const { lines } = await draw($)
  expect(goalOf(lines)).toBe(
    "The user wants to build their own Claude Code mod: a side pane that tracks the session's work, PRs and tasks. They asked for a short spec session before building.",
  )
})

test('Goal sentences stay whole around file names, parentheses and quotes', () => {
  expect(briefOf('Lets implement the spec found here: ~/code/app/SPEC.md')).toBe(
    'Lets implement the spec found here: ~/code/app/SPEC.md',
  )
  expect(briefOf('Finish it before the demo (in 4 days). Do not do any work. Just analyze it. Then report back.')).toBe(
    'Finish it before the demo (in 4 days). Do not do any work. Just analyze it.',
  )
  expect(intentOf('1. Primary Request and Intent:\n   - Initial request (verbatim): "Fix the build. Make it GREEN."\n2. Next')).toBe(
    'Fix the build. Make it GREEN.',
  )
  const asked = (...texts: string[]) => texts.map((text, i) => ({ text, at: NOW + i }))
  expect(sessionGoalOf({ prompts: asked('/effort', '<command-name>/clear</command-name>', 'Add a dark mode toggle to settings') })?.text).toBe(
    'Add a dark mode toggle to settings',
  )
})

test('Goal follows the latest request, and short replies keep it', () => {
  const asked = (...texts: string[]) => texts.map((text, i) => ({ text, at: NOW + i * 60_000 }))
  const prompts = asked(
    'Build the session pane from the spec',
    'Make the files changed area a summary, it is getting long',
    'yes go ahead',
    'ok, sounds good to me',
    'Continued without a new prompt',
  )
  expect(sessionGoalOf({ prompts })).toEqual({
    text: 'Make the files changed area a summary, it is getting long',
    source: 'ask',
    at: NOW + 60_000,
  })
  // A plan approved after the request is newer, and a request after the plan is newer again
  expect(sessionGoalOf({ prompts, plan: { text: 'Plan: summary by folder', at: NOW + 120_000 } })?.source).toBe('plan')
  expect(sessionGoalOf({ prompts, plan: { text: 'Plan: summary by folder', at: NOW - 1 } })?.source).toBe('ask')
  // A /goal condition holds while it is set
  expect(sessionGoalOf({ prompts, goal: 'All tests pass' })?.text).toBe('All tests pass')
  // With no request yet, a compaction summary's stated request stands in
  expect(sessionGoalOf({ prompts: asked('yes', '/clear'), intent: 'Ship the pane.' })?.source).toBe('intent')
})

test('Now shows what Claude says it is doing, and Goal keeps the starting request', async ($, on) => {
  const clock = stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: 'I found the engine data I need. Next, I will write the code. Then I will run the tests.',
      toolUses: [{ name: 'Bash', input: { command: 'ls' } }],
      stopReason: 'tool_use' as const,
      usage: null,
    }
  })

  await start($)
  await $.turn.start({ text: 'Build the session pane from the spec', turnId: 't0' })
  await $.turn.complete({ turnId: 't0', answer: 'Done', durationMs: 1000, isAborted: false, reason: 'answer', usage: STEP_USAGE })
  await clock.advance(60_000)
  await $.turn.start({ text: 'Make the goal section keep up with the current goal', turnId: 't1' })
  await step($)

  const working = await draw($)
  expect(goalOf(working.lines)).toBe('Make the goal section keep up with the current goal')
  expect(working.lines).toContain('Initial'.padEnd(9))
  expect(working.lines.some(line => line.startsWith('Build the session pane from the spec'))).toBe(true)
  expect(working.lines).toContain('I found the engine data I need. Next, I will write the code.')

  // A short reply keeps the goal, and a new turn clears the old note
  await $.turn.complete({ turnId: 't1', answer: 'Done', durationMs: 1000, isAborted: false, reason: 'answer', usage: STEP_USAGE })
  await $.turn.start({ text: 'yes do it', turnId: 't2' })
  const replied = await draw($)
  expect(goalOf(replied.lines)).toBe('Make the goal section keep up with the current goal')
  expect(replied.lines).not.toContain('I found the engine data I need. Next, I will write the code.')
})

test('Timeline shows the five latest turns', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await start($)
  for (let i = 1; i <= 7; i++) await $.turn.start({ text: 'request number ' + i, turnId: 't' + i })

  const { lines } = await draw($)
  expect(lines).toContain('request number 7')
  expect(lines).toContain('request number 3')
  expect(lines).not.toContain('request number 2')
})

test('Recent commands show Claude\'s plain-words description, with the run and failed counts', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('tool.call', ($, e) =>
    e.tool === 'Bash' && e.command === 'false'
      ? { result: 'Exit code 1', text: 'Exit code 1', isError: true }
      : { result: { stdout: '', stderr: '', interrupted: false } },
  )

  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm test -- --runInBand test/auth', description: 'Run the auth tests' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  await $.tool.call({ tool: 'Bash', command: 'false' })

  const { texts, lines } = await draw($)
  expect(lines).toContain('Run the auth tests')
  expect(lines).not.toContain('npm test -- --runInBand test/auth')
  expect(lines).toContain('git status')
  const heading = lines.indexOf('Recent commands')
  expect(lines[heading + 1]).toBe('3 run · 1 failed')
  expect(texts.find(element => element.text === '1 failed')?.props.color).toBe('error')
})

test('Recent commands saved without a description get one from the transcript', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const transcript: SessionMessage[] = [
    {
      role: 'assistant',
      text: '',
      toolUses: [{ tool_use_id: 'call-1', tool: 'Bash', input: { command: 'git status', description: 'Show working tree status' } }],
    },
  ]
  on('session.messages', () => ({ value: transcript }))

  await start($)
  await $.turn.start({ text: 'check the repo', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git status', tool_use_id: 'call-1' })
  await $.turn.complete({ turnId: 't1', answer: 'Clean.', durationMs: 1000, isAborted: false, reason: 'answer', usage: STEP_USAGE })

  const { lines } = await draw($)
  expect(lines).toContain('Show working tree status')
  expect(lines).not.toContain('git status')
})

const SHELL_OUTPUT = '/tmp/claude/work/session/tasks/b1.output'

// Answers a background Bash call as the engine does, and the tail of its output
function stubBackground(on: On) {
  on('session.repo', () => ({ value: null }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[0] === 'tail' ? '\u001b[32mready\u001b[0m\nbuilding 10%\rbuilding 60%\n' : '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' && e.run_in_background) {
      return {
        result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
        text: 'Command running in background with ID: b1. Output is being written to: ' + SHELL_OUTPUT + '. You will be notified when it completes.',
      }
    }
    if (e.tool === 'Monitor') return { result: { taskId: 'm1', timeoutMs: 300_000 } }
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
}

test('Session is not idle while background shells run, and Activity shows what they write', async ($, on) => {
  const clock = stubSession(on)
  stubPane(on)
  stubBackground(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  await start($)
  await $.command.run(TOGGLE)
  await $.turn.start({ text: 'start the dev server', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true, tool_use_id: 'call-1' })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f log', description: 'Watch the log', timeout_ms: 300_000, tool_use_id: 'call-2' })

  const working = await draw($)
  expect(working.lines).toContain('+2 background')
  // A command still running in the background shows under Background only
  expect(working.lines).not.toContain('Recent commands')

  await $.turn.complete({ turnId: 't1', answer: 'Started', durationMs: 4_000, isAborted: false, reason: 'answer', usage: STEP_USAGE })
  await clock.advance(90_000)
  const waiting = await drawAfterPrCheck($, lines => lines.includes('› building 60%'))
  expect(waiting.lines).not.toContain('○ Idle')
  expect(waiting.lines).toContain('◐ Background · 1m 30s')
  expect(waiting.lines).toContain('2 running')
  // Each one is listed once, under Activity
  expect(waiting.lines.filter(line => line === 'Start the dev server')).toHaveLength(1)
  expect(waiting.lines).toContain('2 running')
  expect(waiting.lines).toContain('$ npm run dev')
  expect(waiting.lines).toContain('› building 60%')
  expect(waiting.lines).toContain('Last turn 4s · 43k in · 500 out')
  expect(waiting.texts.find(element => element.text === '  ◐')?.props.color).toBe('suggestion')

  // The shell's notification ends it; the monitor still runs
  await $.prompt.submit({
    text: '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>call-1</tool-use-id>\n<status>failed</status>\n<summary>Background command failed (exit code 1)</summary>\n</task-notification>',
    origin: { kind: 'task-notification' },
    wait: false,
  })
  const oneLeft = await draw($)
  expect(oneLeft.lines).toContain('1 running')
  expect(oneLeft.lines).toContain('failed after 1m 30s')
  expect(oneLeft.texts.find(element => element.text === '  ✗')?.props.color).toBe('error')

  // TaskStop ends the monitor, and the session reads as idle again
  await $.tool.call({ tool: 'TaskStop', task_id: 'm1' })
  const idle = await draw($)
  expect(idle.lines).toContain('○ Idle')
  expect(idle.lines).toContain('0 running')
  expect(idle.lines).toContain('monitor · killed after 1m 30s')
})

test('The turn-end list of background work ends shells it no longer names and adds ones the pane missed', async ($, on) => {
  stubSession(on)
  stubPane(on)
  stubBackground(on)

  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b9', type: 'shell', status: 'running', description: 'Run the test watcher', command: 'npm test -- --watch' }],
  })

  const { lines } = await draw($)
  expect(lines).toContain('1 running')
  expect(lines).toContain('Run the test watcher')
  expect(lines).toContain('$ npm test -- --watch')
  expect(lines.some(line => line.startsWith('completed after'))).toBe(true)
})

test('After a reload, background shells still running are found in the transcript', async ($, on) => {
  stubSession(on)
  stubPane(on)
  stubBackground(on)
  const started = (id: string, description: string) => ({
    tool_use_id: 'call-' + id,
    tool: 'Bash',
    input: { command: 'npm run ' + id, description, run_in_background: true },
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id },
    text: 'Command running in background with ID: ' + id + '. Output is being written to: /tmp/claude/tasks/' + id + '.output.',
  })
  const transcript = [
    { role: 'user', text: 'start the servers', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [started('api', 'Start the API'), started('web', 'Start the web app'), started('gone', 'Old job')] },
    { role: 'user', text: '<task-notification>\n<task-id>web</task-id>\n<status>completed</status>\n</task-notification>', toolUses: [] },
  ] as SessionMessage[]
  on('session.messages', () => ({ value: transcript }))
  on('fs.stat', ($, e) =>
    e.path.includes('gone') ? { deny: 'missing' } : { value: { kind: 'file', size: 10, mtimeMs: NOW, isLink: false } },
  )

  await start($)
  const { lines } = await draw($)
  expect(lines).toContain('◐ Background')
  expect(lines).toContain('1 running')
  expect(lines).toContain('Start the API')
  expect(lines).not.toContain('Start the web app')
  expect(lines).not.toContain('Old job')
})

test('Files changed sums the files by folder, most edited first', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('tool.call', () => ({ result: 'ok' }))
  const edit = (path: string, times = 1) =>
    Array.from({ length: times }, () => $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' }))

  await start($)
  for (const path of ['/work/src/ui/a.tsx', '/work/src/ui/b.tsx', '/work/src/ui/deep/c.tsx']) await Promise.all(edit(path, 2))
  await Promise.all(edit('/work/README.md', 3))
  await Promise.all(edit('/work/src/api/server.ts'))
  for (const path of ['/work/docs/a.md', '/work/test/a.test.ts', '/work/scripts/build.sh']) await Promise.all(edit(path))
  await Promise.all(edit('/Users/me/.claude/notes/todo.md'))

  const { lines } = await draw($)
  expect(lines).toContain('9 files · 14 edits')
  expect(lines).toContain('  src/ui/')
  expect(lines).toContain('3 files')
  expect(lines).toContain('×6')
  expect(lines).toContain('  README.md')
  expect(lines.some(line => line.includes('a.tsx'))).toBe(false)
  expect(lines.some(line => line.includes('server.ts'))).toBe(false)
  expect(lines).toContain('  +3 more files in 3 other places')
})

test('Initial keeps the first request after the timeline cap drops it', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))

  await start($)
  await $.turn.start({ text: 'Build the first version of the pane', turnId: 't0' })
  const one = await draw($)
  expect(one.lines).not.toContain('Initial'.padEnd(9))
  for (let i = 1; i <= 60; i++) await $.turn.start({ text: 'request number ' + i + ' for the pane', turnId: 't' + i })

  const { lines } = await draw($)
  expect(goalOf(lines)).toBe('request number 60 for the pane')
  expect(lines).toContain('Initial'.padEnd(9))
  expect(lines.some(line => line.startsWith('Build the first version'))).toBe(true)
})

test('Initial comes from the summary after a compaction, and is cut short', async ($, on) => {
  stubSession(on)
  stubPane(on)
  const long = 'The user wants to build a side pane that tracks the work, the PRs and the tasks of a session in great detail, with many long rows.'
  const transcript: SessionMessage[] = [
    {
      role: 'user',
      text: 'This session is being continued from a previous conversation.\n1. **Primary request and intent**\n   - ' + long + '\n2. **Key**',
      toolUses: [],
    },
    { role: 'user', text: 'Now add an Initial row to the pane', toolUses: [] },
  ]
  on('session.messages', () => ({ value: transcript }))

  await start($)

  const { lines } = await draw($)
  expect(goalOf(lines)).toBe('Now add an Initial row to the pane')
  const started = lines.find(line => line.startsWith('The user wants to build'))
  expect(started).toBeDefined()
  expect(lines.join('\n')).not.toContain('many long rows')
})

test('PRs shows at most six, the branch PR first and then the latest opened, each once', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('agent.list', () => ({ value: [] }))
  on('session.repo', () => ({ value: { root: '/work', remote: 'git@github.com:acme/app.git', internal: false, name: null } }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: OPEN_PR, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const urlOf = (command: string) => 'https://github.com/acme/' + command.split(' ').pop()
  on('tool.call', ($, e) => {
    const url = e.tool === 'Bash' ? urlOf(e.command) : ''
    return { result: { stdout: url + '\n', stderr: '', interrupted: false }, text: url }
  })

  await start($)
  await $.command.run(TOGGLE)
  // The branch PR is one of them, and one is in another repository
  for (const pull of ['app/pull/42', 'app/pull/50', 'app/pull/51', 'app/pull/52', 'app/pull/53', 'app/pull/54', 'app/pull/55', 'api/pull/7']) {
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill ' + pull })
  }

  const { lines } = await drawAfterPrCheck($, lines => lines.includes('#42 Add the session pane'))
  expect(lines.filter(line => line.startsWith('#42'))).toEqual(['#42 Add the session pane'])
  expect(lines.filter(line => /^(app|api)#\d+$/.test(line))).toEqual(['app#52', 'app#53', 'app#54', 'app#55', 'api#7'])
  expect(lines).toContain('+2 earlier')
})

test('Tasks folds the finished ones of a long list into one row', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('tool.call', () => ({ result: {} }))

  await start($)
  const todos = Array.from({ length: 10 }, (_, i) => ({
    content: 'Task ' + (i + 1),
    status: i < 6 ? ('completed' as const) : i === 6 ? ('in_progress' as const) : ('pending' as const),
    activeForm: 'Doing task ' + (i + 1),
  }))
  await $.tool.call({ tool: 'TodoWrite', todos })

  const { lines } = await draw($)
  expect(lines).toContain('6/10')
  expect(lines).toContain('6 tasks done')
  expect(lines).not.toContain('Task 1')
  for (const name of ['Task 7', 'Task 8', 'Task 10']) expect(lines).toContain(name)
})

test('A subagent\'s background command stays under Recent commands, and empty token rows are left out', async ($, on) => {
  stubSession(on)
  stubPane(on)
  stubBackground(on)

  await start($)
  const fresh = await draw($)
  expect(fresh.lines).not.toContain('Tokens'.padEnd(9))
  const fromSubagent = { agentId: 'agent-1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true, ...fromSubagent })

  const { lines } = await draw($)
  expect(lines).toContain('Recent commands')
  expect(lines).toContain('Start the dev server')
  expect(lines).not.toContain('Background')
})

test('Opened PRs name their owner when two repositories share a name', async ($, on) => {
  stubSession(on)
  stubPane(on)
  on('agent.list', () => ({ value: [] }))
  on('session.repo', () => ({ value: null }))
  on('tool.call', ($, e) => {
    const url = e.tool === 'Bash' ? 'https://github.com/' + e.command.split(' ').pop() : ''
    return { result: { stdout: url + '\n', stderr: '', interrupted: false }, text: url }
  })

  await start($)
  await $.command.run(TOGGLE)
  for (const pull of ['acme/api/pull/7', 'other/api/pull/8']) await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill ' + pull })

  const { lines } = await draw($)
  expect(lines).toContain('acme/api#7')
  expect(lines).toContain('other/api#8')
})
