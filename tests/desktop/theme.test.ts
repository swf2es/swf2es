// The desktop app's theme (apps/desktop/src/main/theme.ts): --theme read from the command line,
// what stderr says of it, and View › Theme's radio items.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  themeArgument,
  themeMenu,
  themeNotice,
  windowBackground,
} from "../../apps/desktop/src/main/theme.ts";

test("--theme reads system, light and dark, the last winning", () => {
  assert.deepEqual(themeArgument(["file.swf"]), { theme: null });
  assert.deepEqual(themeArgument(["--theme=dark", "file.swf"]), { theme: "dark" });
  assert.deepEqual(themeArgument(["--THEME=Light"]), { theme: "light" });
  assert.deepEqual(themeArgument(["--theme=dark", "--theme=system"]), { theme: "system" });
  assert.deepEqual(themeArgument(["--theme-x=dark", "--themes=dark"]), { theme: null });
});

test("--theme refuses what does not read", () => {
  for (const arg of ["--theme", "--theme=", "--theme=black", "--theme=auto"]) {
    assert.ok("error" in themeArgument([arg]), arg);
  }
});

test("stderr says --theme holds for the run and the settings keep their own", () => {
  assert.equal(
    themeNotice("dark", "system"),
    "swf2es: --theme: dark theme for this run; the saved theme (the system's) is kept for the next run",
  );
  assert.match(
    themeNotice("system", "light"),
    /the system's theme for this run.*saved theme \(light\)/,
  );
});

test("View › Theme offers System, Light and Dark as radio items, the current one checked", () => {
  const chosen: string[] = [];
  const menu = themeMenu("light", (theme) => chosen.push(theme));
  assert.equal(menu.label, "&Theme");
  const items = menu.submenu as {
    id: string;
    label: string;
    type: string;
    checked: boolean;
    click: () => void;
  }[];
  assert.deepEqual(
    items.map(({ id, label, type, checked }) => [id, label, type, checked]),
    [
      ["theme-system", "&System", "radio", false],
      ["theme-light", "&Light", "radio", true],
      ["theme-dark", "&Dark", "radio", false],
    ],
  );

  for (const item of items) {
    item.click();
  }

  assert.deepEqual(chosen, ["system", "light", "dark"]);
});

test("a window shows the scheme's Canvas colour before its page draws", () => {
  assert.equal(windowBackground(false), "#ffffff");
  assert.equal(windowBackground(true), "#121212");
});
