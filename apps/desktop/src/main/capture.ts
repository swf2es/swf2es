// Consent is scoped to the movie and page lifetime, never the shared app origin.
import { dialog, ipcMain, type Session, systemPreferences } from "electron";
import type { CaptureKind, CapturePermission } from "../shared/api.js";
import { buildMenu } from "./menu.ts";
import { current } from "./open.ts";
import { APP_ORIGIN } from "./protocol.ts";
import { pageGone, setCaptureLabel, trusted, window } from "./state.ts";

let epoch = 0;
const decisions = new Map<CaptureKind, CapturePermission>();
const asking = new Map<CaptureKind, Promise<CapturePermission>>();
const live = new Set<string>();
let lifetime = new AbortController();
const stopTimers = new Map<number, ReturnType<typeof setTimeout>>();
const probes = new Map<number, { id: number; answered: boolean }>();
let nextProbe = 0;
/** Counts the window's committed documents, so that a probe never outlives the one it asked. */
let documents = 0;

const kindOf = (value: unknown): value is CaptureKind =>
  value === "camera" || value === "microphone";
export const capturing = (): boolean => live.size > 0;
const activeEpoch = (value: number) => [...live].some((id) => id.startsWith(`${value}:`));

function indicator(): void {
  const camera = [...live].some((id) => id.includes(":camera:"));
  const microphone = [...live].some((id) => id.includes(":microphone:"));
  let label = "";
  if (camera && microphone) {
    label = "Camera + microphone";
  } else if (camera) {
    label = "Camera";
  } else if (microphone) {
    label = "Microphone";
  }

  setCaptureLabel(label);
  buildMenu();
}

function stopped(requested: number): void {
  probes.delete(requested);
  const timer = stopTimers.get(requested);
  if (timer) {
    clearTimeout(timer);
    stopTimers.delete(requested);
  }

  for (const id of live) {
    if (id.startsWith(`${requested}:`)) {
      live.delete(id);
    }
  }

  indicator();
}

function pageAvailable(): boolean {
  return (
    !!window &&
    !pageGone &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    !window.webContents.isCrashed()
  );
}

function watchStop(requested: number): void {
  const probe = { id: ++nextProbe, answered: false };
  const document = documents;
  probes.set(requested, probe);
  if (pageAvailable()) {
    window?.webContents.send("capture:probe", requested, probe.id);
  }

  stopTimers.set(
    requested,
    setTimeout(() => {
      stopTimers.delete(requested);
      if (!activeEpoch(requested)) {
        probes.delete(requested);
        return;
      }

      // The page that held these tracks is gone with its document; the one shown now never had them.
      if (document !== documents) {
        stopped(requested);
        return;
      }

      if (probe.answered) {
        // getUserMedia cannot be cancelled. A responsive page stops a late stream on arrival.
        watchStop(requested);
      } else if (pageAvailable()) {
        window?.webContents.forcefullyCrashRenderer();
      }
    }, 2000),
  );
}

function stopEpoch(requested: number): void {
  if (pageAvailable()) {
    window?.webContents.send("capture:stop", requested);
  }
  if (activeEpoch(requested) && !stopTimers.has(requested)) {
    // This survives replacement and keeps checking if a previously responsive page freezes.
    watchStop(requested);
  }
}

/** A committed document replaced the page, and its tracks went with the old one. */
export function documentReplaced(): void {
  documents++;
  releaseRetiredCapture();
}

/** A completed document navigation confirms that the old page and its tracks are gone. */
export function releaseRetiredCapture(): void {
  for (const id of [...live]) {
    const owner = Number(id.slice(0, id.indexOf(":")));
    if (owner !== epoch) {
      stopped(owner);
    }
  }
}

/** Replacement waits for acknowledgement; a terminated page already has no tracks. */
export function resetCapture(pageEnded = false): void {
  lifetime.abort();
  lifetime = new AbortController();
  if (pageEnded) {
    for (const timer of stopTimers.values()) {
      clearTimeout(timer);
    }
    stopTimers.clear();
    probes.clear();
    live.clear();
  } else {
    stopEpoch(epoch);
  }
  epoch++;
  decisions.clear();
  asking.clear();
  indicator();
}

export function stopCapture(): void {
  lifetime.abort();
  decisions.set("camera", "denied");
  decisions.set("microphone", "denied");
  asking.clear();
  stopEpoch(epoch);
}

