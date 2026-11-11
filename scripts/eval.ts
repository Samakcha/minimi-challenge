/**
 * Scenario eval: replays the kind of multi-day conversations in the brief
 * against the real model and search API, in an isolated data directory.
 *
 * The agent takes an injectable clock, so "Monday's" conversation can really
 * be held (with live search) and then referred to "on Wednesday".
 *
 *   npm run eval            # needs ANTHROPIC_API_KEY and TAVILY_API_KEY
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../src/config.js";
import { runTurn } from "../src/agent.js";
import { chooseProvider } from "../src/providers/index.js";
import { Store } from "../src/store.js";
import { addDays, localDate } from "../src/time.js";

const TZ = "UTC";
const now = new Date();
const today = localDate(now, TZ);

/** Most recent date strictly before today with the given weekday (0=Sun). */
function lastWeekday(dow: number, minDaysBack = 1): string {
  for (let i = minDaysBack; i < 14; i++) {
    const d = addDays(today, -i);
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === dow) return d;
  }
  throw new Error("unreachable");
}
const at = (ymd: string, hh = 10) => new Date(`${ymd}T${String(hh).padStart(2, "0")}:00:00Z`);
const pretty = (ymd: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${ymd}T12:00:00Z`));

const monday = lastWeekday(1);
const tuesday = lastWeekday(2, 2); // "last Tuesday", at least 2 days back

interface Step {
  label: string;
  when: Date;
  newConversation: boolean;
  message: string;
  expect: string;
}

const steps: Step[] = [
  {
    label: "seed: CRM shortlist (Monday)",
    when: at(monday),
    newConversation: true,
    message: "We're a 20-person sales team. Shortlist 5 CRM tools for us with current pricing.",
    expect: "searches; table of 5 CRMs with per-seat prices and citations",
  },
  {
    label: "seed: Postgres hosting (last Tuesday)",
    when: at(tuesday, 15),
    newConversation: true,
    message: "What are good managed Postgres hosting options for a small SaaS, and what do they cost?",
    expect: "searches; Neon/Supabase/RDS/etc with prices and citations",
  },
  {
    label: "brief example 1",
    when: at(today, 11),
    newConversation: true,
    message: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
    expect: `recall_memory for ${monday}; searches with since=${monday}; per-tool changed/no-change verdicts`,
  },
  {
    label: "brief example 3",
    when: at(today, 12),
    newConversation: true,
    message: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?",
    expect: `resolves to ${tuesday}; recalls that answer; re-checks each price`,
  },
  {
    label: "brief example 2",
    when: at(today, 13),
    newConversation: true,
    message: `What did I ask you on ${pretty(tuesday)}? Is your answer still correct today?`,
    expect: "quotes the Postgres question; verifies claims one by one",
  },
  {
    label: "no memory for that date",
    when: at(today, 14),
    newConversation: true,
    message: `What did I ask you on ${pretty(addDays(today, -40))}?`,
    expect: "says plainly there is no conversation that day; mentions what memory does cover; invents nothing",
  },
];

async function main() {
  const choice = chooseProvider();
  if (!choice.provider || !config.keys.tavily) {
    console.error(choice.provider ? "Set TAVILY_API_KEY in .env to run the eval." : choice.problem);
    process.exit(1);
  }
  const provider = choice.provider;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-eval-"));
  const store = new Store(dir);
  console.log(`eval data dir: ${dir}\nprovider=${provider.id} model=${provider.model} effort=${provider.effortLabel} today=${today} monday=${monday} tuesday=${tuesday}\n`);

  let conv = store.create();
  for (const s of steps) {
    if (s.newConversation && conv.turns.length) conv = store.create(s.when);
    console.log(`\n━━ ${s.label} @ ${s.when.toISOString()}\n> ${s.message}\n  (expect: ${s.expect})\n`);
    const tools: string[] = [];
    for await (const ev of runTurn({ store, provider, conv, userText: s.message, tz: TZ, now: s.when })) {
      if (ev.type === "text") process.stdout.write(ev.text);
      if (ev.type === "tool") tools.push(`${ev.name} ${JSON.stringify(ev.input)}`);
      if (ev.type === "error") console.error(`\n[error] ${ev.message}`);
      if (ev.type === "done")
        console.log(
          `\n\n  ⏱ ${ev.stats.ms}ms total, first token ${ev.stats.firstTokenMs}ms, ${ev.stats.rounds} model call(s), cache read ${ev.stats.cacheReadTokens}/${ev.stats.inputTokens} input tokens`,
        );
    }
    for (const t of tools) console.log(`  🔧 ${t}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
