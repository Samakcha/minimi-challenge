/**
 * The seam between the agent and a model vendor.
 *
 * The agent loop (agent.ts) is vendor-neutral: it asks a provider to run one
 * model step, gets back streamed text + citations + tool calls, runs the
 * tools, and hands results back. Each provider owns its own wire format and
 * transcript, so vendor features are used natively where they exist
 * (Anthropic: citations, prompt cache, thinking replay; OpenAI: Responses API
 * with encrypted reasoning replay) and degrade gracefully where they don't.
 */

export type ProviderId = "anthropic" | "openai" | "gemini" | "openai-compatible";

/** A citable document returned by a tool (a web page or a past exchange). */
export interface Doc {
  /** Short id the model can cite, e.g. "S3". Unique within a conversation. */
  id: string;
  /** URL, or memory://<conversation>/<turn> for past exchanges. */
  source: string;
  title: string;
  /** Non-empty text passages. */
  content: string[];
}

export interface ToolOutput {
  /** One-line summary shown to the model before the docs. */
  header: string;
  docs: Doc[];
  isError?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** Plain JSON Schema (kept to the subset every vendor accepts). */
  parameters: Record<string, unknown>;
}

export type StepEvent =
  | { type: "text"; text: string }
  /** The text just streamed is supported by these docs (ids or sources). */
  | { type: "cite"; refs: string[] };

export interface Usage {
  input: number;
  cacheRead: number;
  output: number;
}

export interface StepResult {
  toolCalls: ToolCall[];
  refusal: boolean;
  usage: Usage;
}

/** One user turn in progress. Nothing is persisted until the agent commits `messages()`. */
export interface TurnSession {
  step(signal?: AbortSignal): AsyncGenerator<StepEvent, StepResult>;
  addToolResults(results: Array<{ call: ToolCall; output: ToolOutput }>): void;
  /** An operator note mid-turn (e.g. "tool budget used up"). */
  addNote(text: string): void;
  /** Everything this turn appended, in the provider's own transcript format. */
  messages(): unknown[];
}

export interface Provider {
  id: ProviderId;
  model: string;
  /** "native": the API returns structured citations. "markers": the model writes [S3]. */
  citations: "native" | "markers";
  effortLabel: string;
  startTurn(opts: { history: unknown[]; system: string; userText: string; note: string }): TurnSession;
  /** Rebuild a transcript from plain text (used when a chat moves to another provider). */
  textHistory(pairs: Array<{ user: string; assistant: string }>): unknown[];
  isAbort(err: unknown): boolean;
  /** A user-facing explanation, or null to fall back to the generic message. */
  describeError(err: unknown): string | null;
}
