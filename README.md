# Minimi chat agent

A chat agent with live web search and a dated memory of past conversations. It is built for questions like *"On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?"*

It works with **Anthropic, OpenAI or Google Gemini** (the free Gemini key is enough), and with any OpenAI-compatible API.

## Run it

```bash
npm install
cp .env.example .env     # add ONE model key + TAVILY_API_KEY
npm run dev              # → http://localhost:3000
```

Needs Node ≥ 20.12.

| Variable | What for | Default model |
|---|---|---|
| `ANTHROPIC_API_KEY` **or** | Claude | `claude-opus-5-5` |
| `OPENAI_API_KEY` **or** | OpenAI (Responses API) | `gpt-6.1-sol` |
| `GEMINI_API_KEY` | Google Gemini (free tier OK) | `gemini-3.6-flash` |
| `TAVILY_API_KEY` | Web search, the agent's one external tool (free, no card: app.tavily.com) | |

If several model keys are set, the first one in the order above is used; set `PROVIDER=openai|gemini|anthropic` to choose. `MODEL` overrides the default model. To use OpenRouter, Groq, Ollama and similar, set `PROVIDER=openai-compatible`, `OPENAI_BASE_URL` and `MODEL` (see `.env.example`). The active provider and model are shown at the bottom of the sidebar.

## Other scripts

- `npm test`: unit tests for date grounding, memory recall and citation parsing (no keys needed)
- `npm run typecheck`: type-checks the TypeScript
- `npm run eval`: replays the brief's multi-day scenarios against the real APIs with a simulated clock, in a throwaway data dir

## Layout

```
src/server.ts            HTTP: static UI, conversation API, SSE chat endpoint
src/agent.ts             one turn, vendor-neutral: streaming loop, parallel tools, citations, commit
src/providers/           one adapter per API family, chosen from the keys present
  anthropic.ts             Claude Messages API (native citations, prompt cache, thinking replay)
  openai.ts                OpenAI Responses API (encrypted reasoning replay, developer notes)
  chat.ts                  any OpenAI-compatible Chat Completions API: Gemini, OpenRouter, Groq, Ollama…
src/prompt.ts            system prompt, tool schemas, per-turn time/memory note
src/search.ts            web_search → Tavily (fan-out, dedupe, date filters, cache)
src/memory.ts            memory index + recall_memory (date + keyword retrieval)
src/citations.ts         [S3]-style citation parsing for models without native citations
src/time.ts              timezone-aware dates, recent-days calendar
src/store.ts             JSON-file persistence (one file per conversation)
public/                  chat UI (vanilla JS, marked + DOMPurify)
```

Conversations are stored in `data/` and make up the agent's memory. Memory works across providers: switching from Gemini to Claude keeps everything. Deleting a chat in the sidebar also deletes it from memory.

See [DESIGN.md](DESIGN.md) for how it works and why it was built this way.
