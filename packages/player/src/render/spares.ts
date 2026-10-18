// Nodes off the display list kept for new objects of their character to
// take (render/view.ts): a timeline that places its children anew on every
// frame then reuses their containers, Graphics and filters.
import type { Container as PixiContainer } from "pixi.js";
import { CHILDREN, CONTENT, Container, type DisplayObject, TRANSFORM } from "../display/display.js";
import { FilterChain } from "./filters.js";
import type { Node } from "./node.js";
import { IDLE_MS, SPARE_NODES_MOST } from "./pools.js";

/** The view's released nodes, by their objects' character. */
export class SpareNodes {
  /**
   * The released nodes, by their objects' character, for a new object of
   * the character to take. A timeline that places its children anew on
   * every frame, as an animated character's often does, made hundreds of
   * nodes a frame, each with its containers, and dropped as many: taken, a
   * node keeps its containers and Graphics, where they are in Pixi's tree
   * when it comes back in its place, and its filters where the new
   * object's are the same. And all of them, oldest first, with the time
   * each was listed: SPARE_NODES_MOST at most, none past IDLE_MS, and none
   * past an unload (`clear`), which would keep its SWF's characters.
   */
  private readonly byCharacter = new Map<object, Set<Node>>();
  private readonly since = new Map<Node, number>();

  constructor(
    /** Whether the view draws once (PixiView's `fresh`), which keeps no spares. */
    private readonly fresh: boolean,
    /** The view's nodes by their objects, and by their containers. */
    private readonly nodes: WeakMap<DisplayObject, Node>,
    private readonly containerNodes: WeakMap<PixiContainer, Node>,
  ) {}

  /**
   * A released node of `o`'s character and class for `o` to take, the one
   * whose container is `hint`, in `o`'s place, where it is one. Its object
   * gets a node of its own if it comes back. The node is synced as one
   * that comes back is, which `o`, new, has redrawn and placed whole;
   * what only its old object's history set (a stale cache, a slice, a
   * colour) is forgotten here.
   */
  take(o: DisplayObject, hint: PixiContainer | null): Node | undefined {
    const character = o.character;
    const listed = character && this.byCharacter.get(character);
    if (!listed) {
      return undefined;
    }

    let node: Node | undefined;
    const placed = hint ? this.containerNodes.get(hint) : undefined;
    if (placed && listed.has(placed) && this.fits(placed, o)) {
      node = placed;
    } else {
      // Oldest first; one no longer fit to take, as one made a mask, is let go of on the way.
      for (const spare of listed) {
        if (this.fits(spare, o)) {
          node = spare;
          break;
        }

        this.unlist(spare);
      }
    }

    if (!node) {
      return undefined;
    }

    this.unlist(node);
    // Back on the list, the old object is drawn whole into a node of its own.
    const was = node.owner.deref();
    if (was) {
      this.nodes.delete(was);
      was.dirty |= TRANSFORM | CONTENT | (was instanceof Container ? CHILDREN : 0);
    }

    node.owner = o.ref;
    node.stale = null;
    node.color = null;
    node.inherited = null;
    // The chain it keeps, as filters set alike keep it, is coloured only as the colour changes:
    // from none, as node.color now is, not in the old object's.
    const chain = node.filters[0];
    if (chain instanceof FilterChain) {
      chain.recolor(null);
    }

    node.slice = null;
    node.sliceKey = "";
    node.sliceOwner = null;
    node.sliceLinear = null;
    node.lineSpace = null;
    this.nodes.set(o, node);
    return node;
  }

  /**
   * Whether `node`, listed spare, may be taken by `o`: still off the list,
   * of its class, and not made a mask since it was listed, as an object
   * taken off the list in the frame a script makes it one is.
   */
  private fits(node: Node, o: DisplayObject): boolean {
    const container = node.container;
    return (
      node.released &&
      node.kind === o.constructor &&
      node.character === o.character &&
      container.includeInBuild !== false &&
      container.measurable !== false
    );
  }

  /**
   * List a node just released for a new object of its character to take:
   * not a mask's, whose container a masked one may still hold.
   */
  list(node: Node): void {
    // As its object is now: a timeline may have swapped the character it was made of.
    const owner = node.owner.deref();
    if (owner) {
      node.character = owner.character;
      node.kind = owner.constructor;
    }

    const character = node.character;
    const container = node.container;
    if (
      this.fresh ||
      !character ||
      node.masking ||
      container.includeInBuild === false ||
      container.measurable === false ||
      this.since.has(node)
    ) {
      return;
    }

    let listed = this.byCharacter.get(character);
    if (!listed) {
      listed = new Set();
      this.byCharacter.set(character, listed);
    }

    listed.add(node);
    this.since.set(node, performance.now());
    if (this.since.size > SPARE_NODES_MOST) {
      this.unlist(this.since.keys().next().value as Node);
    }
  }

  /** A node off the spares: taken, come back, kept too long, or past the most. */
  unlist(node: Node): void {
    if (!this.since.delete(node)) {
      return;
    }

    const character = node.character as object;
    const listed = this.byCharacter.get(character);
    listed?.delete(node);
    if (listed?.size === 0) {
      this.byCharacter.delete(character);
    }
  }

  /** Every spare let go of, as a SWF unloads (PixiView.dropSpares). */
  clear(): void {
    this.byCharacter.clear();
    this.since.clear();
  }

  /** The spares listed IDLE_MS or more before `now` let go of, oldest first. */
  expire(now: number): void {
    for (const [node, since] of this.since) {
      if (now - since < IDLE_MS) {
        break;
      }

      this.unlist(node);
    }
  }
}
