import type { Doc, ToolOutput } from "./providers/types.js";
import type { Conversation, Store, Turn } from "./store.js";
import { humanDate, humanDateTime, localDate } from "./time.js";

/**
 * Long-term memory across conversations.
 *
 * Two layers, chosen so the common case costs zero extra round trips:
 *  1. A compact *index* of past conversations (date, questions, what was
 *     searched) is injected at the start of every conversation. The model can
 *     often see straight away that "last Tuesday" = the Postgres chat on 3 Nov,
 *     and fire `recall_memory` and `web_search` in the same step.
 *  2. `recall_memory` returns the full, timestamped record of matching past
 *     exchanges — the user's words, the answer given then, the sources — as
 *     citable docs, so claims about the past are grounded too.
 *
 * Retrieval is deliberately lexical + date-filtered, not embeddings: personal
 * chat history is small, date is the dominant key in these questions, and the
 * model writes good keyword queries. See DESIGN.md.
 */

const STOP = new Set(
  "a an and are as at be but by can did do does for from has have how i if in is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your about any been into just more most since some still such".split(
    " ",
  ),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9.+#-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t));
}

function scoreTurn(terms: string[], t: Turn): number {
  if (terms.length === 0) return 0;
  const q = new Set(tokenize(t.user));
  const s = new Set(tokenize(t.searches.flatMap((x) => x.queries).join(" ")));
  const a = new Set(tokenize(t.answer));
  let score = 0;
  for (const term of terms) {
    if (q.has(term)) score += 3;
    if (s.has(term)) score += 2;
    if (a.has(term)) score += 1;
  }
  return score;
}

interface Hit {
  conv: Conversation;
  turn: Turn;
  score: number;
}

function allTurns(store: Store, excludeConvId?: string): Hit[] {
  const out: Hit[] = [];
  for (const conv of store.all()) {
    if (conv.id === excludeConvId) continue;
    for (const turn of conv.turns) {
      if (turn.status === "error") continue;
      out.push({ conv, turn, score: 0 });
    }
  }
  return out;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The index injected into the first turn of each conversation. */
export function memoryIndex(store: Store, excludeConvId: string, tz: string, limit = 40): string {
  const convs = store.all().filter((c) => c.id !== excludeConvId && c.turns.length > 0);
  if (convs.length === 0) {
    return "No past conversations are stored. You have no memory of earlier chats with this user.";
  }
  const first = convs.reduce((min, c) => (c.turns[0]!.at < min ? c.turns[0]!.at : min), convs[0]!.turns[0]!.at);
  const lines = convs.slice(0, limit).map((c) => {
    const start = humanDate(c.turns[0]!.at, tz);
    const end = humanDate(c.turns[c.turns.length - 1]!.at, tz);
    const when = start === end ? start : `${start} → ${end}`;
    const qs = c.turns
      .slice(0, 3)
      .map((t) => `"${truncate(t.user.replace(/\s+/g, " "), 100)}"`)
      .join("; ");
    const searched = [...new Set(c.turns.flatMap((t) => t.searches.flatMap((s) => s.queries)))].slice(0, 4);
    const more = c.turns.length > 3 ? ` (+${c.turns.length - 3} more turns)` : "";
    return `- [${c.id}] ${when}: ${qs}${more}${searched.length ? ` | searched: ${searched.join("; ")}` : ""}`;
  });
  const omitted = convs.length > limit ? `\n(${convs.length - limit} older conversations not listed — use recall_memory with a date range or query.)` : "";
  return `Memory covers ${convs.length} past conversation(s) from ${humanDate(first, tz)} to now. Newest first:\n${lines.join("\n")}${omitted}`;
}

export interface RecallArgs {
  from?: string;
  to?: string;
  query?: string;
  conversation_id?: string;
}

export interface RecallResult {
  hits: Hit[];
  note: string;
  nearest: Hit[];
}

export function recall(store: Store, args: RecallArgs, tz: string, excludeConvId?: string, limit = 6): RecallResult {
  let pool = allTurns(store, excludeConvId);
  if (args.conversation_id) pool = pool.filter((h) => h.conv.id === args.conversation_id);

  const hasRange = Boolean(args.from || args.to);
  const from = args.from ?? "0000-01-01";
  const to = args.to ?? args.from ?? "9999-12-31";
  const inRange = (h: Hit) => {
    const d = localDate(h.turn.at, tz);
    return d >= from && d <= to;
  };

  const terms = tokenize(args.query ?? "");
  for (const h of pool) h.score = scoreTurn(terms, h.turn);

  let hits = hasRange ? pool.filter(inRange) : pool;
  // With a date range the date is the primary key: keep everything in range,
  // rank by topic match. Without one, the topic must match.
  if (!hasRange && terms.length > 0) hits = hits.filter((h) => h.score > 0);
  hits.sort((a, b) => b.score - a.score || b.turn.at.localeCompare(a.turn.at));
  hits = hits.slice(0, limit);

  let note: string;
  let nearest: Hit[] = [];
  const rangeLabel = !hasRange ? "" : from === to ? ` on ${from}` : ` between ${from} and ${to}`;
  if (hits.length > 0) {
    note = `Found ${hits.length} past exchange(s)${rangeLabel}${terms.length ? ` matching "${args.query}"` : ""}.`;
  } else if (hasRange) {
    // People misremember dates. Offer the closest exchanges on either side,
    // preferring ones on the same topic.
    const before = pool
      .filter((h) => localDate(h.turn.at, tz) < from)
      .sort((a, b) => b.score - a.score || b.turn.at.localeCompare(a.turn.at))[0];
    const after = pool
      .filter((h) => localDate(h.turn.at, tz) > to)
      .sort((a, b) => b.score - a.score || a.turn.at.localeCompare(b.turn.at))[0];
    nearest = [before, after].filter((h): h is Hit => Boolean(h));
    note =
      `No stored exchanges${rangeLabel}.` +
      (nearest.length
        ? ` Nearest exchanges are shown below (not on the requested date).`
        : pool.length === 0
          ? " There are no other stored conversations at all."
          : "");
  } else {
    note = `No past exchanges match "${args.query ?? ""}".`;
  }
  return { hits, note, nearest };
}

/** Render a recall result as a tool output of citable docs. */
export function recallToOutput(r: RecallResult, tz: string, nextId: () => string): ToolOutput {
  const render = (h: Hit, label: string): Doc => {
    const searched = h.turn.searches.flatMap((s) => s.queries);
    const content = [
      `When: ${humanDateTime(h.turn.at, tz)} (${tz}); local date ${localDate(h.turn.at, tz)}.`,
      `User asked: ${h.turn.user}`,
      `My answer at that time${h.turn.status === "stopped" ? " (cut short)" : ""}:\n${truncate(h.turn.answer, 6000) || "(none)"}`,
    ];
    if (searched.length) content.push(`Searches I ran then: ${searched.join(" | ")}`);
    if (h.turn.sources.length)
      content.push(`Sources cited then: ${h.turn.sources.map((s) => `${s.title} <${s.url}>`).join("; ")}`);
    return {
      id: nextId(),
      source: `memory://${h.conv.id}/${h.turn.id}`,
      title: `${label} · ${humanDateTime(h.turn.at, tz)} · ${h.conv.title}`,
      content,
    };
  };
  return {
    header: r.note,
    docs: [
      ...r.hits.map((h) => render(h, "Earlier conversation")),
      ...r.nearest.map((h) => render(h, "Nearest earlier/later conversation")),
    ],
  };
}
