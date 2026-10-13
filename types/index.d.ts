declare module 'claude-code' {
  type SessionPaneTokens = {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }

  type SessionPaneUsage = {
    context: { tokens: number | null; window: number; percent: number | null }
    rateLimits: { kind: string; percentUsed: number; resetsAt: string | null }[]
    costUsd: number | null
  }

  type SessionPanePr =
    | { kind: 'pending' }
    | { kind: 'none'; reason: string }
    | {
        kind: 'pr'
        number: number
        title: string
        url: string
        state: string
        isDraft: boolean
        reviewDecision: string
        checks: 'pass' | 'fail' | 'pending' | 'none'
      }

  type SessionPaneTurnRecord = {
    id: string
    at: number | null
    prompt: string
    outcome: string | null
    durationMs: number | null
    edits: number
    commands: number
    isAborted: boolean
  }

  // A command Claude started in the background (Bash run_in_background, Ctrl+B
  // or Monitor), followed until its notification says it ended
  type SessionPaneShell = {
    id: string
    kind: 'shell' | 'monitor'
    label: string
    command: string | null
    toolUseId: string | null
    outputFile: string | null
    // Unknown for a shell found in the transcript after a reload
    startedAt: number | null
    endedAt: number | null
    status: 'running' | 'completed' | 'failed' | 'killed'
    lastLine: string | null
  }

  interface PluginState {
    'session-pane': {
      usage: SessionPaneUsage | null
      tokens: { main: SessionPaneTokens; subagents: SessionPaneTokens }
      turn: { startedAt: number } | null
      lastTurn: { durationMs: number; input: number; output: number; isAborted: boolean } | null
      files: { path: string; edits: number }[]
      commands: { id: string; command: string; description?: string | null; status: 'running' | 'background' | 'ok' | 'failed' }[]
      shells: SessionPaneShell[]
      agents: { id: string; type: string; description: string; status: string }[]
      pr: SessionPanePr
      createdPrs: { number: number; url: string }[]
      tasks: {
        id: string
        subject: string
        status: 'pending' | 'in_progress' | 'completed'
        activeForm: string | null
      }[]
      title: string | null
      goal: { condition: string; setAt: number; via: 'command' | 'tool' } | null
      plan: string | null
      planAt: number | null
      // What Claude last said it is doing, in the running turn
      note: string | null
      intent: string | null
      // The session's first request, captured once; it outlives the capped timeline
      start: { text: string; at: number | null } | null
      action: string | null
      timeline: SessionPaneTurnRecord[]
      startedAt: number | null
      totals: { turns: number; edits: number; commands: number; failed: number; subagents: number }
    }
  }
}
