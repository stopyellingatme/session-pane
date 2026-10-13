// Works out what a session is working toward now from what the user wrote, in
// one to three sentences, without calling a model. Pure functions, so tests and scripts can
// run them on real transcripts.

const MAX_GOAL = 300
// A first sentence longer than the goal limit is kept whole up to this length
const MAX_SENTENCE = 500
const MAX_SENTENCES = 3
const CONTINUATION = 'This session is being continued from a previous conversation'

export const CONTINUED = 'Continued from an earlier conversation'
// A turn with no typed prompt, as after a background task's notification
export const NO_PROMPT = 'Continued without a new prompt'

// A reply that answers Claude rather than asking for something new: it keeps
// the goal the session already has
const ACK = /^(yes|yeah|yep|yup|no|nope|ok|okay|k|sure|go|go ahead|do it|continue|proceed|carry on|sounds good|looks good|lgtm|great|thanks|thank you|perfect|cool|nice|good|right|correct|agreed|approved?)\b[\s\S]{0,40}$/i

// The summary Claude Code writes when it compacts a conversation arrives as a
// user message
export function isContinuation(text: string): boolean {
  return text === CONTINUED || text.trimStart().startsWith(CONTINUATION)
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat
}

// Drops a quote mark left unpaired at either end, as when a quoted request
// is split into sentences
function unquote(sentence: string): string {
  const text = sentence.trim()
  if ((text.match(/["“”]/g) ?? []).length % 2 === 0) return text
  return text.replace(/^["“]/, '').replace(/["”](?=[.!?]?$)/, '').trim()
}

// Sentences of plain text: list markers and Markdown are dropped, each line
// ends a sentence, and a period ends one only when a space follows it, so
// `SPEC.md` and `v2.1` stay whole
export function sentencesOf(text: string): string[] {
  return text
    .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .split('\n')
    .map(line =>
      line
        .replace(/^\s*(#+|[-*>]|\d+[.)])\s+/, '')
        .replace(/\*\*|`/g, '')
        .trim(),
    )
    .filter(Boolean)
    .flatMap(line => line.split(/(?<=[.!?]["”]?)\s+/))
    .map(unquote)
    // A sentence that only introduces what follows, such as "Request 1:", says
    // nothing by itself
    .filter(sentence => /[a-z]{2}/i.test(sentence) && !sentence.endsWith(':'))
}

// The first sentences of a text, up to three and about 300 characters
export function briefOf(text: string): string | null {
  const kept: string[] = []
  for (const sentence of sentencesOf(text)) {
    if (kept.length === MAX_SENTENCES) break
    if (kept.length > 0 && [...kept, sentence].join(' ').length > MAX_GOAL) break
    if (kept.length === 0 && sentence.length > MAX_SENTENCE) return clip(sentence, MAX_SENTENCE)
    kept.push(sentence)
  }
  if (kept.length === 0) return null
  // Lines without end punctuation get a period where they join the next one
  return kept.map((sentence, i) => (i < kept.length - 1 && !/[.!?]["”]?$/.test(sentence) ? sentence + '.' : sentence)).join(' ')
}

// The "Primary request and intent" part of a compaction summary, which states
// what the session set out to do
export function intentOf(summary: string): string | null {
  const section = /primary request and intent\W*\n?([\s\S]*?)(?=\n\s*\d+\.\s|\n#+\s|$)/i.exec(summary)
  if (!section?.[1]) return null
  // Summaries often lead a request with a short label, as in
  // `Initial request (verbatim): "..."`; the request itself is what counts
  const lines = section[1]
    .split('\n')
    .map(line =>
      line
        .replace(/\*\*/g, '')
        .replace(/^\s*([-*]|\d+[.)])\s+/, '')
        .replace(/^[^.!?:"“]{1,50}:\s+(?=["“])/, ''),
    )
  return briefOf(lines.join('\n'))
}

// A prompt that can state the session's goal: not a slash command, not a
// compaction summary, not a short reply, and long enough to say something
export function isAsk(prompt: string): boolean {
  const text = prompt.trim()
  return (
    !text.startsWith('/') &&
    !text.startsWith('<') &&
    !isContinuation(text) &&
    text !== NO_PROMPT &&
    !ACK.test(text) &&
    text.split(/\s+/).length >= 4
  )
}

export type GoalSource = 'goal' | 'plan' | 'ask' | 'intent' | 'title'

// What the session works toward now. A /goal condition holds while it is set.
// Otherwise the newer of the approved plan and the latest request wins, and a
// compaction summary's stated request or the session title stands in when the
// user has asked for nothing yet. A time of null is older than any time.
export function goalOf(sources: {
  goal?: string | null
  plan?: { text: string; at: number | null } | null
  intent?: string | null
  prompts: readonly { text: string; at: number | null }[]
  title?: string | null
}): { text: string; source: GoalSource; at: number | null } | null {
  const brief = (text: string, source: GoalSource, at: number | null) => {
    const kept = briefOf(text)
    return kept ? { text: kept, source, at } : null
  }
  if (sources.goal) return brief(sources.goal, 'goal', null)
  const ask = [...sources.prompts].reverse().find(prompt => isAsk(prompt.text))
  const plan = sources.plan
  if (plan && (!ask || (plan.at ?? -Infinity) >= (ask.at ?? -Infinity))) return brief(plan.text, 'plan', plan.at)
  if (ask) return brief(ask.text, 'ask', ask.at)
  if (sources.intent) return { text: sources.intent, source: 'intent', at: null }
  return sources.title ? { text: sources.title, source: 'title', at: null } : null
}

// What the session set out to do: the first real request, or the summary's
// stated request when compaction has removed it. Kept apart from the prompt
// list, which is capped, so it does not drift as old turns fall out.
export function startOf(sources: {
  intent?: string | null
  prompts: readonly { text: string; at: number | null }[]
}): { text: string; at: number | null } | null {
  if (sources.intent) return { text: sources.intent, at: null }
  const first = sources.prompts.find(prompt => isAsk(prompt.text))
  const kept = first ? briefOf(first.text) : null
  return first && kept ? { text: kept, at: first.at } : null
}

// What Claude says it is doing, from the text it writes before its tool calls:
// its first sentence or two
export function noteOf(text: string): string | null {
  const kept: string[] = []
  for (const sentence of sentencesOf(text)) {
    if (kept.length === 0 && sentence.length > 200) return clip(sentence, 200)
    if (kept.length === 2 || [...kept, sentence].join(' ').length > 200) break
    kept.push(sentence)
  }
  return kept.length > 0 ? kept.join(' ') : null
}
