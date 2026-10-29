import assert from "node:assert/strict";
import { test } from "node:test";
import { guidePages } from "../../../apps/site/guide.ts";

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
