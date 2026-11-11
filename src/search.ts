import type { ToolOutput } from "./providers/types.js";
import { config } from "./config.js";
import type { SourceRef } from "./store.js";

/**
 * The agent's one external tool: web search, backed by Tavily.
 *
 * Why a client-side tool instead of Anthropic's hosted web_search:
 *  - date filters (`since`, `recency`) — essential for "has anything changed
 *    since Monday?" questions;
 *  - we see the raw evidence, so every turn can record exactly what was
 *    searched and cited, and memory can show it back later;
 *  - one call fans out to several queries in parallel and de-duplicates URLs
 *    across them, which saves both a model round trip and input tokens;
 *  - each result is a citable doc: Claude gets native citations, other models
 *    cite by id ([S3]); either way no model ever types a URL from memory.
 */

export interface SearchArgs {
  queries: string[];
  recency?: "day" | "week" | "month" | "year";
  since?: string;
  topic?: "general" | "news";
  domains?: string[];
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string | null;
}

export interface SearchOutcome {
  results: (SourceRef & { content: string; score: number; query: string })[];
  ms: number;
  cached: boolean;
  errors: string[];
}

const cache = new Map<string, { at: number; results: TavilyResult[] }>();
const MAX_RESULTS_PER_QUERY = 6;
const MAX_TOTAL_RESULTS = 14;
const MAX_CHARS_PER_RESULT = 1500;

async function tavily(query: string, a: SearchArgs, signal?: AbortSignal): Promise<{ results: TavilyResult[]; cached: boolean }> {
  const body: Record<string, unknown> = {
    query,
    search_depth: "advanced",
    max_results: MAX_RESULTS_PER_QUERY,
    chunks_per_source: 3,
    topic: a.topic ?? "general",
    include_published_date: true,
  };
  if (a.recency) body.time_range = a.recency;
  if (a.since) body.start_date = a.since;
  if (a.domains?.length) body.include_domains = a.domains;

  const key = JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.searchCacheTtlMs) return { results: hit.results, cached: true };

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.keys.tavily}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`search provider returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { results?: TavilyResult[] };
  const results = json.results ?? [];
  cache.set(key, { at: Date.now(), results });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return { results, cached: false };
}

/** Providers return dates in mixed formats (ISO, RFC 2822). Normalise to YYYY-MM-DD. */
function normalizeDate(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? d : t.toISOString().slice(0, 10);
}

export async function webSearch(args: SearchArgs, signal?: AbortSignal): Promise<SearchOutcome> {
  const t0 = Date.now();
  if (!config.keys.tavily) {
    return { results: [], ms: 0, cached: false, errors: ["TAVILY_API_KEY is not set on the server, so web search is unavailable."] };
  }
  const queries = [...new Set(args.queries.map((q) => q.trim()).filter(Boolean))].slice(0, 5);
  const settled = await Promise.allSettled(queries.map((q) => tavily(q, args, signal)));

  const byUrl = new Map<string, SearchOutcome["results"][number]>();
  const errors: string[] = [];
  let allCached = true;
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      errors.push(`"${queries[i]}": ${(s.reason as Error)?.message ?? s.reason}`);
      allCached = false;
      return;
    }
    if (!s.value.cached) allCached = false;
    for (const r of s.value.results) {
      const url = r.url.replace(/#.*$/, "");
      const prev = byUrl.get(url);
      // Same page found by several queries: keep the best-scoring snippet.
      if (!prev || r.score > prev.score) {
        byUrl.set(url, {
          title: r.title || url,
          url,
          published: normalizeDate(r.published_date),
          content: (r.content ?? "").slice(0, MAX_CHARS_PER_RESULT),
          score: r.score,
          query: queries[i]!,
        });
      }
    }
  });

  const results = [...byUrl.values()].sort((a, b) => b.score - a.score).slice(0, MAX_TOTAL_RESULTS);
  return { results, ms: Date.now() - t0, cached: allCached && results.length > 0, errors };
}

/** Turn results into a tool output of citable docs. */
export function searchToOutput(args: SearchArgs, out: SearchOutcome, now: Date, nextId: () => string): ToolOutput {
  const filters = [
    args.since && `published since ${args.since}`,
    args.recency && `recency: past ${args.recency}`,
    args.topic === "news" && "news only",
    args.domains?.length && `domains: ${args.domains.join(", ")}`,
  ]
    .filter(Boolean)
    .join("; ");
  const header =
    `Web search run at ${now.toISOString()} for: ${args.queries.map((q) => `"${q}"`).join(", ")}` +
    (filters ? ` (${filters})` : "") +
    `. ${out.results.length} unique page(s).` +
    (out.errors.length ? ` Errors: ${out.errors.join("; ")}` : "") +
    (out.results.length === 0 && !out.errors.length ? " No results — try broader wording or drop the date filter." : "");

  return {
    header,
    docs: out.results.map((r) => ({
      id: nextId(),
      source: r.url,
      title: r.published ? `${r.title} (published ${r.published})` : `${r.title} (undated page)`,
      content: [r.content || "(no snippet)"],
    })),
  };
}
