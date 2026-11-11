import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env if present (Node >= 20.12). Real environment variables win.
try {
  process.loadEnvFile?.(".env");
} catch {
  /* no .env file — fine, keys may come from the shell */
}

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k: string) => process.env[k]?.trim() || "";

export const config = {
  port: Number(env("PORT") || 3000),
  /** auto | anthropic | openai | gemini | openai-compatible */
  provider: (env("PROVIDER") || "auto").toLowerCase(),
  /** Overrides the provider's default model. */
  model: env("MODEL"),
  /** low | medium | high | xhigh | max. Empty → the provider's sensible default. */
  effort: env("EFFORT").toLowerCase(),
  keys: {
    anthropic: env("ANTHROPIC_API_KEY"),
    openai: env("OPENAI_API_KEY"),
    gemini: env("GEMINI_API_KEY") || env("GOOGLE_API_KEY"),
    tavily: env("TAVILY_API_KEY"),
  },
  /** For PROVIDER=openai-compatible (OpenRouter, Groq, Ollama, …). */
  openaiBaseUrl: env("OPENAI_BASE_URL"),
  rootDir: path.resolve(here, ".."),
  dataDir: path.resolve(env("DATA_DIR") || path.join(here, "..", "data")),
  /** Hard cap on model⇄tool round trips in one user turn. */
  maxToolRounds: 6,
  /** How long an identical web search is served from cache. */
  searchCacheTtlMs: 10 * 60 * 1000,
} as const;
