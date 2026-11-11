import Anthropic from "@anthropic-ai/sdk";
import type { Doc, Provider, StepEvent, StepResult, ToolCall, ToolOutput, ToolSpec, TurnSession } from "./types.js";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Claude via the Messages API. Uses the features that make this the best-
 * behaved backend:
 *  - tool results as `search_result` blocks → native, verifiable citations;
 *  - per-turn context as a mid-conversation `system` message, so the frozen
 *    system prompt + tools + append-only history are always a cache prefix;
 *  - thinking blocks replayed unchanged (preserved thinking);
 *  - server-side refusal fallback.
 */
export function anthropicProvider(opts: { model: string; effort: Effort; tools: ToolSpec[] }): Provider {
  let client: Anthropic | null = null;
  const api = () => (client ??= new Anthropic());
  const tools: Anthropic.Beta.BetaToolUnion[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  }));
  const fallback = /^claude-(opus-5|sonnet-5-5|fable-5)/.test(opts.model);

  return {
    id: "anthropic",
    model: opts.model,
    citations: "native",
    effortLabel: opts.effort,
    textHistory: (pairs) => pairs.flatMap((p) => [
      { role: "user", content: p.user },
      { role: "assistant", content: p.assistant || "(no answer)" },
    ]),
    isAbort: (err) => err instanceof Anthropic.APIUserAbortError,
    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is invalid. Check ANTHROPIC_API_KEY in .env.";
      if (err instanceof Anthropic.RateLimitError) return "Rate limited by Anthropic. Try again in a few seconds.";
      if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your connection.";
      if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
      return null;
    },
    startTurn({ history, system, userText, note }): TurnSession {
      const pending: MessageParam[] = [
        { role: "user", content: userText },
        { role: "system", content: note },
      ];
      return {
        messages: () => pending,
        addNote: (text) => void pending.push({ role: "system", content: text }),
        addToolResults(results) {
          pending.push({ role: "user", content: results.map(({ call, output }) => toolResult(call, output)) });
        },
        async *step(signal): AsyncGenerator<StepEvent, StepResult> {
          const stream = api().beta.messages.stream(
            {
              model: opts.model,
              max_tokens: 16000,
              system,
              tools,
              messages: [...(history as MessageParam[]), ...pending],
              thinking: { type: "adaptive" },
              output_config: { effort: opts.effort },
              cache_control: { type: "ephemeral" },
              ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
            },
            { signal },
          );
          const blockType = new Map<number, string>();
          const blockCites = new Map<number, string[]>();
          for await (const ev of stream) {
            if (ev.type === "content_block_start") {
              blockType.set(ev.index, ev.content_block.type);
            } else if (ev.type === "content_block_delta") {
              if (ev.delta.type === "text_delta") yield { type: "text", text: ev.delta.text };
              else if (ev.delta.type === "citations_delta" && ev.delta.citation.type === "search_result_location") {
                const list = blockCites.get(ev.index) ?? [];
                list.push(ev.delta.citation.source);
                blockCites.set(ev.index, list);
              }
            } else if (ev.type === "content_block_stop") {
              const refs = blockCites.get(ev.index);
              if (blockType.get(ev.index) === "text" && refs?.length) yield { type: "cite", refs };
            }
          }
          const msg = await stream.finalMessage();
          pending.push({ role: "assistant", content: msg.content as ContentParam[] });
          const toolCalls: ToolCall[] = msg.stop_reason === "tool_use"
            ? msg.content
                .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
                .map((b) => ({ id: b.id, name: b.name, input: b.input }))
            : [];
          return {
            toolCalls,
            refusal: msg.stop_reason === "refusal",
            usage: {
              input: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
              cacheRead: msg.usage.cache_read_input_tokens ?? 0,
              output: msg.usage.output_tokens,
            },
          };
        },
      };
    },
  };
}

function toolResult(call: ToolCall, out: ToolOutput): Anthropic.Beta.BetaToolResultBlockParam {
  if (out.isError) return { type: "tool_result", tool_use_id: call.id, is_error: true, content: out.header };
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: [{ type: "text", text: out.header }, ...out.docs.map(searchResult)],
  };
}

const searchResult = (d: Doc): Anthropic.Beta.BetaSearchResultBlockParam => {
  const content = d.content.filter((c) => c.trim());
  return {
    type: "search_result",
    source: d.source,
    title: d.title,
    content: (content.length ? content : ["(no text)"]).map((text) => ({ type: "text" as const, text })),
    citations: { enabled: true },
  };
};
