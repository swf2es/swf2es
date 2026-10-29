// The site's guide pages, from docs/guide.md as the repository keeps it, so
// that there is one copy: its title and introduction make the guide's first
// page, and each `##` section a page of its own, in order. Links to other
// files of the repository go to them on GitHub, and links to a heading of
// the guide to the page that has it.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path/posix";
import type { Loader } from "astro/loaders";

/** The guide, by its path in the repository. */
export const GUIDE = "docs/guide.md";

export interface GuidePage {
  /** Its path under the site, "docs" for the first page, "docs/<slug>" for a section's. */
  id: string;
  title: string;
  /** Its place in the guide, 0 for the first page. */
  order: number;
  body: string;
}

/** A heading's anchor as GitHub and Astro make it, before a repeated one is numbered. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Anchors for the headings of one document, a repeated one numbered as GitHub does: x, x-1, x-2. */
function slugger(): (heading: string) => string {
  const occurrences = new Map<string, number>();
  return (heading) => {
    const plain = slug(heading);
    let anchor = plain;
    while (occurrences.has(anchor)) {
      const n = (occurrences.get(plain) ?? 0) + 1;
      occurrences.set(plain, n);
      anchor = `${plain}-${n}`;
    }

    occurrences.set(anchor, 0);
    return anchor;
  };
}

/**
 * Whether each of `lines` is in a fenced code block, its fences included: a
 * fence of three or more backticks or tildes, indented up to three spaces,
 * closes only on a fence of the same character at least as long.
 */
export function fenced(lines: string[]): boolean[] {
  let open: { char: string; length: number } | null = null;
  return lines.map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      // A backtick fence's info string has no backtick.
      if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
        open = { char: fence[1][0], length: fence[1].length };
        return true;
      }

      return false;
    }

    const closes =
      fence !== null &&
      fence[1][0] === open.char &&
      fence[1].length >= open.length &&
      fence[2].trim() === "";
    if (closes) {
      open = null;
    }

    return true;
  });
}

/** An ATX heading's level and text. */
function heading(line: string): [number, string] | null {
  const match = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
  return match ? [match[1].length, match[2]] : null;
}

/**
 * The pages of `markdown`, the guide at `path` in the repository, its links
 * made to work under `base` (the site's base path) with `blob`, the prefix of
 * a file's URL on GitHub.
 */
export function guidePages(
  markdown: string,
  path: string,
  base: string,
  blob: string,
): GuidePage[] {
  const lines = markdown.split("\n");
  const code = fenced(lines);
  const anchorOf = slugger();
  const parts: { title: string; anchor: string; lines: string[] }[] = [
    { title: "", anchor: "", lines: [] },
  ];
  // Each heading, by its anchor on GitHub: the part it is in, and its anchor on that page,
  // where Astro numbers repeated headings afresh. A section's heading is its page's title.
  const targets = new Map<string, { part: number; anchor: string }>();
  let pageAnchor = slugger();
  for (const [i, line] of lines.entries()) {
    const found = code[i] ? null : heading(line);
    if (found === null) {
      parts[parts.length - 1].lines.push(line);
      continue;
    }

    const [level, text] = found;
    const anchor = anchorOf(text);
    if (level === 1 && parts.length === 1 && parts[0].title === "") {
      parts[0].title = text;
    } else if (level === 2) {
      parts.push({ title: text, anchor, lines: [] });
      pageAnchor = slugger();
    } else {
      parts[parts.length - 1].lines.push(line);
    }

    targets.set(anchor, { part: parts.length - 1, anchor: level <= 2 ? "" : pageAnchor(text) });
  }

  // GitHub's anchors are unique in the guide, so a section's makes its page's path.
  const pages = parts.map(({ title, anchor, lines }, order) => ({
    id: order === 0 ? "docs" : `docs/${anchor}`,
    title: title || "Guide",
    order,
    body: lines.join("\n").trim(),
  }));
  const dir = dirname(path);
  const link = (target: string, from: number): string => {
    // A scheme (https:, mailto:) or another host (//host/x) is somewhere else.
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
      return target;
    }

    const hash = target.indexOf("#");
    const file = hash < 0 ? target : target.slice(0, hash);
    const anchor = hash < 0 ? "" : target.slice(hash + 1);
    // GitHub takes a path from the root as one from the repository's root.
    const repository = file.startsWith("/") ? normalize(file.slice(1)) : normalize(join(dir, file));
    if (file !== "" && repository !== path) {
      return `${blob}${repository}${hash < 0 ? "" : `#${anchor}`}`;
    }

    const to = targets.get(anchor);
    if (to === undefined) {
      return `#${anchor}`;
    }

    if (to.part === from && to.anchor !== "") {
      return `#${to.anchor}`;
    }

    return `${base}${pages[to.part].id}/${to.anchor ? `#${to.anchor}` : ""}`;
  };

  for (const page of pages) {
    page.body = rewriteLinks(page.body, (target) => link(target, page.order));
  }

  // The first page lists the others, which the guide itself has as its headings.
  const list = pages.slice(1).map((p) => `- [${p.title}](${base}${p.id}/)`);
  pages[0].body += `\n\n${list.join("\n")}\n`;

  return pages;
}

