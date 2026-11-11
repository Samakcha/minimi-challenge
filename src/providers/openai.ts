import OpenAI from "openai";
import { docsAsText } from "../citations.js";
import type { Provider, StepEvent, StepResult, ToolCall, ToolSpec, TurnSession } from "./types.js";

type Item = OpenAI.Responses.ResponseInputItem;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * OpenAI via the Responses API. (Current GPT models only support tool calling
 * on Responses, not Chat Completions.)
 *  - `store: false` + encrypted reasoning items: the transcript is
 *    self-contained, so it survives restarts and needs no server-side state;
 *  - per-turn context goes in a `developer` message after the user's message;
 *  - tool results are plain text with [S#] ids; the model cites with markers.
 */
export function openaiProvider(opts: { model: string; effort: Effort; apiKey: string; tools: ToolSpec[] }): Provider {
  let client: OpenAI | null = null;
  const api = () => (client ??= new OpenAI({ apiKey: opts.apiKey }));
  const tools: OpenAI.Responses.FunctionTool[] = opts.tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));

  return {
    id: "openai",
    model: opts.model,
    citations: "markers",
    effortLabel: opts.effort,
    textHistory: (pairs) => pairs.flatMap((p) => [
      { role: "user", content: p.user },
      { role: "assistant", content: p.assistant || "(no answer)" },
    ]),
    isAbort: (err) => err instanceof OpenAI.APIUserAbortError,
    describeError: (err) => describeOpenAIError(err, "OpenAI", "OPENAI_API_KEY"),
    startTurn({ history, system, userText, note }): TurnSession {
      const pending: Item[] = [
        { role: "user", content: userText },
        { role: "developer", content: note },
      ];
      return {
        messages: () => pending,
        addNote: (text) => void pending.push({ role: "developer", content: text }),
        addToolResults(results) {
          for (const { call, output } of results)
            pending.push({
              type: "function_call_output",
              call_id: call.id,
              output: output.isError ? `ERROR: ${output.header}` : docsAsText(output.header, output.docs),
            });
        },
        async *step(signal): AsyncGenerator<StepEvent, StepResult> {
          const stream = await api().responses.create(
            {
              model: opts.model,
              instructions: system,
              input: [...(history as Item[]), ...pending],
              tools,
              parallel_tool_calls: true,
              reasoning: { effort: opts.effort },
              store: false,
              include: ["reasoning.encrypted_content"],
              stream: true,
            },
            { signal },
          );
          let final: OpenAI.Responses.Response | null = null;
          for await (const ev of stream) {
            if (ev.type === "response.output_text.delta") yield { type: "text", text: ev.delta };
            else if (ev.type === "response.refusal.delta") yield { type: "text", text: ev.delta };
            else if (ev.type === "response.completed" || ev.type === "response.incomplete") final = ev.response;
            else if (ev.type === "response.failed") throw new Error(ev.response.error?.message ?? "OpenAI response failed");
            else if (ev.type === "error") throw new Error(ev.message);
          }
          if (!final) throw new Error("OpenAI stream ended without a response");

          pending.push(...(final.output as Item[]));
          const toolCalls: ToolCall[] = final.output
            .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call")
            .map((o) => ({ id: o.call_id, name: o.name, input: parseArgs(o.arguments) }));
          const refusal = final.output.some(
            (o) => o.type === "message" && o.content.some((c) => c.type === "refusal"),
          );
          const u = final.usage;
          return {
            toolCalls,
            refusal,
            usage: {
              input: u?.input_tokens ?? 0,
              cacheRead: u?.input_tokens_details?.cached_tokens ?? 0,
              output: u?.output_tokens ?? 0,
            },
          };
        },
      };
    },
  };
}

export function parseArgs(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __invalid_json: s };
  }
}

export function describeOpenAIError(err: unknown, vendor: string, keyVar: string): string | null {
  if (err instanceof OpenAI.AuthenticationError) return `The ${vendor} API key is invalid. Check ${keyVar} in .env.`;
  // Gemini reports a bad key as 400 INVALID_ARGUMENT rather than 401.
  if (err instanceof OpenAI.APIError && /api[ _-]?key/i.test(err.message))
    return `The ${vendor} API key was rejected. Check ${keyVar} in .env.`;
  if (err instanceof OpenAI.PermissionDeniedError) return `${vendor} refused the request (permission denied): ${err.message}`;
  if (err instanceof OpenAI.RateLimitError)
    return `Rate limited by ${vendor}${vendor === "Gemini" ? " (free-tier limits are low; wait a minute)" : ""}. ${err.message}`;
  if (err instanceof OpenAI.NotFoundError) return `${vendor} says the model was not found: ${err.message}. Set MODEL in .env.`;
  if (err instanceof OpenAI.APIConnectionError) return `Couldn't reach the ${vendor} API. Check your connection.`;
  if (err instanceof OpenAI.APIError) return `${vendor} API error ${err.status ?? ""}: ${err.message}`;
  return null;
}
