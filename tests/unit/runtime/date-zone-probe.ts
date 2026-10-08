// Run by date-zones.test.ts in a process of its own per zone, since the
// runtime keeps the zone's standard offset and node its zone once read:
// for each time, its offset and string, and for each local string, the time
// Date.parse gives, as JSON.
import { avm2 } from "@swf2es/runtime";

const rt = avm2.createRuntime();
const natives = avm2.builtinNatives(rt);
const native = (key: string) => natives[key](rt) as (this: unknown, ...args: unknown[]) => unknown;

const parse = native("Date.parse");
const get = native("Date#Date::_get");
const format = native("Date#Date::_toString");
const OFFSET = 16;

const { times, strings } = JSON.parse(process.argv[2]) as { times: number[]; strings: string[] };
console.log(
  JSON.stringify({
    offsets: times.map((t) => get.call({ $time: t }, OFFSET)),
    formatted: times.map((t) => format.call({ $time: t }, 0)),
    parsed: strings.map((s) => parse(s)),
  }),
);
