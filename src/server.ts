import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { runTurn } from "./agent.js";
import { chooseProvider } from "./providers/index.js";
import { Store } from "./store.js";
import { isValidTimeZone } from "./time.js";

/**
 * A deliberately small HTTP layer (no framework): static UI, a JSON API for
 * conversation history, and one streaming endpoint (Server-Sent Events) for
 * chat turns.
 */

const store = new Store(config.dataDir);
const choice = chooseProvider();
const busy = new Set<string>(); // conversations with a turn in flight

const STATIC: Record<string, [string, string]> = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["public/style.css", "text/css; charset=utf-8"],
  "/vendor/marked.js": ["node_modules/marked/lib/marked.esm.js", "text/javascript; charset=utf-8"],
  "/vendor/purify.js": ["node_modules/dompurify/dist/purify.es.mjs", "text/javascript; charset=utf-8"],
};

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 100_000): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: { conversationId?: string; message?: string; tz?: string };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "invalid JSON body" });
  }
  const message = body.message?.trim();
  if (!message) return json(res, 400, { error: "message is required" });
  if (message.length > 20_000) return json(res, 400, { error: "message too long" });
  const tz = isValidTimeZone(body.tz) ? body.tz : "UTC";
  if (!choice.provider) return json(res, 503, { error: choice.problem });
  const provider = choice.provider;

  // Unknown id (e.g. a never-saved chat from before a restart) → start fresh;
  // the "start" event tells the client its new id.
  const conv = (body.conversationId && store.get(body.conversationId)) || store.create();
  if (busy.has(conv.id)) return json(res, 409, { error: "a reply is already in progress in this conversation" });

  busy.add(conv.id);
  const abort = new AbortController();
  // Client closed the tab or pressed Stop → stop spending tokens.
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();
  const send = (ev: unknown) => res.write(`data: ${JSON.stringify(ev)}\n\n`);

  try {
    for await (const ev of runTurn({ store, provider, conv, userText: message, tz, signal: abort.signal })) {
      if (!abort.signal.aborted) send(ev);
    }
  } catch (err) {
    console.error("[server] chat stream failed:", err);
    send({ type: "error", message: "Internal error while generating the reply." });
  } finally {
    busy.delete(conv.id);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "GET" && STATIC[p]) {
      const [file, type] = STATIC[p];
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      return fs.createReadStream(path.join(config.rootDir, file)).pipe(res);
    }
    if (req.method === "GET" && p === "/api/health") {
      return json(res, 200, {
        provider: choice.provider?.id ?? null,
        model: choice.provider?.model ?? null,
        effort: choice.provider?.effortLabel ?? null,
        problem: choice.provider ? null : choice.problem,
        searchKey: Boolean(config.keys.tavily),
      });
    }
    if (req.method === "GET" && p === "/api/conversations") {
      return json(res, 200, store.list());
    }
    const m = /^\/api\/conversations\/([\w-]+)$/.exec(p);
    if (m) {
      const conv = store.get(m[1]!);
      if (!conv) return json(res, 404, { error: "not found" });
      if (req.method === "GET") {
        // The UI never needs the raw API transcript.
        const { apiMessages: _omit, ...rest } = conv;
        return json(res, 200, rest);
      }
      if (req.method === "DELETE") {
        if (busy.has(conv.id)) return json(res, 409, { error: "conversation is busy" });
        store.delete(conv.id);
        return json(res, 200, { ok: true });
      }
    }
    if (req.method === "POST" && p === "/api/chat") return await handleChat(req, res);
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error("[server]", err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
    else res.end();
  }
});

server.listen(config.port, () => {
  console.log(`\n  Chat agent running → http://localhost:${config.port}`);
  if (choice.provider) {
    const pv = choice.provider;
    console.log(`  provider=${pv.id} model=${pv.model} effort=${pv.effortLabel} data=${config.dataDir}`);
  } else {
    console.warn(`  ⚠ ${choice.problem}`);
  }
  if (!config.keys.tavily) console.warn("  ⚠ TAVILY_API_KEY is not set — web search will be unavailable");
  console.log();
});
