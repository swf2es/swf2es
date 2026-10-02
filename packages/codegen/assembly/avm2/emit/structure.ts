import * as ops from "../abc/opcodes";
import { MAX_NESTING, MethodEmitter } from "./method";
import { typeRef } from "./refs";

/** The index after block k's last instruction, and its first. */
export function blockEnd(em: MethodEmitter, k: u32): u32 {
  const ir = em.ir;
  return k + 1 < ir.blockCount ? ir.blockFirst[k + 1] : ir.count;
}

/** Whether block k ends in a branch, return or throw, not falling through. */
export function terminates(em: MethodEmitter, k: u32): bool {
  const ir = em.ir;
  const end = blockEnd(em, k);
  if (end === ir.blockFirst[k]) {
    return false;
  }

  const op = ir.op[end - 1];
  return (
    op === ops.OP_jump ||
    op === ops.OP_lookupswitch ||
    op === ops.OP_returnvoid ||
    op === ops.OP_returnvalue ||
    op === ops.OP_throw
  );
}

/** Whether op branches on a condition. */
export function conditional(op: u16): bool {
  return (
    (op >= ops.OP_ifnlt && op <= ops.OP_ifnge) || (op >= ops.OP_iftrue && op <= ops.OP_ifstrictne)
  );
}

/**
 * Block k's successors: the handlers covering any of it, the table's last
 * first; then every conditional branch in it (a block starts only where
 * something branches to, so one may be in the middle), then what its
 * last instruction does, or its fall-through.
 */
export function successors(em: MethodEmitter, k: u32): void {
  const ir = em.ir;
  const first = ir.blockFirst[k];
  const end = blockEnd(em, k);
  const next = k + 1 < ir.blockCount;
  if (end > first) {
    const from = ir.pc[first];
    const to = ir.pc[end - 1];
    for (let h = <i32>ir.handlerCount - 1; h >= 0; h--) {
      if (ir.handlerFrom[h] <= to && ir.handlerTo[h] > from) {
        em.succ.push(ir.handlerBlock[h]);
      }
    }
  }

  em.normalStart[k] = <u32>em.succ.length;
  for (let i = first; i < end; i++) {
    if (conditional(ir.op[i])) {
      em.succ.push(ir.a[i]);
    }
  }

  if (end === first) {
    if (next) {
      em.succ.push(k + 1);
    }
    return;
  }

  const i = end - 1;
  const op = ir.op[i];
  if (op === ops.OP_jump) {
    em.succ.push(ir.a[i]);
  } else if (op === ops.OP_lookupswitch) {
    em.succ.push(ir.a[i]);
    for (let c: u32 = 0; c <= <u32>ir.c[i]; c++) {
      em.succ.push(ir.cases[ir.b[i] + c]);
    }
  } else if (op === ops.OP_returnvoid || op === ops.OP_returnvalue || op === ops.OP_throw) {
    // No successor.
  } else if (next) {
    em.succ.push(k + 1);
  }
}

/**
 * The analysis the translation needs: successors and predecessors, a
 * reverse postorder, dominators (Cooper, Harvey and Kennedy's), each
 * block's children in the dominator tree, loop headers and forward edge
 * counts. False if the graph is irreducible: a retreating edge whose
 * target does not dominate its source.
 */
