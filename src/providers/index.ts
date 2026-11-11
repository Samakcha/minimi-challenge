import { config } from "../config.js";
import { TOOLS } from "../prompt.js";
import { anthropicProvider } from "./anthropic.js";
import { chatProvider } from "./chat.js";
import { openaiProvider } from "./openai.js";
import type { Provider } from "./types.js";

/**
 * Pick the model backend from whatever key is configured. PROVIDER forces a
 * choice; otherwise the first available of Anthropic → OpenAI → Gemini →
 * a custom OpenAI-compatible endpoint is used. MODEL overrides the default.
 */

export const DEFAULT_MODELS = {
  anthropic: "claude-opus-5-5",
  openai: "gpt-6.1-sol",
  gemini: "gemini-3.6-flash",
} as const;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
const effortOr = (fallback: Effort): Effort =>
  (EFFORTS as readonly string[]).includes(config.effort) ? (config.effort as Effort) : fallback;

/** Gemini's compatibility layer accepts minimal | low | medium | high. */
const geminiEffort = (): string => {
  const e = config.effort || "low"; // free tier: keep it snappy by default
  return e === "xhigh" || e === "max" ? "high" : ["minimal", "low", "medium", "high"].includes(e) ? e : "low";
};

export type ProviderChoice = { provider: Provider } | { provider: null; problem: string };

export function chooseProvider(): ProviderChoice {
  const { keys } = config;
  let id = config.provider;
  if (id === "auto") {
    id = keys.anthropic ? "anthropic"
      : keys.openai && !config.openaiBaseUrl ? "openai"
      : keys.gemini ? "gemini"
      : config.openaiBaseUrl ? "openai-compatible"
      : "";
  }
  const missing = (v: string) => ({ provider: null, problem: `PROVIDER=${id} needs ${v} in .env.` }) as const;

  switch (id) {
    case "anthropic":
      if (!keys.anthropic) return missing("ANTHROPIC_API_KEY");
      return {
        provider: anthropicProvider({
          model: config.model || DEFAULT_MODELS.anthropic,
          effort: effortOr("medium"),
          tools: TOOLS,
        }),
      };
    case "openai":
      if (!keys.openai) return missing("OPENAI_API_KEY");
      return {
        provider: openaiProvider({
          model: config.model || DEFAULT_MODELS.openai,
          // Measured on a pricing question: medium took 34s; low is the chat sweet spot.
          effort: effortOr("low"),
          apiKey: keys.openai,
          tools: TOOLS,
        }),
      };
    case "gemini":
      if (!keys.gemini) return missing("GEMINI_API_KEY");
      return {
        provider: chatProvider({
          id: "gemini",
          vendor: "Gemini",
          keyVar: "GEMINI_API_KEY",
          model: config.model || DEFAULT_MODELS.gemini,
          apiKey: keys.gemini,
          baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
          reasoningEffort: geminiEffort(),
          tools: TOOLS,
        }),
      };
    case "openai-compatible":
      if (!config.openaiBaseUrl) return missing("OPENAI_BASE_URL");
      if (!config.model) return missing("MODEL");
      return {
        provider: chatProvider({
          id: "openai-compatible",
          vendor: new URL(config.openaiBaseUrl).hostname,
          keyVar: "OPENAI_API_KEY",
          model: config.model,
          apiKey: keys.openai,
          baseURL: config.openaiBaseUrl,
          reasoningEffort: config.effort || undefined,
          tools: TOOLS,
        }),
      };
    case "":
      return {
        provider: null,
        problem: "No model API key found. Add one of ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to .env.",
      };
    default:
      return { provider: null, problem: `Unknown PROVIDER "${config.provider}". Use anthropic, openai, gemini or openai-compatible.` };
  }
}
