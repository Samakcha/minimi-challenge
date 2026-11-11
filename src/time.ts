/**
 * Date grounding. LLMs are unreliable at calendar arithmetic ("last Tuesday"
 * on a Wednesday), so we never ask the model to compute dates from scratch:
 * every turn carries the current time in the user's timezone plus a small
 * calendar of recent days it can read off directly.
 */

export function isValidTimeZone(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD for an instant, as seen in `tz`. */
export function localDate(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** "Tue 3 Nov 2026, 14:05" as seen in `tz`. */
export function humanDateTime(at: Date | string, tz: string): string {
  const d = new Date(at);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${date.replace(",", "")}, ${time}`;
}

/** "Tue 3 Nov 2026" as seen in `tz`. */
export function humanDate(at: Date | string, tz: string): string {
  return humanDateTime(at, tz).split(",")[0]!;
}

/** "+05:30" style offset of `tz` at instant `at`. */
export function utcOffset(at: Date, tz: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  const off = part?.replace("GMT", "") ?? "";
  return off === "" ? "+00:00" : off;
}

/** Shift a YYYY-MM-DD calendar date by `days` (pure calendar math, no tz). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

function weekdayOf(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/**
 * A compact calendar of the last `days` days, newest first, e.g.
 * "Wed 11 Nov (today) · Tue 10 Nov (yesterday) · Mon 9 Nov · …".
 * Reading a date off a list is far more reliable than computing it.
 */
export function recentCalendar(now: Date, tz: string, days = 15): string {
  const today = localDate(now, tz);
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = addDays(today, -i);
    const [, m, d] = ymd.split("-").map(Number) as [number, number, number];
    const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(
      new Date(Date.UTC(2000, m - 1, 1)),
    );
    const tag = i === 0 ? " (today)" : i === 1 ? " (yesterday)" : "";
    out.push(`${weekdayOf(ymd)} ${d} ${month} = ${ymd}${tag}`);
  }
  return out.join("\n");
}
