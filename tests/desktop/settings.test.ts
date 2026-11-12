import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsFile } from "../../apps/desktop/src/main/settings.ts";

test("Stage3D requires an explicit saved boolean opt-in", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    assert.equal(new SettingsFile(directory).settings.stage3D, false);
    for (const value of [undefined, null, "true", 1, false, true]) {
      writeFileSync(join(directory, "settings.json"), JSON.stringify({ stage3D: value }));
      assert.equal(new SettingsFile(directory).settings.stage3D, value === true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Stage3D choices survive other settings updates and reopening the settings file", () => {
  const directory = mkdtempSync(join(tmpdir(), "swf2es-settings-"));
  try {
    const settings = new SettingsFile(directory);
    assert.equal(settings.setStage3D(true), true);
    settings.opened("example.swf");
    assert.equal(new SettingsFile(directory).settings.stage3D, true);
    assert.equal(settings.setStage3D(false), true);
    const saved = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    assert.equal(saved.stage3D, false);
    assert.deepEqual(saved.recent, ["example.swf"]);
    assert.equal(new SettingsFile(directory).settings.stage3D, false);
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
