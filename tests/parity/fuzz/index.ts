// The differential fuzz suites, from a review of the idiomatic pass: each a
// generator of ABCs, saves or AVM1 blocks run on the reference, the
// candidate and its poison build like any other suite (run.ts). The
// standard sizes run the reviews' random counts, about three and a half
// minutes; --deep adds their exhaustive parts (every shape of reject, every
// small seed of parse, owners' pairs, more saves), about six, for changes
// to arenas, saving and loading, and compaction; --seed and --cases
// change the numbers.
import type { Results, Suite } from "../suite.ts";
import { avm1 } from "./avm1.ts";
import { bodies } from "./bodies.ts";
import { type FuzzOptions, Live, oracleHasAbcs } from "./common.ts";
import { floats } from "./floats.ts";
import { handlers } from "./handlers.ts";
import { link } from "./link.ts";
import { names } from "./names.ts";
import { oracleIr } from "./oracle-ir.ts";
import { parseDumps, parseOwners } from "./parse.ts";
import { reject } from "./reject.ts";
import { saved } from "./saved.ts";

export type { FuzzOptions } from "./common.ts";

const DOMAIN = [
  "domainReset",
  "domainAdd",
  "domainSummary",
  "domainVerifyAll",
  "domainModule",
  "domainIrAll",
];
const PARSE = ["abcDump", "poolDump", "domainReset", "domainAdd"];

type Generator = (live: Live, r: Results, o: FuzzOptions) => Promise<void>;

function suite(
  name: string,
  needs: string[],
  generator: Generator,
  o: FuzzOptions,
  unavailable?: () => string | null,
): Suite {
  return {
    name,
    build: "testing",
    needs,
    unavailable,
    run: (c, r, fresh) => generator(new Live(c, fresh), r, o),
  };
}

const noOracle = () =>
  oracleHasAbcs()
    ? null
    : "no ABCs in the oracle's cache (~/.cache/swf2es/oracle or SWF2ES_ORACLE_CACHE)";

export function fuzzSuites(o: FuzzOptions): Suite[] {
  return [
    suite("fuzz-reject", [...DOMAIN, "domainResolve"], reject, o),
    suite("fuzz-bodies", [...DOMAIN, "abcDump"], bodies, o),
    suite("fuzz-handlers", DOMAIN, handlers, o),
    suite("fuzz-floats", DOMAIN, floats, o),
    suite("fuzz-names", [...DOMAIN, "domainResolve", "domainTraits"], names, o),
    suite("fuzz-link", DOMAIN, link, o),
    suite("fuzz-oracle-ir", DOMAIN, oracleIr, o, noOracle),
    suite("fuzz-parse", PARSE, parseDumps, o),
    suite("fuzz-owners", PARSE, parseOwners, o),
    suite(
      "fuzz-saved",
      [
        "domainReset",
        "domainAdd",
        "domainChild",
        "domainFound",
        "domainModule",
        "domainEvict",
        "domainDrop",
        "domainRevive",
        "domainCompact",
        "domainSaveBytes",
        "domainSavedAbcBytes",
        "domainLoad",
        "domainLoadAbc",
        "domainLoadRebuild",
        "domainRebuildStep",
        "domainSummary",
        "domainState",
        "domainUsage",
      ],
      saved,
      o,
    ),
    suite(
      "fuzz-avm1",
      [
        "actionsModuleBytes",
        "actionsModuleEntries",
        "actionsModuleUnits",
        "actionsEmitEachBytes",
        "actionsEmitEach",
        "actionsUnitBytes",
        "actionsUnitLimits",
        "actionsHold",
        "actionsHeldCount",
        "actionsHeldEmitEachBytes",
        "actionsHeldUnitBytes",
        "actionsRelease",
        "avm1Dump",
      ],
      avm1,
      o,
    ),
  ];
}
