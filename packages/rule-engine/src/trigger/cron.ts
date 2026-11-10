/**
 * Minimal cron expression support for {@link TimerTrigger}.
 *
 * Accepted forms (fields separated by whitespace):
 * - 5 fields: `minute hour day-of-month month day-of-week`
 * - 6 fields: `second minute hour day-of-month month day-of-week`
 * - 7 fields: `second minute hour day-of-month month day-of-week year`
 *
 * Each field accepts `*`, `?` (day fields), numbers, ranges `a-b`, steps `* /n` / `a-b/n` / `a/n`
 * and comma lists. Month and day-of-week accept English three-letter names; day-of-week accepts
 * 0-7 (0 and 7 = Sunday). When both day-of-month and day-of-week are restricted, a day matches
 * if either matches (Vixie cron semantics). As in Vixie cron, a day field whose text starts with
 * `*` (including steps such as `* /2`) counts as unrestricted for that rule, so `0 0 * /2 * 1`
 * means "Mondays". Name ranges must ascend (`MON-FRI`); wrap-around ranges such as `FRI-SUN` are
 * rejected (write `FRI-SAT,SUN`). Anything else (`L`, `W`, `#`) is rejected rather than silently
 * approximated.
 *
 * Daylight-saving transitions (Vixie cron semantics) for fixed-time schedules, i.e. when neither
 * the minute nor the hour field starts with `*`:
 * - a local time that occurs twice (clocks go back) fires only on its first occurrence;
 * - a local time skipped by a forward jump fires once, at the first instant after the jump.
 * Schedules with a wildcard minute or hour (`* /5 * * * *`, `0 * * * *`) simply follow elapsed
 * local time and are not adjusted.
 */
export interface CronSchedule {
  readonly expression: string;
  /** Next fire time strictly after `after`, or undefined when none exists within ~5 years. */
  next(after: Date): Date | undefined;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};
const DOW_NAMES: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

const SECOND: FieldSpec = { name: 'second', min: 0, max: 59 };
const MINUTE: FieldSpec = { name: 'minute', min: 0, max: 59 };
const HOUR: FieldSpec = { name: 'hour', min: 0, max: 23 };
const DOM: FieldSpec = { name: 'day-of-month', min: 1, max: 31 };
const MONTH: FieldSpec = { name: 'month', min: 1, max: 12, names: MONTH_NAMES };
const DOW: FieldSpec = { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES };
const YEAR: FieldSpec = { name: 'year', min: 1970, max: 2199 };

interface ParsedField {
  values: Set<number>;
  wildcard: boolean;
}

