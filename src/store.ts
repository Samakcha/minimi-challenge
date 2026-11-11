import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Persistence. One JSON file per conversation under data/conversations.
 *
 * Each conversation keeps two parallel records:
 *  - `apiMessages`: the exact, append-only transcript in the format of the
 *    provider that wrote it (`provider`) — reasoning, tool calls, results.
 *    Replaying it byte-for-byte keeps prompt caches warm and satisfies
 *    reasoning-replay checks. If the chat moves to another provider, it is
 *    rebuilt once from `turns` as plain text.
 *  - `turns`: a human-level record of each exchange (question, final answer
 *    with citations, what was searched, when). This is what long-term memory
 *    reads: it is small, timestamped, and independent of the API format.
 */

export interface SourceRef {
  title: string;
  url: string;
  published?: string | null;
}

export interface SearchLog {
  queries: string[];
  filters: Record<string, unknown>;
  results: SourceRef[];
  ms: number;
  error?: string;
}

export interface Turn {
  id: string;
  /** ISO instant the user sent the message. */
  at: string;
  user: string;
  /** Final answer as markdown, citation markers rendered as links. */
  answer: string;
  /** Sources the answer actually cited. */
  sources: SourceRef[];
  searches: SearchLog[];
  status: "complete" | "stopped" | "error";
  ms: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turns: Turn[];
  /** Provider whose wire format `apiMessages` is in. */
  provider?: string;
  apiMessages: unknown[];
  /** Counter for citation ids ([S1], [S2], …), unique within the conversation. */
  citeSeq?: number;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export class Store {
  private convs = new Map<string, Conversation>();
  private dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "conversations");
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as Conversation;
        this.convs.set(c.id, c);
      } catch (err) {
        console.warn(`[store] skipping unreadable ${f}:`, (err as Error).message);
      }
    }
  }

  create(now = new Date()): Conversation {
    const c: Conversation = {
      id: randomUUID().slice(0, 8),
      title: "New chat",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      turns: [],
      apiMessages: [],
    };
    this.convs.set(c.id, c);
    return c;
  }

  get(id: string): Conversation | undefined {
    return this.convs.get(id);
  }

  all(): Conversation[] {
    return [...this.convs.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  list(): ConversationSummary[] {
    return this.all()
      .filter((c) => c.turns.length > 0)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  delete(id: string): boolean {
    const existed = this.convs.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    return existed;
  }

  /** Atomic write: a crash mid-write never leaves a half-written conversation. */
  save(c: Conversation): void {
    const file = path.join(this.dir, `${c.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, file);
  }
}