export function analyze(em: MethodEmitter): bool {
  const ir = em.ir;
  const n = ir.blockCount;
  if (<u32>em.rpo.length < n) {
    const size = max(n, 64);
    em.succStart = new StaticArray<u32>(size + 1);
    em.predStart = new StaticArray<u32>(size + 1);
    em.childStart = new StaticArray<u32>(size + 1);
    em.rpo = new StaticArray<i32>(size);
    em.order = new StaticArray<u32>(size);
    em.idom = new StaticArray<i32>(size);
    em.forwardIn = new StaticArray<u32>(size);
    em.loopHeader = new StaticArray<u8>(size);
    em.fill = new StaticArray<u32>(size);
    em.handlerOf = new StaticArray<i32>(size);
    em.normalStart = new StaticArray<u32>(size);
  }

  em.succ.length = 0;
  for (let k: u32 = 0; k < n; k++) {
    em.succStart[k] = <u32>em.succ.length;
    successors(em, k);
    em.rpo[k] = -1;
    em.idom[k] = -1;
    em.forwardIn[k] = 0;
    em.loopHeader[k] = 0;
    em.handlerOf[k] = -1;
  }

  // Each handler's own block, one block to a handler.
  for (let h: u32 = 0; h < ir.handlerCount; h++) {
    const block = ir.handlerBlock[h];
    if (em.handlerOf[block] >= 0) {
      return false;
    }

    em.handlerOf[block] = <i32>h;
  }

  em.succStart[n] = <u32>em.succ.length;

  // A depth-first walk from the entry: postorder, reversed. -2 marks a block on the way.
  const stack = em.dfsStack;
  const edge = em.dfsEdge;
  stack.length = 0;
  edge.length = 0;
  stack.push(0);
  edge.push(0);
  em.rpo[0] = -2;
  let post = n;
  while (stack.length) {
    const top = stack.length - 1;
    const k = stack[top];
    const e = edge[top];
    if (em.succStart[k] + e < em.succStart[k + 1]) {
      edge[top] = e + 1;
      const s = em.succ[em.succStart[k] + e];
      if (em.rpo[s] === -1) {
        em.rpo[s] = -2;
        stack.push(s);
        edge.push(0);
      }
    } else {
      stack.pop();
      edge.pop();
      em.rpo[k] = <i32>--post;
    }
  }

  // Reachable blocks, numbered from 0 in reverse postorder.
  const reachable = n - post;
  em.reachable = reachable;
  for (let k: u32 = 0; k < n; k++) {
    if (em.rpo[k] >= 0) {
      em.rpo[k] -= <i32>post;
      em.order[em.rpo[k]] = k;
    }
  }

  // Predecessors, by counting then filling.
  for (let k: u32 = 0; k <= n; k++) {
    em.predStart[k] = 0;
  }

  for (let e: u32 = 0; e < <u32>em.succ.length; e++) {
    em.predStart[em.succ[e] + 1]++;
  }

  for (let k: u32 = 0; k < n; k++) {
    em.predStart[k + 1] += em.predStart[k];
    em.fill[k] = em.predStart[k];
  }

  em.pred.length = em.succ.length;
  for (let p: u32 = 0; p < n; p++) {
    for (let e = em.succStart[p]; e < em.succStart[p + 1]; e++) {
      const s = em.succ[e];
      em.pred[em.fill[s]++] = p;
    }
  }

  // Dominators, iterated to a fixed point in reverse postorder.
  em.idom[0] = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (let r: u32 = 1; r < reachable; r++) {
      const b = em.order[r];
      let dom: i32 = -1;
      for (let e = em.predStart[b]; e < em.predStart[b + 1]; e++) {
        const p = em.pred[e];
        if (em.rpo[p] >= 0 && em.idom[p] >= 0) {
          dom = dom < 0 ? <i32>p : intersect(em, <u32>dom, p);
        }
      }

      if (dom !== em.idom[b]) {
        em.idom[b] = dom;
        changed = true;
      }
    }
  }

  // Edges: forward ones counted, retreating ones back edges to a
  // dominator, or irreducible. A handler's are forward, and its only ones.
  for (let r: u32 = 0; r < reachable; r++) {
    const p = em.order[r];
    for (let e = em.succStart[p]; e < em.succStart[p + 1]; e++) {
      const s = em.succ[e];
      if (e < em.normalStart[p]) {
        if (em.rpo[s] <= em.rpo[p]) {
          return false;
        }

        continue;
      }

      if (em.handlerOf[s] >= 0) {
        return false;
      }

      if (em.rpo[s] > em.rpo[p]) {
        em.forwardIn[s]++;
      } else if (dominates(em, s, p)) {
        em.loopHeader[s] = 1;
      } else {
        return false;
      }
    }
  }

  // The dominator tree's children, each block's in reverse postorder.
  for (let k: u32 = 0; k <= n; k++) {
    em.childStart[k] = 0;
  }

  for (let r: u32 = 1; r < reachable; r++) {
    em.childStart[em.idom[em.order[r]] + 1]++;
  }

  for (let k: u32 = 0; k < n; k++) {
    em.childStart[k + 1] += em.childStart[k];
    em.fill[k] = em.childStart[k];
  }

  em.child.length = reachable > 0 ? reachable - 1 : 0;
  for (let r: u32 = 1; r < reachable; r++) {
    const y = em.order[r];
    em.child[em.fill[em.idom[y]]++] = y;
  }

  // The translation recurses, and its code nests, along the dominator
  // tree: a block's code at most as deep as its dominator's, and a
  // labelled block for each of that one's merge children, a loop and an
  // if's braces around it. Deeper than engines parse keeps the dispatcher.
  em.fill[0] = em.loopHeader[0];
  for (let r: u32 = 1; r < reachable; r++) {
    const b = em.order[r];
    const d = <u32>em.idom[b];
    let merges: u32 = 0;
    for (let c = em.childStart[d]; c < em.childStart[d + 1]; c++) {
      const y = em.child[c];
      merges += em.handlerOf[y] >= 0 ? 2 : em.forwardIn[y] >= 2 ? 1 : 0;
    }

    const nesting = em.fill[d] + merges + em.loopHeader[b] + 1;
    if (nesting > MAX_NESTING) {
      return false;
    }

    em.fill[b] = nesting;
  }

  return true;
}

