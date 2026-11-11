import { randomUUID } from "node:crypto";
import { z } from "zod";
import { MarkerParser } from "./citations.js";
import { config } from "./config.js";
import { recall, recallToOutput } from "./memory.js";
import { systemPrompt, turnContext } from "./prompt.js";
import type { Doc, Provider, StepEvent, ToolCall, ToolOutput } from "./providers/types.js";
import { searchToOutput, webSearch } from "./search.js";
import type { Conversation, SourceRef, Store, Turn } from "./store.js";

export type AgentEvent =
  | { type: "start"; conversationId: string; turnId: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "tool_done"; id: string; name: string; summary: string; sources: SourceRef[]; ms: number; error?: string }
  | { type: "done"; turn: Turn; title: string; stats: TurnStats }
  | { type: "error"; message: string };

export interface TurnStats {
  ms: number;
  firstTokenMs: number | null;
  rounds: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

const SearchInput = z.object({
  queries: z.array(z.string().min(1)).min(1).max(5),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD")
    .optional(),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  topic: z.enum(["general", "news"]).optional(),
  domains: z.array(z.string()).optional(),
});

const RecallInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD").optional(),
  query: z.string().optional(),
  conversation_id: z.string().optional(),
});

/** Models are inconsistent about optional args: drop nulls and empty strings before validating. */
function clean(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
}

export interface RunTurnParams {
  store: Store;
  provider: Provider;
  conv: Conversation;
  userText: string;
  tz: string;
  /** Injectable clock, used by the eval script to replay multi-day scenarios. */
  now?: Date;
  signal?: AbortSignal;
}

/**
 * One user turn, independent of the model vendor: stream the model, run tool
 * calls in parallel, loop until it answers. Yields UI events as they happen;
 * commits the turn to the store only once it is complete (or as a text-only
 * record if stopped).
 */
export async function* runTurn(p: RunTurnParams): AsyncGenerator<AgentEvent> {
  const { store, conv, tz, provider } = p;
  const now = p.now ?? new Date();
  const t0 = Date.now();
  const turn: Turn = {
    id: randomUUID().slice(0, 8),
    at: now.toISOString(),
    user: p.userText,
    answer: "",
    sources: [],
    searches: [],
    status: "complete",
    ms: 0,
  };
  const stats: TurnStats = { ms: 0, firstTokenMs: null, rounds: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

  // A transcript written by another vendor can't be replayed: rebuild it once from plain text.
  if (conv.apiMessages.length && conv.provider !== provider.id) {
    conv.apiMessages = provider.textHistory(conv.turns.map((t) => ({ user: t.user, assistant: t.answer })));
  }
  conv.provider = provider.id;

  const session = provider.startTurn({
    history: conv.apiMessages,
    system: systemPrompt(provider.citations),
    userText: p.userText,
    note: turnContext({ now, tz, store, convId: conv.id, firstTurn: conv.turns.length === 0 }),
  });

  // Citations: docs get conversation-unique ids; cites resolve by id or source.
  const docs = new Map<string, Doc>();
  const nextId = () => `S${(conv.citeSeq = (conv.citeSeq ?? 0) + 1)}`;
  const citeNums = new Map<string, number>();
  const citeSource = new Map<string, SourceRef>();
  const citeMarks = (refs: string[]): string => {
    const marks: string[] = [];
    for (const ref of refs) {
      const doc = docs.get(ref) ?? [...docs.values()].find((d) => d.source === ref);
      if (!doc) continue; // unknown id: drop rather than show a broken link
      const mem = /^memory:\/\/([^/]+)\/(.+)$/.exec(doc.source);
      const url = mem ? `#memory/${mem[1]}/${mem[2]}` : doc.source;
      let n = citeNums.get(url);
      if (!n) {
        n = citeNums.size + 1;
        citeNums.set(url, n);
        citeSource.set(url, { title: doc.title.replace(/ \((published [^)]*|undated page)\)$/, ""), url });
      }
      const mark = `[${n}](${url})`;
      if (!marks.includes(mark)) marks.push(mark);
    }
    return marks.length ? ` ${marks.join(" ")}` : "";
  };

  yield { type: "start", conversationId: conv.id, turnId: turn.id };

  const emit = (text: string): AgentEvent => {
    stats.firstTokenMs ??= Date.now() - t0;
    turn.answer += text;
    return { type: "text", text };
  };

  try {
    for (let round = 0; ; round++) {
      stats.rounds = round + 1;
      if (round === config.maxToolRounds) {
        session.addNote("Tool budget for this turn is used up. Answer now with what you have and say briefly what you could not verify. Do not call tools.");
      }
      // Separate text written in an earlier round from this round's text.
      let needGap = turn.answer.trim().length > 0;
      const markers = provider.citations === "markers" ? new MarkerParser() : null;
      const handle = function* (ev: StepEvent): Generator<AgentEvent> {
        if (ev.type === "cite") {
          let t = citeMarks(ev.refs);
          if (/\s$/.test(turn.answer)) t = t.trimStart();
          if (t) yield emit(t);
        } else if (ev.text) {
          if (needGap) {
            needGap = false;
            yield emit("\n\n");
          }
          yield emit(ev.text);
        }
      };

      const it = session.step(p.signal);
      let res = await it.next();
      while (!res.done) {
        const evs = markers && res.value.type === "text" ? markers.push(res.value.text) : [res.value];
        for (const ev of evs) yield* handle(ev);
        res = await it.next();
      }
      if (markers) for (const ev of markers.flush()) yield* handle(ev);

      const step = res.value;
      stats.inputTokens += step.usage.input;
      stats.cacheReadTokens += step.usage.cacheRead;
      stats.outputTokens += step.usage.output;

      if (step.refusal) {
        if (!turn.answer.trim()) yield emit("I can't help with that request.");
        break;
      }
      if (step.toolCalls.length === 0) break;
      if (round >= config.maxToolRounds + 1) {
        // The model kept calling tools past the budget note. Don't leave an
        // unanswered tool call in the transcript: record the turn as text only.
        turn.status = "stopped";
        break;
      }
      if (round >= config.maxToolRounds) {
        session.addToolResults(step.toolCalls.map((call) => ({
          call,
          output: { header: "Tool budget used up. Answer now with what you have.", docs: [], isError: true },
        })));
        continue;
      }

      for (const c of step.toolCalls) yield { type: "tool", id: c.id, name: c.name, input: c.input };

      // All tool calls from one step run concurrently; results go back together.
      const outcomes = await Promise.all(step.toolCalls.map((c) => executeTool(c, { ...p, now }, nextId)));
      for (const o of outcomes) {
        for (const d of o.output.docs) docs.set(d.id, d);
        if (o.search) turn.searches.push(o.search);
        yield o.event;
      }
      session.addToolResults(outcomes.map((o) => ({ call: o.call, output: o.output })));
    }
  } catch (err) {
    if (p.signal?.aborted || provider.isAbort(err)) {
      turn.status = "stopped";
    } else {
      turn.status = "error";
      console.error(`[agent] turn failed (${provider.id}):`, err);
      yield { type: "error", message: provider.describeError(err) ?? (err instanceof Error ? err.message : String(err)) };
    }
  }

  turn.sources = [...citeSource.values()];
  turn.ms = stats.ms = Date.now() - t0;

  if (turn.status === "complete") {
    conv.apiMessages.push(...session.messages());
  } else if (turn.status === "stopped") {
    // Keep what the user saw, as plain text: no half-finished tool calls or
    // reasoning items enter the replayed transcript.
    conv.apiMessages.push(
      ...provider.textHistory([{ user: p.userText, assistant: turn.answer.trim() ? `${turn.answer}\n\n[answer cut short]` : "[stopped before answering]" }]),
    );
  }
  if (turn.status !== "error") {
    conv.turns.push(turn);
    if (conv.turns.length === 1) conv.title = titleFrom(p.userText);
    conv.updatedAt = new Date().toISOString();
    store.save(conv);
  }

  console.log(
    `[turn ${conv.id}/${turn.id}] ${provider.id}:${provider.model} ${turn.status} ${stats.ms}ms (first token ${stats.firstTokenMs ?? "-"}ms) ` +
      `rounds=${stats.rounds} searches=${turn.searches.length} in=${stats.inputTokens} (cache read ${stats.cacheReadTokens}) out=${stats.outputTokens}`,
  );
  if (turn.status !== "error") yield { type: "done", turn, title: conv.title, stats };
}

