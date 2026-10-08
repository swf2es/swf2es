import assert from "node:assert/strict";
import { test } from "node:test";
import { browserNavigate, type FetchRequest } from "../../../packages/player/dist/hosts.js";

/** A window and document that record what the browser's default would open and submit. */
function stubBrowser(t: { after: (fn: () => void) => void }) {
  const opened: [string, string][] = [];
  const submitted: {
    method: string;
    rel: string;
    action: string;
    target: string;
    fields: [string, string][];
  }[] = [];
  const saved = ["open", "document", "location"].map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });

  interface Form {
    method: string;
    rel: string;
    action: string;
    target: string;
    children: { name: string; value: string }[];
  }
  const body = {
    append(form: Form) {
      submitted.push({
        method: form.method,
        rel: form.rel,
        action: form.action,
        target: form.target,
        fields: form.children.map(({ name, value }) => [name, value]),
      });
    },
  };
  const document = {
    body: body as typeof body | null,
    createElement: () => {
      const children: unknown[] = [];
      return {
        style: {},
        children,
        append: (child: unknown) => children.push(child),
        submit: () => {},
        remove: () => {},
      };
    },
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  define("open", (url: string, target: string) => opened.push([url, target]));
  define("document", document);
  define("location", { href: "https://page.test/player/index.html" });
  return { opened, submitted, document };
}

const request = (url: string, method = "GET", body: string | null = null): FetchRequest => ({
  url,
  method,
  headers: [],
  body: body === null ? null : new TextEncoder().encode(body),
});

test("the browser's default opens only http and https, and never in the page's own frames", (t) => {
  const { opened, submitted } = stubBrowser(t);
  const navigate = browserNavigate();
  assert.ok(navigate);

  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    " \tjavascript:alert(1)",
    "java\tscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "blob:https://page.test/x",
    "file:///etc/passwd",
  ]) {
    navigate(request(url), "_blank");
    navigate(request(url, "POST", "a=1"), "_blank");
  }

  for (const target of ["_self", "_SELF", "_parent", "_top", ""]) {
    navigate(request("https://other.test/"), target);
  }

  navigate(request("https://other.test/form", "POST", "a=1"), "_top");
  assert.deepEqual(opened, []);
  assert.deepEqual(submitted, []);

  navigate(request("https://other.test/a"), null);
  navigate(request("c.html"), "_BLANK");
  assert.deepEqual(opened, [
    ["https://other.test/a", "_blank"],
    ["https://page.test/player/c.html", "_blank"],
  ]);
});

// A name would reach the window or frame of that name, the page's own among them, noopener or not.
test("the browser's default opens a named target as a new window", (t) => {
  const { opened, submitted } = stubBrowser(t);
  const navigate = browserNavigate();
  assert.ok(navigate);

  navigate(request("https://other.test/a"), "main");
  navigate(request("https://other.test/form", "POST", "a=1"), "f");
  assert.deepEqual(opened, [["https://other.test/a", "_blank"]]);
  assert.deepEqual(
    submitted.map(({ action, target }) => [action, target]),
    [["https://other.test/form", "_blank"]],
  );
});

test("the browser's default posts any body as form data, and nothing before the page has a body", (t) => {
  const { submitted, document } = stubBrowser(t);
  const navigate = browserNavigate();
  assert.ok(navigate);

  navigate(request("https://other.test/form", "POST", "a=1&b=x%20y"), "_blank");
  navigate(request("https://other.test/json", "POST", '{"a":1}'), null);
  assert.deepEqual(submitted, [
    {
      method: "POST",
      rel: "noopener",
      action: "https://other.test/form",
      target: "_blank",
      fields: [
        ["a", "1"],
        ["b", "x y"],
      ],
    },
    {
      method: "POST",
      rel: "noopener",
      action: "https://other.test/json",
      target: "_blank",
      fields: [['{"a":1}', ""]],
    },
  ]);

  document.body = null;
  assert.doesNotThrow(() => navigate(request("https://other.test/form", "POST", "a=1"), "_blank"));
  assert.equal(submitted.length, 2);
});
