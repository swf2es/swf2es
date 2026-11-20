import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsFile } from "../../apps/desktop/src/main/settings.ts";

test("Stage3D is on unless the View menu turned it off", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    assert.equal(new SettingsFile(directory).stage3D, true);
    // The opt-in's own key saved its `false` with every other change: it says nothing either way.
    for (const value of [undefined, null, "false", 0, false, true]) {
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ stage3D: value }));
      assert.equal(new SettingsFile(directory).stage3D, true, `stage3D: ${value}`);
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ stage3DChoice: value }));
      assert.equal(new SettingsFile(directory).stage3D, value !== false, `stage3DChoice: ${value}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Stage3D's choice is saved only when made, and survives other settings updates", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ stage3D: false }));
    const settings = new SettingsFile(directory);
    settings.opened("example.swf");
    let saved = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    assert.equal("stage3DChoice" in saved, false);
    assert.equal("stage3D" in saved, false);
    assert.equal(new SettingsFile(directory).stage3D, true);

    assert.equal(settings.setStage3D(false), true);
    settings.opened("other.swf");
    saved = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    assert.equal(saved.stage3DChoice, false);
    assert.deepEqual(saved.recent, ["other.swf", "example.swf"]);
    assert.equal(new SettingsFile(directory).stage3D, false);

    assert.equal(settings.setStage3D(true), true);
    assert.equal(new SettingsFile(directory).stage3D, true);
    assert.equal(
      JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")).stage3DChoice,
      true,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a chosen playerglobal is kept until the app's own is chosen again", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    const library = join(directory, "playerglobal.abc");
    writeFileSync(library, new Uint8Array([16, 0, 46, 0]));
    const settings = new SettingsFile(directory);
    assert.equal(settings.setLibrary("playerglobal", library), true);
    assert.equal(new SettingsFile(directory).libraries().playerglobal, library);

    assert.equal(settings.clearLibrary("playerglobal"), true);
    assert.equal(settings.libraries().playerglobal, null);
    const saved = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    assert.equal("playerglobal" in saved, false);
    assert.equal(new SettingsFile(directory).libraries().playerglobal, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the HTTP cache is on unless the File menu turned it off", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    const settings = new SettingsFile(directory);
    assert.equal(settings.httpCache, true);
    assert.equal(settings.setHttpCache(false), true);
    settings.opened("example.swf");
    assert.equal(new SettingsFile(directory).httpCache, false);
    assert.equal(settings.setHttpCache(true), true);
    assert.equal(new SettingsFile(directory).httpCache, true);
    writeFileSync(join(directory, "settings.json"), JSON.stringify({ httpCache: "no" }));
    assert.equal(new SettingsFile(directory).httpCache, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the theme is the system's unless View › Theme chose another", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    const settings = new SettingsFile(directory);
    assert.equal(settings.theme, "system");
    settings.opened("example.swf");
    assert.equal(
      "theme" in JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")),
      false,
    );

    for (const theme of ["dark", "light", "system"] as const) {
      assert.equal(settings.setTheme(theme), true);
      settings.opened("other.swf");
      assert.equal(new SettingsFile(directory).theme, theme);
      assert.equal(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")).theme, theme);
    }

    for (const value of ["Dark", "black", 1, null, true]) {
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ theme: value }));
      assert.equal(new SettingsFile(directory).theme, "system", `theme: ${value}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
