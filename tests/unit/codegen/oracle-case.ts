/** A hand-built ABC, with the error avmplus reports for it; see oracle/cases.ts. */
export interface Case {
  name: string;
  abc: Uint8Array;
  /** The error swf2es reports, or undefined if it accepts the ABC. */
  error?: number;
  /**
   * What avmshell reports instead, where the oracle knowingly differs (null:
   * no error); the reason is in a comment on the case.
   */
  avmshell?: number | null;
}
