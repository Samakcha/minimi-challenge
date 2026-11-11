import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, humanDateTime, localDate, recentCalendar, utcOffset } from "../src/time.js";

test("localDate respects the user's timezone across midnight", () => {
  const at = "2026-11-10T20:00:00Z";
  assert.equal(localDate(at, "UTC"), "2026-11-10");
  assert.equal(localDate(at, "Asia/Kolkata"), "2026-11-11");
  assert.equal(localDate(at, "America/Los_Angeles"), "2026-11-10");
});

test("calendar lets the model read off 'last Tuesday' instead of computing it", () => {
  const cal = recentCalendar(new Date("2026-11-11T12:00:00Z"), "UTC");
  const lines = cal.split("\n");
  assert.equal(lines[0], "Wed 11 Nov = 2026-11-11 (today)");
  assert.equal(lines[1], "Tue 10 Nov = 2026-11-10 (yesterday)");
  assert.ok(cal.includes("Mon 9 Nov = 2026-11-09"));
  assert.ok(cal.includes("Tue 3 Nov = 2026-11-03"));
  assert.equal(lines.length, 15);
});

test("addDays handles month and year boundaries", () => {
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("human formatting and offsets", () => {
  assert.equal(humanDateTime("2026-11-03T09:05:00Z", "UTC"), "Tue 3 Nov 2026, 09:05");
  assert.equal(utcOffset(new Date("2026-11-11T00:00:00Z"), "Asia/Kolkata"), "+05:30");
  assert.equal(utcOffset(new Date("2026-11-11T00:00:00Z"), "UTC"), "+00:00");
});
