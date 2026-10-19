import type { PageValue } from "../../packages/web/dist/external.js";
import { externalInterfaceHost, fromXml, invocation } from "../../packages/web/dist/external.js";
import { boot, type Kind } from "./boot.ts";
import { Bridge, channel } from "./bridge.ts";

type Mode = "direct" | "diagnostic-spin" | "reject";
type Outcome = { value?: PageValue; error?: string };

async function runWorkerVm(kind: Kind, mode: Mode) {
  const callbacks = new Map<string, (...args: PageValue[]) => PageValue>();
  const events: string[] = [];
  const reports: string[] = [];
  const host = externalInterfaceHost(
    {
      objectID: "experiment",
      callback(name, call) {
        if (call) {
          callbacks.set(name, call);
        } else {
          callbacks.delete(name);
        }
      },
      alive: () => true,
    },
    (error) => reports.push(String(error)),
  );
  const page = globalThis as unknown as Record<string, unknown>;
  page.probePage = (depth: number, failure: string) => {
    events.push(`page:${depth}`);
    if (failure === `page:${depth}`) {
      throw new Error(`page failure ${depth}`);
    }

    return depth === 0 ? "leaf" : `page(${callbacks.get("nest")?.(depth - 1, failure)})`;
  };
  let worker: Worker | undefined;
  let bridge: Bridge | undefined;
  let player: Awaited<ReturnType<typeof boot>> | undefined;
  let failWorker: (error: Error) => void = () => {};
  let asyncDone: () => void = () => {};
  let invokedDone: (xml: string | null) => void = () => {};
  let closedDone: (value: { error: string; waits: number }) => void = () => {};
  let skipPumps = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (mode === "direct") {
      player = await boot(kind, host, (line) => events.push(line));
    } else {
      const shared = channel();
      worker = new Worker("/experiment/thread.js", { type: "module" });
      const target = worker;
      bridge = new Bridge(
        shared,
        mode,
        () => target.postMessage({ type: "pump" }),
        (method, body) => {
          switch (method) {
            case "callOut":
              return host.callOut(body) ?? "<null/>";
            case "register": {
              const [name, present] = JSON.parse(body) as [string, boolean];
              host.addCallback(
                name,
                present
                  ? (request) => {
                      if (!bridge) {
                        throw new Error("bridge missing");
                      }

                      const { xml } = JSON.parse(bridge.call("invoke", request)) as {
                        xml: string | null;
                      };
                      return xml ?? undefined;
                    }
                  : null,
              );
              return "";
            }
            case "trace":
              events.push(body);
              return "";
            case "nest":
              return Number(body) === 0
                ? "leaf"
                : (bridge?.call("nest", String(Number(body) - 1)) ?? "");
            default:
              throw new Error(`unknown main method: ${method}`);
          }
        },
      );
      await new Promise<void>((resolve, reject) => {
        failWorker = reject;
        timer = setTimeout(() => reject(new Error("worker boot timeout")), 15_000);
        target.onerror = (event) => reject(new Error(event.message));
        target.onmessage = (event) => {
          switch (event.data.type) {
            case "pump":
              if (skipPumps) {
                break;
              }

              try {
                bridge?.pump();
              } catch (error) {
                failWorker(new Error(String(error)));
              }
              break;
            case "ready":
              clearTimeout(timer);
              resolve();
              break;
            case "error":
              failWorker(new Error(event.data.error));
              break;
            case "async-done":
              asyncDone();
              break;
            case "invoked":
              invokedDone(event.data.xml);
              break;
            case "waiting":
              skipPumps = true;
              setTimeout(() => bridge?.close(), 20);
              break;
            case "closed":
              closedDone(event.data);
              break;
          }
        };
        target.postMessage({ type: "init", shared, kind });
      });
    }

    const fromWorker = async (depth: number, failure: string) => {
      const xml = await new Promise<string | null>((resolve, reject) => {
        invokedDone = resolve;
        failWorker = reject;
        timer = setTimeout(() => reject(new Error("worker-originated call timeout")), 2000);
        worker?.postMessage({
          type: "invoke-from-worker",
          request: invocation("outbound", [depth, failure]),
        });
      });
      clearTimeout(timer);
      return xml === null ? undefined : fromXml(xml);
    };
    const outcomes: Outcome[] = [];
    for (let depth = 0; depth <= 6; depth++) {
      const failures = [""];
      for (let level = 0; level <= depth; level++) {
        failures.push(`vm:${level}`, `page:${level}`);
      }

      for (let i = 0; i < failures.length; i++) {
        const names = ["nest", "outbound"];
        for (let n = 0; n < names.length; n++) {
          try {
            outcomes.push({
              value:
                mode === "diagnostic-spin" && names[n] === "outbound"
                  ? await fromWorker(depth, failures[i])
                  : callbacks.get(names[n])?.(depth, failures[i]),
            });
          } catch (error) {
            outcomes.push({ error: String(error) });
          }
        }
      }
    }

    let blocking: object | null = null;
    const transport: string[] = [];
    if (mode === "reject") {
      if ((await fromWorker(0, "")) !== "leaf" || (await fromWorker(1, "")) !== undefined) {
        throw new Error(
          "nonblocking worker calls must preserve simple calls and expose nested failure",
        );
      }
    }
    if (mode === "diagnostic-spin" && bridge && worker) {
      let microtaskRan = false;
      let timerRan = false;
      let rafRan = false;
      queueMicrotask(() => {
        microtaskRan = true;
      });
      const task = setTimeout(() => {
        timerRan = true;
      }, 0);
      const raf = requestAnimationFrame(() => {
        rafRan = true;
      });
      const begun = performance.now();
      bridge.call("stall", "100");
      blocking = { elapsed: performance.now() - begun, microtaskRan, timerRan, rafRan };
      await new Promise((resolve) => setTimeout(resolve, 0));
      clearTimeout(task);
      cancelAnimationFrame(raf);

      let tasks = 0;
      const interval = setInterval(() => {
        tasks++;
      }, 0);
      try {
        await new Promise<void>((resolve, reject) => {
          asyncDone = resolve;
          failWorker = reject;
          timer = setTimeout(() => reject(new Error("async worker timeout")), 2000);
          worker?.postMessage({ type: "async-stall" });
        });
      } finally {
        clearInterval(interval);
        clearTimeout(timer);
      }
      blocking = { ...blocking, asyncTasks: tasks };

      // A transport error must release the slot so the next call still works.
      try {
        bridge.call("failure", "");
        throw new Error("expected a worker transport error");
      } catch (error) {
        if (!String(error).includes("worker transport failure")) {
          throw error;
        }
      }
      if (bridge.call("stall", "0") !== "done") {
        throw new Error("transport did not recover after error");
      }

      const rejects = (call: () => unknown, message: string) => {
        try {
          call();
        } catch (error) {
          if (!String(error).includes(message)) {
            throw error;
          }

          transport.push(message);
          return;
        }

        throw new Error(`expected rejection: ${message}`);
      };
      rejects(() => bridge?.call("echo", "x".repeat(32 * 1024)), "payload exceeds");
      rejects(() => bridge?.call("oversize", ""), "response exceeds");
      rejects(() => bridge?.call("nest", "64"), "nesting exceeds");
      if (bridge.call("echo", "after errors") !== "after errors") {
        throw new Error("transport did not recover after bounded failures");
      }

      const orphan = new Bridge(
        channel(),
        "diagnostic-spin",
        () => {},
        () => "",
        20,
      );
      rejects(() => orphan.call("unanswered", ""), "timeout; endpoint closed");
      rejects(() => orphan.call("late", ""), "bridge closed");

      // Withhold this request, then close from main while the worker is asleep.
      skipPumps = true;
      const closed = await new Promise<{ error: string; waits: number }>((resolve, reject) => {
        closedDone = resolve;
        failWorker = reject;
        timer = setTimeout(() => reject(new Error("worker close timeout")), 2000);
        worker?.postMessage({ type: "wait-for-close" });
      });
      clearTimeout(timer);
      if (!closed.error.includes("bridge closed") || closed.waits === 0) {
        throw new Error(`worker did not leave its wait: ${JSON.stringify(closed)}`);
      }
      transport.push("worker wait cancelled");
    }

    return {
      kind,
      mode,
      outcomes,
      events,
      reports,
      blocking,
      transport,
      calls: bridge?.calls ?? 0,
      spins: bridge?.spins ?? 0,
    };
  } finally {
    clearTimeout(timer);
    bridge?.close();
    worker?.terminate();
    player?.destroy();
    delete page.probePage;
  }
}

Object.assign(globalThis, { runWorkerVm });