export function intersect(em: MethodEmitter, a: u32, b: u32): u32 {
  let x = a;
  let y = b;
  while (x !== y) {
    while (em.rpo[x] > em.rpo[y]) {
      x = <u32>em.idom[x];
    }

    while (em.rpo[y] > em.rpo[x]) {
      y = <u32>em.idom[y];
    }
  }

  return x;
}

/** Whether block a dominates block b. */
export function dominates(em: MethodEmitter, a: u32, b: u32): bool {
  let x = b;
  while (x !== a) {
    if (x === 0) {
      return false;
    }

    x = <u32>em.idom[x];
  }

  return true;
}

/** Block x and what it dominates: in a loop if it heads one. */
export function node(em: MethodEmitter, x: u32): void {
  const out = em.out;
  // Its children in the dominator tree that are merge nodes or handlers, the latest first.
  const merges: u32[] = [];
  for (let c = em.childStart[x + 1]; c > em.childStart[x]; c--) {
    const y = em.child[c - 1];
    if (em.forwardIn[y] >= 2 || em.handlerOf[y] >= 0) {
      merges.push(y);
    }
  }

  if (em.loopHeader[x]) {
    out.text("  L");
    out.uint(x);
    out.text(": for (;;) {\n");
    within(em, x, merges, 0);
    out.text("  }\n");
  } else {
    within(em, x, merges, 0);
  }
}

/** Block x's code inside a labelled block for each merge node from j, each followed by its code. */
export function within(em: MethodEmitter, x: u32, merges: u32[], j: i32): void {
  const out = em.out;
  if (j === merges.length) {
    structuredBlock(em, x);
    return;
  }

  const y = merges[j];
  out.text("  L");
  out.uint(y);
  out.text(": {\n");
  const h = em.handlerOf[y];
  if (h >= 0) {
    out.text("  try {\n");
    em.tryStack.push(<u32>h);
    within(em, x, merges, j + 1);
    em.tryStack.pop();
    out.text("  } catch (e) {\n");
    catchClause(em, <u32>h, y);
    out.text("  }\n");
  } else {
    within(em, x, merges, j + 1);
  }

  out.text("  }\n");
  node(em, y);
}

/**
 * Handler h's catch, around the code before its block y: the exception
 * if it came from one of h's regions and has its type, else on.
 */
