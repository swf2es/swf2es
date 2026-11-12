// What the element says of an error a SWF's code threw and nothing caught.
// The release player's message is the error's number alone, so the report
// adds what the number stands for and where it was thrown; and a SWF that
// throws the same error every frame is told of once, then at its 10th,
// 100th and so on, rather than filling the console.

/** How many stack lines a report shows: the method that threw and its callers. */
const FRAMES = 4;

export class UncaughtReports {
  /** How often each error was reported, by its text and where it was thrown. */
  private readonly counts = new Map<string, number>();

  /**
   * The line to print for an error whose AS3 text is `text`, e.g.
   * "TypeError: Error #1006": with `detail`, the message in full ("Error
   * #1006: value is not a function."), and `stack`, where it was made, if
   * the runtime has them. Null for a repeat that is not told.
   */
  line(text: string, detail: string | null, stack: string | null): string | null {
    const frames = stack ? stack.split("\n").slice(0, FRAMES) : [];
    const key = `${text}\n${frames[0] ?? ""}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    // The text ends in the number where the message is the release player's: its words follow.
    const number = detail?.match(/^Error #\d+/)?.[0];
    const full =
      detail && number && text.endsWith(number) ? text + detail.slice(number.length) : text;
    if (count === 1) {
      return [`swf2es: ${full}`, ...frames].join("\n");
    }

    return /^10*$/.test(String(count)) ? `swf2es: ${full} (${count} times)` : null;
  }
}
