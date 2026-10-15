// The demo site's page: one <swf2es-player> and what a person trying a SWF
// wants around it. A SWF comes from a file read in the browser, never
// uploaded, from a URL fetched here (where its server allows another
// origin to), from ?swf=, or from the demos the build made. Its traces and
// errors reach the page's console, which the panel shows.
import { isAs3, readSwf, readSwfHeader } from "@swf2es/format";
import { configure, type Swf2esPlayerElement } from "@swf2es/web";
import { reportUrl, type SwfFacts } from "./report.js";
import { Stats } from "./stats.js";

interface DemoEntry {
  file: string;
  title: string;
  description: string;
  source: string;
  bytes: number;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const player = byId<Swf2esPlayerElement>("player");
const stage = byId<HTMLElement>("stage");
const empty = byId<HTMLElement>("empty");
const status = byId<HTMLElement>("status");
const fileInput = byId<HTMLInputElement>("file");
const urlForm = byId<HTMLFormElement>("url-form");
const urlInput = byId<HTMLInputElement>("url");
const demoList = byId<HTMLElement>("demos");
const quality = byId<HTMLSelectElement>("quality");
const scale = byId<HTMLSelectElement>("scale");
const reload = byId<HTMLButtonElement>("reload");
const close = byId<HTMLButtonElement>("close");
const fullscreen = byId<HTMLButtonElement>("fullscreen");
const facts = byId<HTMLElement>("facts");
const log = byId<HTMLElement>("log");
const clearLog = byId<HTMLButtonElement>("clear-log");
const copyLog = byId<HTMLButtonElement>("copy-log");
const report = byId<HTMLAnchorElement>("report");
const build = document.documentElement.dataset.build ?? "unknown";

configure({
  libraries: { builtin: new URL("libraries/builtin.abc", document.baseURI).href },
  cache: true,
});

// --- The console panel --------------------------------------------------

type Kind = "trace" | "warn" | "error" | "info";
const MAX_LINES = 2000;
let pending: [Kind, string][] = [];
let flushing = false;
const errors: string[] = [];

/** A line for the panel, drawn with the others of its animation frame: a SWF may trace thousands a second. */
function write(kind: Kind, text: string): void {
  pending.push([kind, text]);
  if (kind === "error") {
    errors.push(text);
    if (errors.length > 20) {
      errors.shift();
    }
  }

  if (!flushing) {
    flushing = true;
    requestAnimationFrame(flush);
  }
}

function flush(): void {
  flushing = false;
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
  const lines = pending.slice(-MAX_LINES);
  pending = [];
  const fragment = document.createDocumentFragment();
  for (const [kind, text] of lines) {
    const line = document.createElement("div");
    line.className = kind;
    line.textContent = text;
    fragment.append(line);
  }

  log.append(fragment);
  while (log.childElementCount > MAX_LINES) {
    log.firstElementChild?.remove();
  }

  if (atEnd) {
    log.scrollTop = log.scrollHeight;
  }
}

const text = (args: unknown[]) =>
  args.map((a) => (a instanceof Error ? (a.stack ?? String(a)) : String(a))).join(" ");

// trace() reaches the console's log, uncaught errors its error: the element's defaults.
for (const [method, kind] of [
  ["log", "trace"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
] as const) {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(...args);
    write(kind, text(args));
  };
}

window.addEventListener("error", (e) => write("error", text([e.error ?? e.message])));
window.addEventListener("unhandledrejection", (e) => write("error", text([e.reason])));

clearLog.addEventListener("click", () => {
  log.replaceChildren();
  errors.length = 0;
});

copyLog.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(log.innerText);
    showStatus("Console copied.");
  } catch {
    showStatus("The browser did not let the page copy.");
  }
});

// --- Loading ------------------------------------------------------------

/** What plays, to play again or report on. */
let current: { bytes: Uint8Array; name: string; facts: SwfFacts; base: string | null } | null =
  null;
