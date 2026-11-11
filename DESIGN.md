# DESIGN

## What the brief is really testing

All three sample questions combine **dated memory** ("On Monday we shortlisted…", "What did I ask on 3 November?") with **fresh verification** ("has anything changed since?", "is it still correct?"). A plain chatbot with search can't answer them: it has no record of the past, it gets weekday arithmetic wrong, and it can't tell "I found no change" apart from "nothing changed". So the architecture is built around three things: time, memory and evidence.

## How it works

```
browser ──SSE──▶ server.ts ──▶ agent.ts (one turn)
                                 │  frozen system prompt + tools   (always a cache hit)
                                 │  append-only transcript         (replayed byte-for-byte)
                                 │  + per-turn note: clock, calendar, memory index
                                 ▼
          providers/: Claude │ OpenAI │ Gemini / any OpenAI-compatible   (picked from the key present)
                                 ▼
                         model (streamed) ⇄ tools, run in parallel
                           ├─ web_search    → Tavily, 1-5 queries fanned out, deduped, date filters
                           └─ recall_memory → past turns by local date / keywords
                                 ▼
                     answer with citations → saved as a timestamped Turn
```

- **Any model key works.** `agent.ts` knows nothing about vendors. It asks a `Provider` to run one step and gets back streamed text, citations and tool calls. Three adapters cover the field. *Anthropic* uses the Messages API. *OpenAI* uses the Responses API, because current GPT models only call tools there; it runs with `store:false` and encrypted reasoning replay, so transcripts are self-contained. *Chat Completions* covers Gemini's official compatible endpoint and also OpenRouter, Groq, Ollama and others; it echoes vendor-specific extras such as Gemini's thought signatures, which are required on multi-turn tool calls. Each adapter keeps its own wire-format transcript. If a chat moves to another provider, the transcript is rebuilt once from the neutral turn records, so memory is shared across vendors.
- **Time grounding.** After each user message the agent appends a note with the local time and timezone (sent by the browser) and a 15-day calendar such as `Tue 3 Nov = 2026-11-03`. The model reads dates off the list instead of computing them. The prompt covers the edge cases: "last Tuesday" can mean either of two dates, and a date with no year means the most recent past one.
- **Memory has two layers.** (1) The first note of each conversation holds a compact index of past chats: dates, the user's questions and the queries searched. With it, the model can often call `recall_memory` and `web_search` *in the same step*, with no extra round trip. (2) `recall_memory` returns the actual past exchange (when it happened, the user's words, the answer given then, its sources) as citable blocks. Claims about the past are therefore grounded the same way web facts are. When a date has nothing, the tool says so and returns the nearest exchanges, labelled as such. The prompt forbids inventing past conversations and asks the agent to still be useful (ask for the missing list, or answer for a sensible default).
- **Evidence and citations.** Every search or memory result is a doc with an id. Claude receives the docs as `search_result` blocks and returns native citations. Other models see `[S3] Title / Source / text` and cite with `[S3]`. A streaming parser pulls those markers out of the token stream, even when one is split across chunks. Either way the server turns citations into numbered links, the model never types a URL from memory, and an unknown id is dropped rather than shown as a broken link. Results carry publication dates, or are marked "undated page". For "changed since X" questions, the prompt pairs undated queries for the official pricing or docs pages with `since`/news queries (pricing pages have no publish date, so a date filter alone misses them). Answers report, for each claim, *still correct / changed (old → new) / couldn't verify*.
- **Speed.** Tokens stream to the browser over SSE. One `web_search` call fans out to up to 5 queries in parallel and dedupes URLs. The tools in a step run concurrently. The system prompt and tools never change, and the transcript is append-only, so every request after the first reads its prefix from the prompt cache (explicitly on Claude, automatically on OpenAI and Gemini). Identical searches are cached for 10 minutes. Reasoning effort can be changed in `.env` (`EFFORT`). Each turn logs total time, time to first token, model calls and cache-read tokens.
- **Robustness.** Each turn is staged and committed only when it completes, so a failed turn never leaves a half-finished tool call in history. A stopped turn is saved as plain text. Tool inputs are validated with zod, and errors go back to the model as `is_error` results so it can recover or tell the user. There is a hard cap of 6 tool rounds, Claude's refusal fallback, and a clear message when a key is missing or rate-limited. Closing the tab aborts the model call.

## Why these choices

- **Our own search tool rather than the hosted `web_search`:** we need date filters, the raw evidence for memory, fan-out with deduplication, and freedom to swap providers. Tavily returns relevant page extracts in the search call itself, so no separate fetch step is needed.
- **The raw transcript as the source of truth, not LLM summaries:** a summary loses exactly the details these questions ask about ("what did *you* say the price was?"). Raw turns are lossless and cost nothing extra to write. Recall is lexical plus date filtering because personal history is small, the date is the main key, and the model writes good keyword queries.
- **No framework.** It is about 1,800 lines of commented TypeScript on the official vendor SDKs and `node:http`. Every piece of behaviour is visible and explainable. Persistence is one JSON file per conversation, written atomically.
- **Thin adapters of our own, not a multi-provider framework.** A lowest-common-denominator SDK would hide exactly the details that matter here: Claude's native citations and cache control, OpenAI's encrypted reasoning items, and Gemini's thought signatures. About 150 lines per adapter keeps each vendor first-class.
- **One strong model per turn**, not a router plus small models. It makes fewer, better-targeted searches. Defaults are each vendor's balanced tier (`claude-opus-5-5`, `gpt-6.1-sol`, `gemini-3.6-flash`, which is free) at medium effort on Claude and low on OpenAI and Gemini (measured: on OpenAI, low cut time-to-first-words from 25s to 13s on a pricing question with no loss in quality), and `MODEL`/`EFFORT` override them.

## Considered and rejected

- **Embeddings / vector DB for memory:** extra infrastructure and an extra API key for little gain at personal scale. Date + keyword recall is more predictable for "on 3 November" questions.
- **A separate planner/verifier agent pass:** roughly doubles latency. The checks ("re-verify each claim", "no change ≠ unchanged") live in the prompt and the tool design instead.
- **LLM-written memory summaries after each turn:** costs an extra model call and can drift from what was actually said. Rejected in favour of raw turns plus an index built without a model.
- **Always-on page fetching / a crawler:** slow, and Tavily's advanced extracts are usually enough.
- **Putting the clock in the system prompt:** that would break prompt caching on every request. It goes in an appended message instead (`system` on Claude, `developer` on OpenAI, `<context>` in the user message for generic endpoints that allow only one system message).
- **Chat Completions for OpenAI too:** fewer adapters, but current GPT models don't call tools there.

## With another week

1. **An eval harness with scoring.** `npm run eval` already replays the brief's multi-day scenarios with a simulated clock. Next: an LLM-judge rubric (date resolved correctly? memory faithful? claims cited? stale info flagged?) and tracking latency/cost per change.
2. **Structured claim snapshots.** At answer time, store `{entity, attribute, value, source, as_of}` for each priced or versioned fact, then answer "what changed since" with a real diff instead of comparing prose.
3. **Proactive change watching:** "tell me if any of these 5 CRMs changes pricing" as a scheduled re-check against those snapshots.
4. **A page-fetch fallback** for when extracts are thin (pricing tables are often rendered in JS), plus a second search provider for failover.
5. **Provider failover** (e.g. Gemini free tier hits 429 → retry the turn on the next configured key), using the plain-text transcript rebuild that already exists.
6. **Context management for very long chats** (server-side clearing of old tool results), multi-user auth, and SQLite with FTS once history grows.
