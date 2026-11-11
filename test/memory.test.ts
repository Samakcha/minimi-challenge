import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, type Turn } from "../src/store.js";
import { memoryIndex, recall, recallToOutput, tokenize } from "../src/memory.js";

function turn(at: string, user: string, answer: string, queries: string[] = []): Turn {
  return {
    id: Math.random().toString(36).slice(2, 8),
    at,
    user,
    answer,
    sources: [],
    searches: queries.length ? [{ queries, filters: {}, results: [], ms: 1 }] : [],
    status: "complete",
    ms: 1,
  };
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  const store = new Store(dir);
  const pg = store.create(new Date("2026-11-03T10:00:00Z"));
  pg.title = "Postgres hosting";
  pg.turns.push(turn("2026-11-03T10:00:00Z", "Cheapest managed Postgres hosting?", "Neon Launch is $19/mo; Supabase Pro $25/mo.", ["neon pricing", "supabase pricing"]));
  pg.updatedAt = "2026-11-03T10:00:00Z";
  const crm = store.create(new Date("2026-11-09T15:00:00Z"));
  crm.title = "CRM shortlist";
  crm.turns.push(turn("2026-11-09T15:00:00Z", "Shortlist 5 CRM tools for a 20-person sales team", "HubSpot, Pipedrive, Salesforce, Close, Attio.", ["best CRM for small sales team 2026"]));
  crm.updatedAt = "2026-11-09T15:00:00Z";
  const current = store.create(new Date("2026-11-11T09:00:00Z"));
  return { store, pg, crm, current, dir };
}

test("tokenize drops stopwords and folds plurals", () => {
  assert.deepEqual(tokenize("What are the CRM tools?"), ["crm", "tool"]);
});

test("recall by single date finds that day's exchange", () => {
  const { store, current } = fixture();
  const r = recall(store, { from: "2026-11-03" }, "UTC", current.id);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0]!.conv.title, "Postgres hosting");
});

test("recall by topic works without a date", () => {
  const { store, current } = fixture();
  const r = recall(store, { query: "CRM pricing" }, "UTC", current.id);
  // Both mention pricing, but the CRM chat matches more strongly and ranks first.
  assert.equal(r.hits[0]!.conv.title, "CRM shortlist");
  assert.ok(r.hits[0]!.score > (r.hits[1]?.score ?? 0));
  assert.equal(recall(store, { query: "kubernetes" }, "UTC", current.id).hits.length, 0);
});

test("an empty date returns the nearest exchanges, labelled, never invented ones", () => {
  const { store, current } = fixture();
  const r = recall(store, { from: "2026-11-05", query: "postgres" }, "UTC", current.id);
  assert.equal(r.hits.length, 0);
  assert.match(r.note, /No stored exchanges on 2026-11-05/);
  assert.deepEqual(r.nearest.map((h) => h.conv.title).sort(), ["CRM shortlist", "Postgres hosting"]);
  let n = 0;
  const out = recallToOutput(r, "UTC", () => `S${++n}`);
  assert.equal(out.docs.length, 2);
  assert.ok(out.docs.every((d) => d.title.startsWith("Nearest") && d.source.startsWith("memory://")));
  assert.deepEqual(out.docs.map((d) => d.id), ["S1", "S2"]);
});

test("date filtering uses the user's local date", () => {
  const { store, current } = fixture();
  // 15:00 UTC on 9 Nov is already 10 Nov in Tokyo.
  assert.equal(recall(store, { from: "2026-11-10" }, "Asia/Tokyo", current.id).hits.length, 1);
  assert.equal(recall(store, { from: "2026-11-10" }, "UTC", current.id).hits.length, 0);
});

test("memory index lists other conversations and excludes the current one", () => {
  const { store, current } = fixture();
  current.turns.push(turn("2026-11-11T09:00:00Z", "hello", "hi"));
  const idx = memoryIndex(store, current.id, "UTC");
  assert.match(idx, /2 past conversation\(s\) from Tue 3 Nov 2026/);
  assert.match(idx, /Shortlist 5 CRM tools/);
  assert.match(idx, /searched: neon pricing; supabase pricing/);
  assert.ok(!idx.includes('"hello"'));
});

test("empty memory says so explicitly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
  const store = new Store(dir);
  const c = store.create();
  assert.match(memoryIndex(store, c.id, "UTC"), /No past conversations/);
});

test("store persists and reloads conversations", () => {
  const { store, pg, dir } = fixture();
  store.save(pg);
  const again = new Store(dir);
  assert.equal(again.get(pg.id)?.turns[0]?.user, "Cheapest managed Postgres hosting?");
});
