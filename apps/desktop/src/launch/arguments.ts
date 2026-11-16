// The command's arguments as Electron is given them, from the directory the
// command was run in.
import { resolve } from "node:path";

/** Switches whose value may follow them as an argument of its own, which is no path. */
const valued = (arg: string | undefined) => /^--(flashvars|param)$/i.test(arg ?? "");

/**
 * `given` for Electron: switches, URLs and the value after --flashvars or
 * --param as they are; any other argument a path, from `cwd`. What follows
 * "--" is an AIR application's own arguments, as they are.
 */
export function electronArguments(given: readonly string[], cwd: string): string[] {
  const end = given.indexOf("--");
  const own = end < 0 ? given : given.slice(0, end);
  return [
    ...own.map((a, i) =>
      a.startsWith("-") || /^https?:\/\//i.test(a) || valued(own[i - 1]) ? a : resolve(cwd, a),
    ),
    ...(end < 0 ? [] : given.slice(end)),
  ];
}