export function catchClause(em: MethodEmitter, h: u32, y: u32): void {
  const out = em.out;
  const ir = em.ir;
  let low: u32 = 0;
  let high: u32 = 0;
  for (let r: u32 = 1; r < em.boundCount; r++) {
    const start = em.bounds[r - 1];
    if (em.covered[r - 1] && start >= ir.handlerFrom[h] && start < ir.handlerTo[h]) {
      low = low ? low : r;
      high = r;
    }
  }

  out.text("    const x = rt.caught(e);\n    if (");
  if (low === high) {
    out.text("t === ");
    out.uint(low);
  } else {
    out.text("t >= ");
    out.uint(low);
    out.text(" && t <= ");
    out.uint(high);
  }

  const type = ir.handlerType[h];
  if (type >= 0) {
    out.text(" && rt.catches(x, ");
    typeRef(em, type);
    out.text(")");
  }

  out.text(") { ");
  em.regName(<i32>(ir.localCount + ir.maxScope));
  out.text(" = x; break L");
  out.uint(y);
  out.text("; }\n    throw e;\n");
}

/** Whether the handlers covering region r have their trys open, innermost first in the table's order. */
export function enclosed(em: MethodEmitter, r: i32): bool {
  if (r === 0) {
    return true;
  }

  const ir = em.ir;
  const start = em.bounds[r - 1];
  let below = em.tryStack.length;
  for (let h: u32 = 0; h < ir.handlerCount; h++) {
    if (start < ir.handlerFrom[h] || start >= ir.handlerTo[h]) {
      continue;
    }

    let at = below - 1;
    while (at >= 0 && em.tryStack[at] !== h) {
      at--;
    }

    if (at < 0) {
      return false;
    }

    below = at;
  }

  return true;
}

/** Block k's instructions, and its fall-through as an explicit branch. */
export function structuredBlock(em: MethodEmitter, k: u32): void {
  em.currentBlock = k;
  em.blockBody(k);
  if (!terminates(em, k) && k + 1 < em.ir.blockCount) {
    em.currentBlock = k;
    em.out.text("    ");
    branchTo(em, k + 1);
    em.out.text("\n");
  }
}

/** A branch from the current block to block t. */
export function branchTo(em: MethodEmitter, t: u32): void {
  const out = em.out;
  const from = em.currentBlock;
  if (em.loopHeader[t] && em.rpo[t] <= em.rpo[from]) {
    out.text("continue L");
    out.uint(t);
    out.text(";");
  } else if (em.forwardIn[t] >= 2) {
    out.text("break L");
    out.uint(t);
    out.text(";");
  } else {
    // Its only way in: its code here, and then the block branching goes
    // on, a conditional branch's, with its own types, scopes and region.
    out.text("\n");
    save(em);
    // A loop's header is also entered from its end, with other checks.
    em.inPlace = !em.loopHeader[t];
    node(em, t);
    restore(em);
    em.mark();
    em.currentBlock = from;
  }
}

/** Push what writing a block follows: its registers' types, scopes and region. */
export function save(em: MethodEmitter): void {
  const ir = em.ir;
  const saved = em.saved;
  for (let r: u32 = 0; r < ir.frameSize; r++) {
    saved.push(em.regType[r]);
  }

  for (let d: u32 = 0; d < ir.maxScope; d++) {
    saved.push(em.scopeWith[d]);
  }

  for (let r: u32 = 0; r < ir.frameSize; r++) {
    saved.push(em.checked[r]);
    saved.push(em.promoted[r]);
  }

  saved.push(<i32>em.scopeDepth);
  saved.push(em.region);
  saved.push(em.file);
  saved.push(<i32>em.line);
}

/** Pop what save pushed. */
export function restore(em: MethodEmitter): void {
  const ir = em.ir;
  const saved = em.saved;
  em.line = <u32>saved.pop();
  em.file = saved.pop();
  em.region = saved.pop();
  em.scopeDepth = <u32>saved.pop();
  for (let r = <i32>ir.frameSize - 1; r >= 0; r--) {
    em.promoted[r] = <u8>saved.pop();
    em.checked[r] = <u8>saved.pop();
  }

  for (let d = <i32>ir.maxScope - 1; d >= 0; d--) {
    em.scopeWith[d] = <u8>saved.pop();
  }

  for (let r = <i32>ir.frameSize - 1; r >= 0; r--) {
    em.regType[r] = saved.pop();
  }
}
