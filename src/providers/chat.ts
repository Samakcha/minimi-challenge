import OpenAI from "openai";
import { docsAsText } from "../citations.js";
import { describeOpenAIError, parseArgs } from "./openai.js";
import type { Provider, ProviderId, StepEvent, StepResult, ToolCall, ToolSpec, TurnSession } from "./types.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ToolCallMsg = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall & Record<string, unknown>;

/**
 * Any OpenAI-compatible Chat Completions endpoint: Google Gemini (its
 * official compatibility endpoint), OpenRouter, Groq, Together, DeepSeek,
 * Mistral, a local Ollama/LM Studio server, …
 *
 * This is the lowest common denominator, so it is deliberately conservative:
 *  - the per-turn context note rides inside the user message (not every
 *    server accepts several system messages);
 *  - unknown fields on streamed tool calls (e.g. Gemini's thought signatures,
 *    which must be echoed back or the next request fails) are kept and
 *    replayed verbatim;
 *  - `reasoning_effort` is only sent where we know it is accepted.
 */
export function chatProvider(opts: {
  id: Extract<ProviderId, "gemini" | "openai-compatible">;
  vendor: string;
  keyVar: string;
  model: string;
  apiKey: string;
  baseURL: string;
  reasoningEffort?: string;
  tools: ToolSpec[];
}): Provider {
  let client: OpenAI | null = null;
  const api = () => (client ??= new OpenAI({ apiKey: opts.apiKey || "not-needed", baseURL: opts.baseURL }));
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = opts.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  return {
    id: opts.id,
    model: opts.model,
    citations: "markers",
    effortLabel: opts.reasoningEffort ?? "default",
    textHistory: (pairs) => pairs.flatMap((p): Msg[] => [
      { role: "user", content: p.user },
      { role: "assistant", content: p.assistant || "(no answer)" },
    ]),
    isAbort: (err) => err instanceof OpenAI.APIUserAbortError,
    describeError: (err) => describeOpenAIError(err, opts.vendor, opts.keyVar),
    startTurn({ history, system, userText, note }): TurnSession {
      const pending: Msg[] = [{ role: "user", content: `<context>\n${note}\n</context>\n\n${userText}` }];
      return {
        messages: () => pending,
        addNote: (text) => void pending.push({ role: "user", content: `<context>\n${text}\n</context>` }),
        addToolResults(results) {
          for (const { call, output } of results)
            pending.push({
              role: "tool",
              tool_call_id: call.id,
              content: output.isError ? `ERROR: ${output.header}` : docsAsText(output.header, output.docs),
            });
        },
        async *step(signal): AsyncGenerator<StepEvent, StepResult> {
          const stream = await api().chat.completions.create(
            {
              model: opts.model,
              messages: [{ role: "system", content: system }, ...(history as Msg[]), ...pending],
              tools,
              stream: true,
              stream_options: { include_usage: true },
              ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort as "low" } : {}),
            },
            { signal },
          );

          let text = "";
          let finish: string | null = null;
          const calls: ToolCallMsg[] = [];
          const extras: Record<string, unknown> = {};
          const usage = { input: 0, cacheRead: 0, output: 0 };

          for await (const chunk of stream) {
            if (chunk.usage) {
              usage.input = chunk.usage.prompt_tokens ?? 0;
              usage.output = chunk.usage.completion_tokens ?? 0;
              usage.cacheRead = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            finish = choice.finish_reason ?? finish;
            const delta = choice.delta as Record<string, unknown> & typeof choice.delta;
            if (delta.content) {
              text += delta.content;
              yield { type: "text", text: delta.content };
            }
            for (const tc of delta.tool_calls ?? []) {
              const i = tc.index ?? calls.length;
              const cur = (calls[i] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.function.name += tc.function.name;
              if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
              // Keep vendor extensions (e.g. Gemini thought signatures) to echo back.
              for (const [k, v] of Object.entries(tc)) {
                if (!["index", "id", "type", "function"].includes(k) && v != null) cur[k] = mergeDeep(cur[k], v);
              }
            }
            for (const [k, v] of Object.entries(delta)) {
              if (!["role", "content", "tool_calls", "refusal", "reasoning", "reasoning_content"].includes(k) && v != null)
                extras[k] = mergeDeep(extras[k], v);
            }
          }

          const toolCalls = calls.filter(Boolean).map((c, i) => {
            if (!c.id) c.id = `call_${Date.now().toString(36)}_${i}`;
            return c;
          });
          pending.push({
            role: "assistant",
            content: toolCalls.length && !text ? null : text,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            ...extras,
          } as Msg);

          return {
            toolCalls: toolCalls.map((c): ToolCall => ({ id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) })),
            refusal: finish === "content_filter" && !text,
            usage,
          };
        },
      };
    },
  };
}

/** Streamed extension fields arrive in fragments: concatenate strings, merge objects. */
function mergeDeep(a: unknown, b: unknown): unknown {
  if (typeof a === "string" && typeof b === "string") return a + b;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b)) out[k] = mergeDeep(out[k], v);
    return out;
  }
  return b;
}
