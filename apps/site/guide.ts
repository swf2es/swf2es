// The site's guide pages, from docs/guide.md as the repository keeps it, so
// that there is one copy: its title and introduction make the guide's first
// page, and each `##` section a page of its own, in order. Links to other
// files of the repository go to them on GitHub, and links to a heading of
// the guide to the page that has it.
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
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

/** A heading's anchor as GitHub and Astro make it, for the headings the guide has. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
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
  const parts: { title: string; lines: string[] }[] = [{ title: "", lines: [] }];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
    }

    const heading = fenced ? null : /^(#{1,2}) (.+)$/.exec(line);
    if (heading?.[1] === "#" && parts.length === 1 && parts[0].title === "") {
      parts[0].title = heading[2].trim();
    } else if (heading?.[1] === "##") {
      parts.push({ title: heading[2].trim(), lines: [] });
    } else {
      parts.at(-1)?.lines.push(line);
    }
  }

  const pages = parts.map(({ title, lines }, order) => ({
    id: order === 0 ? "docs" : `docs/${slug(title)}`,
    title: title || "Guide",
    order,
    body: lines.join("\n").trim(),
  }));
  // Every heading of the guide, by its anchor, and the page it is on.
  const pageOf = new Map<string, string>();
  for (const page of pages) {
    if (page.order > 0) {
      pageOf.set(slug(page.title), page.id);
    }

    for (const [, text] of page.body.matchAll(/^#{3,6} (.+)$/gm)) {
      pageOf.set(slug(text), page.id);
    }
  }

  const dir = dirname(path);
  const link = (target: string, from: GuidePage): string => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      return target;
    }

    const hash = target.indexOf("#");
    const file = hash < 0 ? target : target.slice(0, hash);
    const anchor = hash < 0 ? "" : target.slice(hash + 1);
    if (file === "" || normalize(join(dir, file)) === path) {
      const page = pageOf.get(anchor);
      if (page === undefined) {
        return `#${anchor}`;
      }

      // A section's own heading is its page's title, the page itself.
      const own = page !== "docs" && page === `docs/${anchor}`;
      return page === from.id && !own ? `#${anchor}` : `${base}${page}/${own ? "" : `#${anchor}`}`;
    }

    return `${blob}${normalize(join(dir, file))}${anchor ? `#${anchor}` : ""}`;
  };

  for (const page of pages) {
    page.body = rewriteLinks(page.body, (target) => link(target, page));
  }

  // The first page lists the others, which the guide itself has as its headings.
  pages[0].body += `\n\n${pages
    .slice(1)
    .map((p) => `- [${p.title}](${base}${p.id}/)`)
    .join("\n")}\n`;
  return pages;
}

/** `markdown` with the target of each inline link outside code blocks replaced. */
function rewriteLinks(markdown: string, replace: (target: string) => string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^(```|~~~)/.test(line)) {
        fenced = !fenced;
      }

      if (fenced) {
        return line;
      }

      // Inline code keeps its brackets: only what lies between code spans is a link.
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(/\]\(([^)\s]+)\)/g, (_, t: string) => `](${replace(t)})`),
        )
        .join("");
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
