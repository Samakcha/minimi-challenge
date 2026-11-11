import { test } from "node:test";
import assert from "node:assert/strict";
import { MarkerParser } from "../src/citations.js";
import type { StepEvent } from "../src/providers/types.js";

function run(chunks: string[]): StepEvent[] {
  const p = new MarkerParser();
  const out = chunks.flatMap((c) => p.push(c)).concat(p.flush());
  // Merge adjacent text events for easy comparison.
  return out.reduce<StepEvent[]>((acc, e) => {
    const last = acc[acc.length - 1];
    if (e.type === "text" && last?.type === "text") last.text += e.text;
    else acc.push({ ...e });
    return acc;
  }, []);
}

test("extracts markers split across stream chunks", () => {
  assert.deepEqual(run(["Price is $20 [", "S1", "2] and rising."]), [
    { type: "text", text: "Price is $20 " },
    { type: "cite", refs: ["S12"] },
    { type: "text", text: " and rising." },
  ]);
});

test("handles multiple ids and adjacent markers", () => {
  assert.deepEqual(run(["A [S1, S3][S4]."]), [
    { type: "text", text: "A " },
    { type: "cite", refs: ["S1", "S3"] },
    { type: "cite", refs: ["S4"] },
    { type: "text", text: "." },
  ]);
});

test("leaves ordinary brackets and markdown links alone", () => {
  assert.deepEqual(run(["see [the docs](https://x.y) and [note] or [S"]), [
    { type: "text", text: "see [the docs](https://x.y) and [note] or [S" },
  ]);
});
