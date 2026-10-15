// "Report a problem": a link to a new GitHub issue, filled in with what
// helps to reproduce one, the browser, the build, the SWF's header and the
// last errors, and never the SWF itself, nor a local file's name.

const NEW_ISSUE = "https://github.com/swf2es/swf2es/issues/new";
/** GitHub turns away longer URLs; the errors give way first. */
const MAX_URL = 7000;

/** What the page knows of the SWF that played last. */
export interface SwfFacts {
  /** "a local file", "the demo bounce.swf" or the URL it came from. */
  origin: string;
  version: number;
  compression: string;
  avm: "AVM1" | "AVM2";
  bytes: number;
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
}

export interface ReportFacts {
  build: string;
  userAgent: string;
  renderer: string;
  quality: string;
  scale: string;
  swf: SwfFacts | null;
  /** The last errors, oldest first. */
  errors: string[];
}

/** A URL as the report gives it: no query or fragment, which may hold a token, and not too long. */
function shortOrigin(origin: string): string {
  let text = origin;
  try {
    const url = new URL(origin);
    text = `${url.origin}${url.pathname}`;
  } catch {
    // Not a URL: "a local file" or a demo's name.
  }

  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function body(facts: ReportFacts, errors: string[]): string {
  const swf = facts.swf;
  const lines = [
    "### What happened",
    "",
    "<!-- What did you expect, and what did you see instead? -->",
    "",
    "### The SWF",
    "",
  ];
  if (swf) {
    lines.push(
      `- From: ${shortOrigin(swf.origin)}`,
      `- ActionScript: ${swf.avm === "AVM2" ? "3 (AVM2)" : "1 or 2 (AVM1)"}`,
      `- SWF version: ${swf.version}, compression: ${swf.compression}`,
      `- File size: ${swf.bytes} bytes`,
      `- Stage: ${swf.width} x ${swf.height}, ${swf.frameRate} fps, ${swf.frameCount} frames`,
      "",
      "<!-- If you may share it, attach the SWF or link to it: the page never sends it. -->",
    );
  } else {
    lines.push("No SWF played.");
  }

  lines.push(
    "",
    "### Environment",
    "",
    `- swf2es: ${facts.build}`,
    `- Browser: ${facts.userAgent}`,
    `- Renderer: ${facts.renderer}`,
    `- Quality: ${facts.quality}, scale: ${facts.scale}`,
  );
  if (errors.length > 0) {
    // A fence longer than any run of backticks in them, which would end a shorter one.
    const longest = Math.max(
      2,
      ...errors.flatMap((e) => (e.match(/`+/g) ?? []).map((r) => r.length)),
    );
    const fence = "`".repeat(longest + 1);
    lines.push("", "### Last errors", "", fence, ...errors, fence);
  }

  return lines.join("\n");
}

/** The new issue's URL: the errors cut, the oldest first, until it fits. */
export function reportUrl(facts: ReportFacts): string {
  const title = facts.swf
    ? `Site: an ${facts.swf.avm} SWF (version ${facts.swf.version}) `
    : "Site: ";
  let errors = facts.errors.map((e) => (e.length > 500 ? `${e.slice(0, 500)}…` : e));
  for (;;) {
    const url = `${NEW_ISSUE}?${new URLSearchParams({ title, body: body(facts, errors) })}`;
    if (url.length <= MAX_URL || errors.length === 0) {
      return url;
    }

    errors = errors.slice(1);
  }
}
