// Where a body's control flow goes, as Verifier::checkTarget and mergeState
// follow it: branch, fall-through and handler targets, each the frame state
// it is entered with, every path into it of the same depths and its values
// merged, and the targets whose entry state changed walked again.

import { BodyDecoder, NOT_NULL, START } from "./code";
import * as C from "./constants";
import * as ops from "./opcodes";

/** Save the current state as known target t's entry state. */
export function saveEntry(bd: BodyDecoder, t: u32): void {
  const size = bd.frameSize;
  if (bd.entryUsed + size > <u32>bd.entryType.length) {
    const capacity = max(bd.entryUsed + size, <u32>bd.entryType.length * 2);
    const types = new StaticArray<i32>(capacity);
    const flags = new StaticArray<u8>(capacity);
    memory.copy(changetype<usize>(types), changetype<usize>(bd.entryType), bd.entryUsed << 2);
    memory.copy(changetype<usize>(flags), changetype<usize>(bd.entryFlags), bd.entryUsed);
    bd.entryType = types;
    bd.entryFlags = flags;
  }

  const at = bd.entryUsed;
  bd.entryAt[t] = at;
  bd.entryUsed += size;
  memory.copy(
    changetype<usize>(bd.entryType) + ((<usize>at) << 2),
    changetype<usize>(bd.valueType),
    (<usize>size) << 2,
  );
  memory.copy(changetype<usize>(bd.entryFlags) + <usize>at, changetype<usize>(bd.valueFlags), size);
}

/** Make known target t's entry state the current one. */
export function loadEntry(bd: BodyDecoder, t: u32): void {
  if (!bd.typed) {
    return;
  }

  bd.localsVersion++;
  const at = bd.entryAt[t];
  memory.copy(
    changetype<usize>(bd.valueType),
    changetype<usize>(bd.entryType) + ((<usize>at) << 2),
    (<usize>bd.frameSize) << 2,
  );
  memory.copy(
    changetype<usize>(bd.valueFlags),
    changetype<usize>(bd.entryFlags) + <usize>at,
    bd.frameSize,
  );
}

/** Put known target t on the work list unless it is there already. */
function requeue(bd: BodyDecoder, t: u32): void {
  if (!bd.pending[t]) {
    bd.pending[t] = 1;
    bd.work[bd.workCount++] = t;
  }
}

/**
 * As Verifier::checkTarget and mergeState: stay in the code, back edges need
 * a label or known target, and every path into a block has the same stack
 * and scope depths, whose values merge.
 */
export function target(bd: BodyDecoder, from: i64, to: i64, stack: u32, scope: u32): bool {
  // The second phase only visits what the first already checked.
  if (bd.emitPass) {
    return true;
  }

  if (to < 0 || to >= <i64>bd.length) {
    bd.code.fail(C.kInvalidBranchTargetError);
    return false;
  }

  const t = <u32>to;
  const isNew = !bd.known[t];
  if (to <= from && isNew && load<u8>(bd.start + t) !== ops.OP_label) {
    bd.code.fail(C.kInvalidBranchTargetError);
    return false;
  }

  if (isNew) {
    // Code decoded as part of another block must have been reached with the same state.
    const walked = bd.cover[t] === START;
    if (walked && !sameDepths(bd, bd.stackAt[t], bd.scopeAt[t], stack, scope)) {
      return false;
    }

    bd.known[t] = 1;
    bd.entryStack[t] = stack;
    bd.entryScope[t] = scope;
    if (bd.typed) {
      saveEntry(bd, t);
    }

    requeue(bd, t);

    // The block that walked through t must now end there and merge into it.
    if (walked && bd.typed && bd.walkOf[t] !== t) {
      requeue(bd, bd.walkOf[t]);
    }
  } else {
    if (!sameDepths(bd, bd.entryStack[t], bd.entryScope[t], stack, scope)) {
      return false;
    }

    if (bd.typed) {
      const changed = bd.mergeEntry(t);
      if (changed < 0) {
        return false;
      }

      if (changed) {
        requeue(bd, t);
      }
    }
  }

  // A loop header's implicit interrupt check can throw, so it reaches the
  // handlers covering it, even when the back edge is found after its block.
  if (to <= from && !bd.loopHeader[t]) {
    bd.loopHeader[t] = 1;
    if (bd.typed) {
      // Its handlers are reached with the state it is entered with.
      saveCurrent(bd);
      loadEntry(bd, t);
      const stackNow = bd.stack;
      const scopeNow = bd.scope;
      bd.stack = stack;
      bd.scope = scope;
      const reached = throwsAt(bd, t);
      bd.stack = stackNow;
      bd.scope = scopeNow;
      restoreCurrent(bd);
      return reached;
    }

    return throwsAt(bd, t);
  }

  return true;
}