const stats = new Stats(byId("fps"), byId("frame-time"), byId("heap"));

function showStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

function describe(bytes: Uint8Array, origin: string): SwfFacts {
  const header = readSwfHeader(bytes);
  const swf = readSwf(bytes);
  return {
    origin,
    version: header.version,
    compression: header.compression,
    avm: isAs3(swf) ? "AVM2" : "AVM1",
    bytes: bytes.length,
    width: Math.round((swf.frameSize.xMax - swf.frameSize.xMin) / 20),
    height: Math.round((swf.frameSize.yMax - swf.frameSize.yMin) / 20),
    frameRate: Math.round(swf.frameRate * 100) / 100,
    frameCount: swf.frameCount,
  };
}

function showFacts(name: string, f: SwfFacts): void {
  const rows: [string, string][] = [
    ["File", name],
    ["ActionScript", f.avm === "AVM2" ? "3 (AVM2)" : "1/2 (AVM1)"],
    ["SWF version", String(f.version)],
    [
      "Size",
      `${(f.bytes / 1024).toFixed(1)} KB${f.compression === "none" ? "" : `, ${f.compression}`}`,
    ],
    ["Stage", `${f.width} × ${f.height}`],
    ["Frames", `${f.frameCount} at ${f.frameRate} fps`],
  ];
  facts.replaceChildren(
    ...rows.flatMap(([term, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

/** Play `bytes`, read from `name`; `base` is the URL it came from, which its own loads resolve against. */
async function play(bytes: Uint8Array, name: string, origin: string, base: string | null) {
  let f: SwfFacts;
  try {
    f = describe(bytes, origin);
  } catch (error) {
    showStatus(`${name} is not a SWF: ${error instanceof Error ? error.message : error}`, true);
    return;
  }

  current = { bytes, name, facts: f, base };
  showFacts(name, f);
  stage.style.setProperty("--w", String(f.width || 550));
  stage.style.setProperty("--h", String(f.height || 400));
  empty.hidden = true;
  player.hidden = false;
  if (base) {
    player.setAttribute("base", base);
  } else {
    player.removeAttribute("base");
  }

  write("info", `Loading ${name} (${f.avm}, SWF ${f.version})`);
  showStatus(`Loading ${name}…`);
  try {
    await player.load(bytes);
    stats.watch(player.player, f.frameRate);
    showStatus(`Playing ${name}.`);
    player.focus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The errors go into the report, which never names a local file.
    write("error", `${base === null ? "The SWF" : name} did not play: ${message}`);
    showStatus(`${name} did not play: ${message}`, true);
  }

  reload.disabled = false;
  close.disabled = false;
}

async function playFile(file: File): Promise<void> {
  history.replaceState(null, "", location.pathname);
  urlInput.value = "";
  // Read here, in the browser: the file goes nowhere else.
  await play(new Uint8Array(await file.arrayBuffer()), file.name, "a local file", null);
}

async function playUrl(url: string, origin?: string): Promise<void> {
  let absolute: URL;
  try {
    absolute = new URL(url, document.baseURI);
  } catch {
    showStatus(`Not a URL: ${url}`, true);
    return;
  }

  // Only what fetch can take from a server: a data: URL in a shared link
  // would play its bytes and name, and the others fail as if refused.
  if (absolute.protocol !== "https:" && absolute.protocol !== "http:") {
    showStatus(`Only http: and https: URLs load, not ${absolute.protocol}`, true);
    return;
  }

  const last = absolute.pathname.split("/").pop() || absolute.host;
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // A malformed escape: the name as it is written.
  }

  showStatus(`Fetching ${absolute.href}…`);
  let bytes: Uint8Array;
  let finalUrl = absolute.href;
  try {
    const response = await fetch(absolute.href);
    if (!response.ok) {
      showStatus(`${absolute.href}: the server answered ${response.status}.`, true);
      return;
    }

    bytes = new Uint8Array(await response.arrayBuffer());
    finalUrl = response.url || finalUrl;
  } catch {
    const crossOrigin = absolute.origin !== location.origin;
    const why = crossOrigin
      ? "Its server may not allow other sites to load it (CORS), or it may be unreachable."
      : "It may be unreachable.";
    write("error", `Could not fetch ${absolute.href}. ${why}`);
    showStatus(`Could not fetch ${absolute.href}. ${why}`, true);
    return;
  }

  await play(bytes, name, origin ?? absolute.href, finalUrl);
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) {
    void playFile(file);
  }

  fileInput.value = "";
});

urlForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (url) {
    history.replaceState(null, "", `?swf=${encodeURIComponent(url)}`);
    void playUrl(url);
  }
});