/** `line` cut into the text between code spans (even indices) and the code spans (odd). */
function codeSpans(line: string): string[] {
  const parts: string[] = [];
  const runs = [...line.matchAll(/`+/g)];
  let text = 0;
  for (let i = 0; i < runs.length; i++) {
    // A span closes on the next run of as many backticks, no more and no fewer.
    const open = runs[i];
    const close = runs.findIndex((run, j) => j > i && run[0].length === open[0].length);
    if (close < 0) {
      continue;
    }

    const end = (runs[close].index ?? 0) + runs[close][0].length;
    parts.push(line.slice(text, open.index), line.slice(open.index, end));
    text = end;
    i = close;
  }

  parts.push(line.slice(text));

  return parts;
}

/** A link's destination, bare or in <>, and its title, if it has one. */
const DESTINATION = String.raw`(<[^<>\n]*>|[^\s()<>]+)(\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?`;
const INLINE = new RegExp(String.raw`\]\(\s*${DESTINATION}\s*\)`, "g");
const DEFINITION = new RegExp(String.raw`^( {0,3}\[[^\]]+\]:[ \t]*)${DESTINATION}(.*)$`);

/**
 * `markdown` with the destination of each link outside code replaced, inline
 * ([x](to "title"), [x](<to>)) and by reference definition ([x]: to).
 */
export function rewriteLinks(markdown: string, replace: (target: string) => string): string {
  const lines = markdown.split("\n");
  const code = fenced(lines);
  const destination = (to: string) =>
    to.startsWith("<") ? `<${replace(to.slice(1, -1))}>` : replace(to);

  return lines
    .map((line, i) => {
      if (code[i]) {
        return line;
      }

      const definition = DEFINITION.exec(line);
      if (definition) {
        const [, label, to, title = "", rest] = definition;
        return `${label}${destination(to)}${title}${rest}`;
      }

      const parts = codeSpans(line);
      for (let j = 0; j < parts.length; j += 2) {
        parts[j] = parts[j].replace(
          INLINE,
          (_, to: string, title = "") => `](${destination(to)}${title})`,
        );
      }

      return parts.join("");
    })
    .join("\n");
}

/** The guide's pages, read from the repository at `root`. */
export function readGuide(root: string, base: string, blob: string): GuidePage[] {
  return guidePages(readFileSync(join(root, GUIDE), "utf8"), GUIDE, base, blob);
}

/**
 * A content loader of the guide's pages, for Starlight's docs collection.
 * The sidebar lists them by their ids (astro.config.ts): they have no file
 * under the collection's directory for Starlight to list them by.
 */
export function guideLoader(options: { root: string; blob: string }): Loader {
  return {
    name: "swf2es-guide",
    async load({ store, parseData, renderMarkdown, generateDigest, config, watcher }) {
      const file = join(options.root, GUIDE);
      const base = config.base.endsWith("/") ? config.base : `${config.base}/`;
      const sync = async () => {
        store.clear();
        for (const page of readGuide(options.root, base, options.blob)) {
          const data = await parseData({ id: page.id, data: { title: page.title } });
          store.set({
            id: page.id,
            data,
            body: page.body,
            digest: generateDigest(page.body),
            rendered: await renderMarkdown(page.body),
          });
        }
      };

      watcher?.add(file);
      watcher?.on("change", (changed) => {
        if (changed === file) {
          void sync();
        }
      });

      await sync();
    },
  };
}
