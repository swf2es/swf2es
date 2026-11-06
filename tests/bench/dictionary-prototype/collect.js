export async function collect() {
  if (typeof global.gc !== "function") {
    throw new Error("Run with --expose-gc");
  }

  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    global.gc();
  }
}