function saveCurrent(bd: BodyDecoder): void {
  if (<u32>bd.savedType.length < bd.frameSize) {
    bd.savedType = new StaticArray<i32>(bd.frameSize);
    bd.savedFlags = new StaticArray<u8>(bd.frameSize);
  }

  memory.copy(
    changetype<usize>(bd.savedType),
    changetype<usize>(bd.valueType),
    (<usize>bd.frameSize) << 2,
  );
  memory.copy(changetype<usize>(bd.savedFlags), changetype<usize>(bd.valueFlags), bd.frameSize);
}

function restoreCurrent(bd: BodyDecoder): void {
  bd.localsVersion++;
  memory.copy(
    changetype<usize>(bd.valueType),
    changetype<usize>(bd.savedType),
    (<usize>bd.frameSize) << 2,
  );
  memory.copy(changetype<usize>(bd.valueFlags), changetype<usize>(bd.savedFlags), bd.frameSize);
}

function sameDepths(
  bd: BodyDecoder,
  stack: u32,
  scope: u32,
  otherStack: u32,
  otherScope: u32,
): bool {
  if (stack !== otherStack) {
    bd.code.fail(C.kStackDepthUnbalancedError);
    return false;
  }

  if (scope !== otherScope) {
    bd.code.fail(C.kScopeDepthUnbalancedError);
    return false;
  }

  return true;
}

/**
 * Edges from `pc` to every handler covering it. A handler starts with the
 * locals as they are, no scopes, and just the exception on the stack.
 */
export function throwsAt(bd: BodyDecoder, pc: u32): bool {
  if (bd.emitPass || pc < bd.tryFrom || pc >= bd.tryTo) {
    return true;
  }

  const abc = bd.abc;
  for (let i: u32 = 0; i < bd.handlerCount; i++) {
    const h = bd.handlerFirst + i;
    if (pc >= abc.exceptionFrom[h] && pc < abc.exceptionTo[h]) {
      if (bd.maxStack < 1) {
        bd.code.fail(C.kStackOverflowError);
        return false;
      }

      if (!bd.typed) {
        if (!target(bd, <i64>pc, <i64>abc.exceptionTarget[h], 1, 0)) {
          return false;
        }

        continue;
      }

      // The same locals as when last merged into bd handler change
      // nothing there, once a backward edge has made it a loop header.
      const to = abc.exceptionTarget[h];
      if (bd.handlerMerged[i] === bd.localsVersion && (to > pc || bd.loopHeader[to])) {
        continue;
      }

      const stack = bd.stack;
      const scope = bd.scope;
      const base = bd.stackBase;
      const firstType = bd.valueType[base];
      const firstFlags = bd.valueFlags[base];
      const firstOrigin = bd.origin[base];
      const type = bd.handlerType[i];
      bd.setValue(base, type, bd.domain.typeNotNull(type) ? NOT_NULL : 0);
      bd.stack = 1;
      bd.scope = 0;
      const reached = target(bd, <i64>pc, <i64>abc.exceptionTarget[h], 1, 0);
      bd.stack = stack;
      bd.scope = scope;
      bd.setValue(base, firstType, firstFlags);
      bd.origin[base] = firstOrigin;
      if (!reached) {
        return false;
      }

      bd.handlerMerged[i] = bd.localsVersion;
    }
  }

  return true;
}
