// How a Tamarin test of swf2es' is scored against avmshell's: swf2es.ts
// scores its runs with these, and the site's compatibility page its
// baselines, so that the two count alike.

/** avmshell's result for a test, as run.ts records it in baseline.json. */
export interface Avmshell {
  compiled: boolean;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
}

/** What swf2es did with one test. */
export interface Outcome {
  passed: number;
  failed: number;
  /**
   * How it ended, as avmshell's exit code: 0, 1 for a VerifyError or an AS3
   * exception nothing caught, 124 for a timeout; null if the host stopped it.
   */
  exitCode: number | null;
  /** What of the host's stopped it, if anything: an error, or its worker dying. */
  error: string | null;
}

/** A test in swf2es-baseline.json: its outcome, passed and failed null when not compared. */
export type Recorded = Omit<Outcome, "passed" | "failed"> & {
  passed: number | null;
  failed: number | null;
};

/** Whether baseline.json compares avmshell's counts for the test: not where they follow the date or the machine. */
export const counted = (theirs: Avmshell) => theirs.passed !== null && theirs.failed !== null;

/** Whether swf2es-baseline.json compares swf2es' own counts: not where they were relaxed. */
export const ownCounted = (o: Recorded) => o.passed !== null && o.failed !== null;

/**
 * Whether swf2es ended as avmshell did, nothing of the host's stopping it,
 * and, with `counts`, passed and failed the checks avmshell did.
 */
export const matches = (theirs: Avmshell, o: Recorded, counts = counted(theirs)) =>
  o.error === null &&
  (theirs.exitCode === null || o.exitCode === theirs.exitCode) &&
  (!counts || (o.passed === theirs.passed && o.failed === theirs.failed));