// Anywhere on the page takes a dropped file.
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    dragDepth++;
    document.body.classList.add("dragging");
  }
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    document.body.classList.remove("dragging");
  }
});
document.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("drop", (e) => {
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const file = e.dataTransfer?.files[0];
  if (file) {
    e.preventDefault();
    void playFile(file);
  }
});

// --- Controls -----------------------------------------------------------

quality.addEventListener("change", () => player.setAttribute("quality", quality.value));
scale.addEventListener("change", () => player.setAttribute("scale", scale.value));

reload.addEventListener("click", () => {
  if (current) {
    void play(current.bytes, current.name, current.facts.origin, current.base);
  }
});

close.addEventListener("click", () => {
  player.destroy();
  stats.watch(null, 0);
  player.hidden = true;
  empty.hidden = false;
  reload.disabled = true;
  close.disabled = true;
  showStatus("Closed.");
});

fullscreen.addEventListener("click", () => {
  void stage
    .requestFullscreen?.()
    // The button had the focus: keys go to the SWF again, as they did before.
    .then(() => !player.hidden && player.focus())
    .catch(() => showStatus("Full screen was refused.", true));
});

/** What WebGL the player's canvas draws with, for the report. */
function renderer(): string {
  const canvas = player.shadowRoot?.querySelector("canvas");
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  if (!gl) {
    return "unknown";
  }

  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return `${gl instanceof WebGL2RenderingContext ? "WebGL 2" : "WebGL 1"}, ${name}`;
}

/** The link is made as it is followed, with what is known then. */
function updateReport(): void {
  report.href = reportUrl({
    build,
    userAgent: navigator.userAgent,
    renderer: current ? renderer() : "none yet",
    quality: quality.value,
    scale: scale.value,
    swf: current?.facts ?? null,
    errors: [...errors],
  });
}

for (const event of ["pointerdown", "focus", "click"]) {
  report.addEventListener(event, updateReport);
}

// --- Demos and ?swf= ----------------------------------------------------

async function listDemos(): Promise<void> {
  try {
    const demos = (await (await fetch("demos/demos.json")).json()) as DemoEntry[];
    for (const demo of demos) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = demo.title;
      button.addEventListener("click", () => {
        history.replaceState(null, "", `?swf=${encodeURIComponent(`demos/${demo.file}`)}`);
        urlInput.value = "";
        void playUrl(`demos/${demo.file}`, `the demo ${demo.file}`);
      });
      const about = document.createElement("span");
      about.textContent = ` ${demo.description} `;
      const source = document.createElement("a");
      source.href = demo.source;
      source.textContent = "Source";
      item.append(button, about, source);
      demoList.append(item);
    }
  } catch {
    demoList.textContent = "The demos did not load.";
  }
}

void listDemos();
const asked = new URLSearchParams(location.search).get("swf");
if (asked) {
  const demo = /^demos\/[\w-]+\.swf$/.test(asked);
  if (!demo) {
    urlInput.value = asked;
  }

  void playUrl(asked, demo ? `the demo ${asked.slice(6)}` : undefined);
}

updateReport();