function dialogText(value: string, limit: number): string {
  const text = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  // Whole code points: a cut pair would leave a lone surrogate in the dialog.
  return [...text].slice(0, limit).join("");
}

async function permission(kind: CaptureKind, requested: number): Promise<CapturePermission> {
  const playing = current;
  const owner = window;
  if (!playing || !owner || requested !== epoch) {
    return "denied";
  }

  const known = decisions.get(kind);
  if (known) {
    return known;
  }

  const existing = asking.get(kind);
  if (existing) {
    return existing;
  }

  const signal = lifetime.signal;
  const answer = (async (): Promise<CapturePermission> => {
    try {
      const origin = /^https?:/.test(playing.path) ? new URL(playing.path).origin : playing.path;
      const result = await dialog.showMessageBox(owner, {
        type: "question",
        message: `${dialogText(playing.movie.name, 160)} asks to use your ${kind}.`,
        detail: `Source: ${dialogText(origin, 1024)}\nAllow access for this movie until it closes or reloads.`,
        buttons: ["Allow", "Deny"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        signal,
      });
      if (signal.aborted || current !== playing || requested !== epoch || result.response !== 0) {
        return "denied";
      }
      if (process.platform === "darwin" && !(await systemPreferences.askForMediaAccess(kind))) {
        return "denied";
      }
      return signal.aborted || current !== playing || requested !== epoch ? "denied" : "granted";
    } catch {
      return "denied";
    }
  })();
  asking.set(kind, answer);
  const result = await answer;
  if (requested === epoch && !signal.aborted) {
    decisions.set(kind, result);
    asking.delete(kind);
  }
  return result;
}

export function capturePermissions(session: Session): void {
  const allowed = (type: string) =>
    decisions.get(type === "video" ? "camera" : "microphone") === "granted";
  session.setPermissionRequestHandler((contents, permission, answer, details) => {
    if (contents !== window?.webContents || contents.isCrashed()) {
      answer(false);
      return;
    }
    if (permission === "fullscreen") {
      answer(true);
      return;
    }
    // A renderer host must first obtain the movie-specific consent through capture:request.
    const types = "mediaTypes" in details ? details.mediaTypes : undefined;
    answer(
      permission === "media" &&
        details.isMainFrame &&
        details.requestingUrl.startsWith(`${APP_ORIGIN}/`) &&
        !!current &&
        !!types?.length &&
        types.every((type) => (type === "audio" || type === "video") && allowed(type)),
    );
  });
  session.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (contents !== window?.webContents || contents?.isCrashed()) {
      return false;
    }
    if (permission === "fullscreen") {
      return true;
    }
    return (
      permission === "media" &&
      details.isMainFrame &&
      !!details.requestingUrl?.startsWith(`${APP_ORIGIN}/`) &&
      !!current &&
      (details.mediaType === "video" || details.mediaType === "audio") &&
      allowed(details.mediaType)
    );
  });
  ipcMain.on("capture:responsive", (event, requested: number, id: number) => {
    const probe = probes.get(requested);
    if (trusted(event) && probe?.id === id) {
      probe.answered = true;
    }
  });
  ipcMain.on("capture:stopped", (event, requested: number) => {
    if (trusted(event) && Number.isSafeInteger(requested) && requested <= epoch) {
      stopped(requested);
    }
  });
  ipcMain.on("capture:epoch", (event) => {
    event.returnValue = trusted(event) ? epoch : -1;
  });
  ipcMain.on("capture:status", (event, requested: number, kind: unknown) => {
    event.returnValue =
      trusted(event) && requested === epoch && kindOf(kind)
        ? (decisions.get(kind) ?? "unknown")
        : "denied";
  });
  ipcMain.handle("capture:request", (event, requested: number, kind: unknown) =>
    trusted(event) && kindOf(kind) ? permission(kind, requested) : "denied",
  );
  ipcMain.on(
    "capture:live",
    (event, requested: number, kind: unknown, id: unknown, active: unknown) => {
      if (
        !trusted(event) ||
        !Number.isSafeInteger(requested) ||
        requested > epoch ||
        !kindOf(kind) ||
        typeof id !== "number" ||
        !Number.isSafeInteger(id)
      ) {
        return;
      }
      const key = `${requested}:${kind}:${id}`;
      if (active === true) {
        if (requested === epoch && decisions.get(kind) === "granted") {
          live.add(key);
        }
      } else if (active === false) {
        live.delete(key);
      }
      indicator();
    },
  );
}