function parseValue(raw: string, spec: FieldSpec): number {
  const upper = raw.toUpperCase();
  if (spec.names && upper in spec.names) return spec.names[upper];
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid cron ${spec.name} value: ${raw}`);
  const n = Number(raw);
  if (n < spec.min || n > spec.max) {
    throw new Error(`Cron ${spec.name} value out of range (${spec.min}-${spec.max}): ${raw}`);
  }
  return n;
}

function parseField(raw: string, spec: FieldSpec, allowQuestion: boolean): ParsedField {
  if (raw === '?' && allowQuestion) raw = '*';
  const values = new Set<number>();
  // Vixie cron: a field starting with `*` (`*`, `*/n`) is unrestricted for the day-of-month /
  // day-of-week OR rule and marks a "wildcard" (interval) schedule for DST handling.
  const wildcard = raw.startsWith('*');
  for (const part of raw.split(',')) {
    if (part === '') throw new Error(`Invalid cron ${spec.name} field: ${raw}`);
    const [rangePart, stepPart, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`Invalid cron ${spec.name} field: ${raw}`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0) {
        throw new Error(`Invalid cron ${spec.name} step: ${part}`);
      }
      step = Number(stepPart);
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-');
      if (more !== undefined) throw new Error(`Invalid cron ${spec.name} range: ${part}`);
      start = parseValue(a, spec);
      end = parseValue(b, spec);
      if (start > end) throw new Error(`Invalid cron ${spec.name} range: ${part}`);
    } else {
      start = parseValue(rangePart, spec);
      end = stepPart !== undefined ? spec.max : start;
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, wildcard };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dow: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function makeClock(timezone?: string): (ms: number) => WallClock {
  if (!timezone) {
    return (ms) => {
      const d = new Date(ms);
      return {
        year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
        hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(), dow: d.getDay(),
      };
    };
  }
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
  } catch {
    throw new Error(`Invalid cron timezone: ${timezone}`);
  }
  return (ms) => {
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
    return {
      year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
      hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
      dow: WEEKDAYS[parts.weekday] ?? 0,
    };
  };
}

const MAX_SEARCH_MS = 5 * 366 * 24 * 3600 * 1000;
/** Longest forward clock jump inspected for skipped fire times. */
const MAX_GAP_MS = 4 * 3600 * 1000;

/** Local wall-clock time as if it were UTC (milliseconds), for ordering and offsets. */
function wallMs(c: WallClock): number {
  return Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
}

export function parseCron(expression: string, timezone?: string): CronSchedule {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error('Cron expression is required');
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 7) {
    throw new Error(`Invalid cron expression: expected 5-7 fields, got ${fields.length}`);
  }
  const withSeconds = fields.length >= 6;
  const f = withSeconds ? fields : ['0', ...fields];
  const second = parseField(f[0], SECOND, false);
  const minute = parseField(f[1], MINUTE, false);
  const hour = parseField(f[2], HOUR, false);
  const dom = parseField(f[3], DOM, true);
  const month = parseField(f[4], MONTH, false);
  const dow = parseField(f[5], DOW, true);
  if (dow.values.has(7)) dow.values.add(0);
  const year = f[6] !== undefined ? parseField(f[6], YEAR, false) : undefined;
  const clock = makeClock(timezone);

  const dayMatches = (c: WallClock): boolean => {
    if (!month.values.has(c.month)) return false;
    if (year && !year.values.has(c.year)) return false;
    const domOk = dom.values.has(c.day);
    const dowOk = dow.values.has(c.dow);
    if (dom.wildcard && dow.wildcard) return true;
    if (dom.wildcard) return dowOk;
    if (dow.wildcard) return domOk;
    return domOk || dowOk;
  };

  const timeMatches = (c: WallClock): boolean =>
    hour.values.has(c.hour) && minute.values.has(c.minute) && second.values.has(c.second);
  const fixedTime = !hour.wildcard && !minute.wildcard;
  const offsetAt = (ms: number): number => wallMs(clock(ms)) - ms;

  /** First whole second in (lo, hi] whose UTC offset differs from `loOffset`. */
  const transitionAt = (lo: number, hi: number, loOffset: number): number => {
    while (hi - lo > 1000) {
      const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
      if (offsetAt(mid) === loOffset) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  /** Whether a matching local time later than `afterWall` was skipped by the jump at `jumpAt`. */
  const skippedMatch = (jumpAt: number, afterWall: number): boolean => {
    const from = wallMs(clock(jumpAt - 1000)) + 1000;
    const to = Math.min(wallMs(clock(jumpAt)), from + MAX_GAP_MS);
    for (let w = from; w < to; w += 1000) {
      if (w <= afterWall) continue;
      const d = new Date(w);
      const c: WallClock = {
        year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
        hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), dow: d.getUTCDay(),
      };
      if (dayMatches(c) && timeMatches(c)) return true;
    }
    return false;
  };

  return {
    expression,
    next(after: Date): Date | undefined {
      const afterMs = Math.floor(after.getTime() / 1000) * 1000;
      const afterWall = wallMs(clock(afterMs));
      // Start at the next whole second.
      let t = afterMs + 1000;
      let prevT = afterMs;
      let prevOffset = afterWall - afterMs;
      const limit = t + MAX_SEARCH_MS;
      while (t <= limit) {
        const c = clock(t);
        const wall = wallMs(c);
        const offset = wall - t;
        if (fixedTime && offset > prevOffset) {
          // Clocks jumped forward between prevT and t: fire once right after the jump if a
          // matching local time fell into the skipped interval.
          const jumpAt = transitionAt(prevT, t, prevOffset);
          if (skippedMatch(jumpAt, afterWall)) return new Date(jumpAt);
        }
        prevT = t;
        prevOffset = offset;
        if (fixedTime && wall <= afterWall) {
          // Clocks went back: this local time already occurred (and was handled) before `after`.
          t += afterWall - wall + 1000;
          continue;
        }
        const secondsIntoDay = c.hour * 3600 + c.minute * 60 + c.second;
        if (!dayMatches(c)) {
          // Skip to (about) the next local midnight; keep an hour of slack for DST days.
          const remaining = 86400 - secondsIntoDay;
          t += (remaining > 3600 ? remaining - 3600 : remaining) * 1000;
          continue;
        }
        if (!hour.values.has(c.hour)) {
          t += (3600 - c.minute * 60 - c.second) * 1000;
          continue;
        }
        if (!minute.values.has(c.minute)) {
          t += (60 - c.second) * 1000;
          continue;
        }
        if (!second.values.has(c.second)) {
          t += 1000;
          continue;
        }
        return new Date(t);
      }
      return undefined;
    },
  };
}
