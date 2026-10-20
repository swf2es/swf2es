// Dirty hidden groups must release old instructions, then draw their current scene on reveal.
import { AlphaFilter, autoDetectRenderer, Container, Graphics, Rectangle } from "pixi.js";

function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

export async function hiddenGroups() {
  const renderer = await autoDetectRenderer({
    preference: "webgl",
    width: 64,
    height: 64,
    resolution: 1,
    antialias: false,
    backgroundAlpha: 0,
  });
  const root = new Container({ isRenderGroup: true });
  const parent = root.addChild(new Container());
  const branch = parent.addChild(new Container({ isRenderGroup: true }));
  const nested = branch.addChild(new Container({ isRenderGroup: true }));
  const shape = nested.addChild(new Graphics().rect(0, 0, 18, 18).fill(0x22aa55));
  const mask = nested.addChild(new Graphics().rect(0, 0, 12, 18).fill(0));
  shape.mask = mask;
  const filter = new AlphaFilter({ alpha: 0.6 });
  nested.filters = [filter];
  const frame = new Rectangle(0, 0, 64, 64);
  const built = new Set<Container>();
  const batches = renderer.renderPipes.batch as unknown as {
    gpuResident: boolean;
    _batchersByInstructionSet: Record<number, unknown>;
  };
  batches.gpuResident = true;
  const system = renderer.renderGroup;
  const allow = (group: typeof branch.renderGroup) =>
    group === branch.renderGroup || group === nested.renderGroup;
  system.canDeferInvisibleGroup = allow;
  system.onBuildInstructions = (group) => built.add(group.root);
  const render = () => {
    built.clear();
    renderer.render(root);
  };
  const extract = (target = root) => renderer.extract.pixels({ target, frame }).pixels;
  const force = (container: Container) => {
    if (container.renderGroup) {
      container.renderGroup.structureDidChange = true;
    }

    for (let i = 0; i < container.children.length; i++) {
      force(container.children[i]);
    }
  };
  let comparisons = 0;
  const compare = (label: string, target = root) => {
    const candidate = extract(target);
    system.canDeferInvisibleGroup = null;
    force(target);
    const reference = extract(target);
    system.canDeferInvisibleGroup = allow;
    check(candidate.length === reference.length, `${label}: dimensions changed`);
    for (let i = 0; i < candidate.length; i++) {
      check(candidate[i] === reference[i], `${label}: byte ${i} differs`);
    }

    comparisons++;
  };
  try {
    render();
    check(built.has(branch) && built.has(nested), "visible groups were not built");
    check(
      batches._batchersByInstructionSet[nested.renderGroup.instructionSet.uid],
      "visible nested group had no batchers",
    );
    parent.visible = false;
    render();
    check(!built.has(branch), "clean hidden group rebuilt");
    check(branch.renderGroup.instructionSet.instructionSize > 0, "clean instructions discarded");

    // Both structural changes and a changed view must catch up, even below a clean intermediate node.
    const old = branch.addChild(new Graphics().rect(20, 0, 8, 8).fill(0xaa2233));
    shape.clear().rect(0, 0, 25, 25).fill(0x2255aa);
    nested.x = 7;
    render();
    check(!built.has(branch) && !built.has(nested), "dirty hidden group was built");
    for (const container of [branch, nested]) {
      const group = container.renderGroup;
      check(group.structureDidChange, "deferred work was forgotten");
      check(group._contextOf === null, "retired build retained its renderer");
      check(group.instructionSet.instructions.length === 0, "old instructions retained");
      check(group.instructionSet.renderables.length === 0, "old renderables retained");
      check(
        !batches._batchersByInstructionSet[group.instructionSet.uid],
        "old GPU batchers retained",
      );
      check(group.childrenRenderablesToUpdate.index === 0, "view updates accumulated");
    }

    check(shape.worldTransform.tx === 7, "hidden transforms stopped updating");
    parent.visible = true;
    render();
    check(built.has(branch) && built.has(nested), "reveal did not rebuild both groups");
    compare("reveal with filter and mask");

    parent.visible = false;
    branch.removeChild(old).destroy();
    shape.clear().rect(0, 0, 25, 25).fill(0xcc8800);
    render();
    // An explicit render root ignores the scene parent's visibility, as a bitmap draw does.
    compare("render hidden child as root", branch);
    check(built.has(branch), "hidden child root was deferred");

    shape.clear().rect(0, 0, 25, 25).fill(0x8800cc);
    render();
    root.addChild(nested);
    render();
    check(built.has(nested), "reparented group did not rebuild");
    compare("reparent out of hidden branch");
    branch.addChild(nested);
    render();

    const restored = new Promise<void>((resolve) =>
      renderer.canvas.addEventListener("webglcontextrestored", () => setTimeout(resolve, 0), {
        once: true,
      }),
    );
    (renderer as unknown as { context: { forceContextLoss(): void } }).context.forceContextLoss();
    await restored;
    render();
    check(!built.has(branch) && !built.has(nested), "context restoration built hidden groups");
    parent.visible = true;
    render();
    check(built.has(branch) && built.has(nested), "context restoration lost deferred work");
    compare("reveal after context loss");

    // Cached groups keep their original update contract, even when the owner opts them in.
    branch.cacheAsTexture(true);
    render();
    parent.visible = false;
    branch.addChild(new Graphics().rect(30, 0, 4, 4).fill(0xffffff));
    branch.updateCacheTexture();
    render();
    check(built.has(branch), "cached group was deferred");
    branch.cacheAsTexture(false);
    branch.enableRenderGroup();
    parent.visible = true;
    render();
    compare("cached group revealed");

    // The opt-in is required: a host's groups can have mask/render-layer dependencies outside them.
    parent.visible = false;
    system.canDeferInvisibleGroup = null;
    branch.addChild(new Graphics().rect(30, 8, 4, 4).fill(0xffffff));
    render();
    check(built.has(branch), "group without permission was deferred");
    system.canDeferInvisibleGroup = allow;

    // Keep the scene alive while Chrome collects the objects removed during hidden churn.
    const refs: WeakRef<Graphics>[] = [];
    for (let i = 0; i < 96; i++) {
      const transient = branch.addChild(new Graphics().rect(i % 32, 30, 2, 2).fill(0xffffff));
      render();
      check(!built.has(branch), "hidden churn rebuilt instructions");
      branch.removeChild(transient);
      transient.destroy();
      refs.push(new WeakRef(transient));
    }

    render();
    const holder = globalThis as unknown as {
      hiddenGroupLifetime: { refs: WeakRef<Graphics>[]; close(): void };
    };
    holder.hiddenGroupLifetime = {
      refs,
      close() {
        root.destroy({ children: true });
        filter.destroy();
        renderer.destroy();
      },
    };
    return { comparisons, retired: refs.length };
  } catch (error) {
    root.destroy({ children: true });
    filter.destroy();
    renderer.destroy();
    throw error;
  }
}
