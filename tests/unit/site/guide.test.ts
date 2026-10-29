import assert from "node:assert/strict";
import { test } from "node:test";
import { fenced, guidePages, rewriteLinks } from "../../../apps/site/guide.ts";

const GUIDE = `# Using it

The [README](../README.md) and [how it works](architecture.md#players).

## First steps

See [the second](#second-steps), [its detail](#a-detail) and [the web](https://example.com/).

\`\`\`js
// [not](a-link.md)
\`\`\`

## Second steps

Back to [the first](#first-steps), \`[code](x.md)\` and [a detail](#a-detail).

### A detail
`;

const pages = guidePages(GUIDE, "docs/guide.md", "/site/", "https://host/blob/abc/");
const page = (id: string) => pages.find((p) => p.id === id)?.body ?? "";
/** `target` as a link of the guide at docs/guide.md makes it. */
const link = (target: string) =>
  /\]\((.*)\)/.exec(
    guidePages(`# G\n\n[x](${target})\n`, "docs/guide.md", "/", "https://host/blob/abc/")[0].body,
  )?.[1];

test("the guide's title and introduction make its first page, each section a page", () => {
  assert.deepEqual(
    pages.map(({ id, title, order }) => [id, title, order]),
    [
      ["docs", "Using it", 0],
      ["docs/first-steps", "First steps", 1],
      ["docs/second-steps", "Second steps", 2],
    ],
  );
  assert.match(page("docs"), /- \[First steps\]\(\/site\/docs\/first-steps\/\)/);
  assert.match(page("docs/second-steps"), /^### A detail$/m);
});

test("the guide's links lead to the repository on GitHub, or to the page with the heading", () => {
  assert.match(page("docs"), /\[README\]\(https:\/\/host\/blob\/abc\/README\.md\)/);
  assert.match(page("docs"), /\(https:\/\/host\/blob\/abc\/docs\/architecture\.md#players\)/);
  const first = page("docs/first-steps");
  assert.match(first, /\[the second\]\(\/site\/docs\/second-steps\/\)/);
  assert.match(first, /\[its detail\]\(\/site\/docs\/second-steps\/#a-detail\)/);
  assert.match(first, /\[the web\]\(https:\/\/example\.com\/\)/);
  assert.match(first, /\/\/ \[not\]\(a-link\.md\)/);
  const second = page("docs/second-steps");
  assert.match(second, /\[the first\]\(\/site\/docs\/first-steps\/\)/);
  assert.match(second, /`\[code\]\(x\.md\)`/);
  assert.match(second, /\[a detail\]\(#a-detail\)/);
});

test("a scheme, another host and a path from the root are each left or taken as GitHub does", () => {
  assert.equal(link("mailto:a@example.com"), "mailto:a@example.com");
  assert.equal(link("https://example.com/x.md"), "https://example.com/x.md");
  assert.equal(link("//example.com/x.md"), "//example.com/x.md");
  assert.equal(link("/as3/README.md"), "https://host/blob/abc/as3/README.md");
  assert.equal(link("/docs/guide.md#g"), "/docs/");
  assert.equal(link("workers.md#sharing"), "https://host/blob/abc/docs/workers.md#sharing");
  assert.equal(link("../apps/x/"), "https://host/blob/abc/apps/x/");
});

test("a link's title, an angle-bracketed target and a reference definition keep their form", () => {
  const replace = (to: string) => `[${to}]`;
  assert.equal(rewriteLinks('[x](a.md "A title")', replace), '[x]([a.md] "A title")');
  assert.equal(rewriteLinks("[x](a.md 'A')", replace), "[x]([a.md] 'A')");
  assert.equal(rewriteLinks("[x](<a b.md>)", replace), "[x](<[a b.md]>)");
  assert.equal(rewriteLinks("![i](i.png (t))", replace), "![i]([i.png] (t))");
  assert.equal(rewriteLinks('[x]: a.md "t"', replace), '[x]: [a.md] "t"');
  assert.equal(rewriteLinks("   [x]: <a b.md>", replace), "   [x]: <[a b.md]>");
  assert.equal(
    rewriteLinks("`` [x](a.md) ` `` [y](b.md)", replace),
    "`` [x](a.md) ` `` [y]([b.md])",
  );
  assert.equal(rewriteLinks("`[x](a.md) [y](b.md)", replace), "`[x]([a.md]) [y]([b.md])");
});

test("a fence closes on its own character, at least as long, indented up to three spaces", () => {
  assert.deepEqual(
    fenced(["a", "  ````md", "```", "~~~", "````", "b", "~~~", "x", "   ~~~~ ", "c"]),
    [false, true, true, true, true, false, true, true, true, false],
  );
  // Four spaces is not a fence; a backtick fence's info string has no backtick.
  assert.deepEqual(fenced(["    ```", "``` a`b", "c"]), [false, false, false]);

  const pages = guidePages("# G\n\n````\n```\n## Not a page\n```\n````\n", "g.md", "/", "");
  assert.equal(pages.length, 1);
  assert.match(pages[0].body, /## Not a page/);
});

test("repeated headings are numbered as GitHub numbers them, and pages keep their own", () => {
  const guide = [
    "# Guide",
    "[one](#example) [two](#example-1) [setup](#setup-1)",
    "## Setup",
    "### Example",
    "## Setup",
    "### Example",
    "### Example",
    "[back](#example-2)",
  ].join("\n");
  const pages = guidePages(guide, "docs/guide.md", "/", "");
  assert.deepEqual(
    pages.map((p) => p.id),
    ["docs", "docs/setup", "docs/setup-1"],
  );
  assert.match(pages[0].body, /\[one\]\(\/docs\/setup\/#example\)/);
  // On its own page, the second section's first Example is its first.
  assert.match(pages[0].body, /\[two\]\(\/docs\/setup-1\/#example\)/);
  assert.match(pages[0].body, /\[setup\]\(\/docs\/setup-1\/\)/);
  assert.match(pages[2].body, /\[back\]\(#example-1\)/);
});