function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

interface ToolOutcome {
  call: ToolCall;
  output: ToolOutput;
  event: Extract<AgentEvent, { type: "tool_done" }>;
  search?: Turn["searches"][number];
}

async function executeTool(call: ToolCall, p: RunTurnParams & { now: Date }, nextId: () => string): Promise<ToolOutcome> {
  const t0 = Date.now();
  const fail = (msg: string): ToolOutcome => ({
    call,
    output: { header: msg, docs: [], isError: true },
    event: { type: "tool_done", id: call.id, name: call.name, summary: "failed", sources: [], ms: Date.now() - t0, error: msg },
  });

  if (call.name === "web_search") {
    const parsed = SearchInput.safeParse(clean(call.input));
    if (!parsed.success) return fail(`Invalid web_search input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const args = parsed.data;
    const out = await webSearch(args, p.signal);
    const sources = out.results.map(({ title, url, published }) => ({ title, url, published }));
    const search = {
      queries: args.queries,
      filters: { since: args.since, recency: args.recency, topic: args.topic, domains: args.domains },
      results: sources,
      ms: out.ms,
      ...(out.errors.length ? { error: out.errors.join("; ") } : {}),
    };
    if (out.results.length === 0 && out.errors.length) return { ...fail(`Web search failed: ${out.errors.join("; ")}`), search };
    return {
      call,
      output: searchToOutput(args, out, p.now, nextId),
      event: { type: "tool_done", id: call.id, name: call.name, summary: `${out.results.length} results${out.cached ? " (cached)" : ""}`, sources, ms: out.ms },
      search,
    };
  }

  if (call.name === "recall_memory") {
    const parsed = RecallInput.safeParse(clean(call.input));
    if (!parsed.success) return fail(`Invalid recall_memory input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const r = recall(p.store, parsed.data, p.tz, p.conv.id);
    return {
      call,
      output: recallToOutput(r, p.tz, nextId),
      event: {
        type: "tool_done",
        id: call.id,
        name: call.name,
        summary: r.hits.length ? `${r.hits.length} past exchange(s)` : r.nearest.length ? "nothing on that date; nearest shown" : "nothing found",
        sources: [...r.hits, ...r.nearest].map((h) => ({ title: h.conv.title, url: `#memory/${h.conv.id}/${h.turn.id}` })),
        ms: Date.now() - t0,
      },
    };
  }

  return fail(`Unknown tool: ${call.name}`);
}
