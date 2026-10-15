// Date's local time in zones the oracle, run in UTC, never shows, as
// avmshell gives it: its 32-bit build asks localtime_r of a 32-bit time_t
// whether daylight saving is in effect, so it follows a zone's history
// (no daylight saving in Helsinki or Sydney in 1970) and stops at
// 2038-01-19, and every time before 1901-12-13 is read as that day. The
// standard offset is now's whatever the year, so neither Kolkata's nor
// any other zone's local mean time of 1900 shows.
//
// Flash on Windows (adl) differs: it applies the zone's rule of today to
// every year, 1900 and 2050 alike. The Tamarin baseline governs, so these
// are avmshell's, run with TZ=<zone> and the host's zoneinfo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./date-zone-probe.ts", import.meta.url));

const YEARS = [1900, 1969, 1970, 2026, 2037, 2038, 2039, 2050, 2100, 275760];
// The last second a 32-bit time_t holds, the first past it, and the same at its start.
const EDGES = [2147483647000, 2147483648000, -2147483648000, -2147483649000];

/** avmshell's timezoneOffset at noon UTC on January 1 and July 1 of each year, then at EDGES. */
const ZONES: Record<string, { years: [number, number][]; edges: number[] }> = {
  "Europe/Helsinki": {
    years: [
      [-120, -120],
      [-120, -120],
      [-120, -120],
      [-120, -180],
      [-120, -180],
      [-120, -120],
      [-120, -120],
      [-120, -120],
      [-120, -120],
      [-120, -120],
    ],
    edges: [-120, -120, -120, -120],
  },
  "America/New_York": {
    years: [
      [300, 300],
      [300, 240],
      [300, 240],
      [300, 240],
      [300, 240],
      [300, 300],
      [300, 300],
      [300, 300],
      [300, 300],
      [300, 300],
    ],
    edges: [300, 300, 300, 300],
  },
  "Australia/Sydney": {
    years: [
      [-600, -600],
      [-600, -600],
      [-600, -600],
      [-660, -600],
      [-660, -600],
      [-660, -600],
      [-600, -600],
      [-600, -600],
      [-600, -600],
      [-600, -600],
    ],
    edges: [-660, -600, -600, -600],
  },
  "Asia/Kolkata": {
    years: YEARS.map(() => [-330, -330]),
    edges: [-330, -330, -330, -330],
  },
};

const gmt = (offset: number) => {
  const east = Math.abs(offset);
  const hhmm = Math.trunc(east / 60) * 100 + (east % 60);
  return `GMT${offset <= 0 ? "+" : "-"}${String(hhmm).padStart(4, "0")}`;
};

for (const [zone, expected] of Object.entries(ZONES)) {
  test(`local time in ${zone} is avmshell's`, () => {
    const noons = YEARS.flatMap((y) => [Date.UTC(y, 0, 1, 12), Date.UTC(y, 6, 1, 12)]);
    const strings = YEARS.flatMap((y) => [`Jan 1 ${y} 12:00:00`, `Jul 1 ${y} 12:00:00`]);
    const run = spawnSync(
      process.execPath,
      [probe, JSON.stringify({ times: [...noons, ...EDGES], strings })],
      { encoding: "utf8", env: { ...process.env, TZ: zone } },
    );
    assert.equal(run.status, 0, run.stderr);
    const { offsets, formatted, parsed } = JSON.parse(run.stdout) as {
      offsets: number[];
      formatted: string[];
      parsed: number[];
    };

    assert.deepEqual(offsets, [...expected.years.flat(), ...expected.edges]);

    // Noon local is the offset away from noon UTC: no transition falls on January 1 or July 1.
    const offsetAtNoon = expected.years.flat();
    for (let i = 0; i < strings.length; i++) {
      assert.equal(parsed[i], noons[i] + offsetAtNoon[i] * 60000, strings[i]);
    }

    for (let i = 0; i < noons.length; i++) {
      const tail = ` ${gmt(offsetAtNoon[i])} ${YEARS[i >> 1]}`;
      assert.ok(formatted[i].endsWith(tail), `${formatted[i]} ends ${tail}`);
    }
  });
}
