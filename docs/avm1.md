# AVM1

The plan for ActionScript 1 and 2 in swf2es: what AVM1 bytecode is
compiled to, where each piece lives, and the pull requests that get it
there. Steps 1 to 8 are built: `format`'s list of action blocks, the
decoder, the emitter, the runtime's values and its operators by version,
its objects, variables and global object, its functions and registers,
`With`, `Try` and `Throw`, and a main AVM1 SWF's root frames run by the
player; the rest is not.
[architecture.md](architecture.md) describes what is, and this document
is folded into it as each piece lands.

AVM1 is compiled, not interpreted. The same `codegen.wasm` that compiles
ABCs compiles a SWF's action blocks to an ES module, in the browser as
the SWF loads and ahead of time in the `swf2es` command, with the same
output in both. swf2es has no AVM1 interpreter, not even as a reference
to test the compiler against: what Flash traces and draws decides, from
Ruffle's corpus (Flash Player's traces of thousands of SWFs) and from
AIR's `adl` (`node oracle/flash.ts`).

AVM1 code is small and dynamic: almost every action looks a name up by
string, through a scope chain that `with`, `tellTarget` and paths such as
`_root.a:b` or `../x` change at run time, with semantics that depend on the
SWF's version. Little of that can be decided while compiling, so the
compiler stays simple, a decoder and a dispatcher, and the effort goes to
the runtime.

## Where each piece lives

| Piece | Where | Depends on |
|---|---|---|
| A SWF's action blocks, found and listed | `format/src/actions.ts` | — |
| Decoding, control flow, emission | `codegen/assembly/avm1/` | — |
| What both bytecodes' emitters share (`Output`, the source map) | `codegen/assembly/` beside `avm2/` | — |
| Values, conversions, objects, functions, scopes, the language's classes | `runtime/src/avm1/` | format |
| Paths and targets on the display list, the action queue, events, the display, input and I/O classes | `player/src/avm1/` | runtime, codegen, format |
| AVM1 modules ahead of time | `cli` | codegen, format |

This keeps the package boundaries as they are: `runtime` has no display
list, so what needs one, `_root`, a clip's `_x` or `loadMovie`, is the
player's, reached through an interface the runtime declares
(`runtime/src/avm1/host.ts`) and the player implements, as AS3's
playerglobal natives are the player's and the language's natives the
runtime's. `codegen` knows the AVM1 runtime's function names but never
imports it.

`player/src/avm1/` mirrors `playerglobal/`: the host and the frame's AVM1
work at its top (`avm1.ts`, `paths.ts`, `queue.ts`, `events.ts`), and the
AS2 classes the player provides in `globals/`, a file per class
(`globals/MovieClip.ts`, `globals/TextField.ts`...). Its unit tests
mirror it under `tests/unit/player/avm1/`, as the mirror test requires.

## A SWF's action blocks

AVM1 code is spread through a SWF, not kept in one tag:

- **DoAction** (12): a timeline frame's actions, the root's or a
  DefineSprite's, run when the clip enters the frame;
- **DoInitAction** (59): a sprite's `#initclip` actions, in a frame of
  the root's timeline, run once, as the tag is reached, before that
  frame's DoAction (Ruffle's `run_stack_frame_for_init_action`);
- **clip actions**: a PlaceObject2 or 3's CLIPACTIONRECORDs, each a set of
  event flags (16 bits up to SWF 5, 32 from 6), a key code for
  `keyPress`, and its actions;
- **button actions**: DefineButton's one block, run on release, and
  DefineButton2's BUTTONCONDACTIONs, each a set of state transitions and
  a key code with its actions.

`format` lists them all, in tag order and within a tag in record order,
as `ActionBlock`s: the bytes, what they belong to (a frame of a timeline,
a sprite's init, a place's event, a button's condition) and their index
in the list. The index is how the player finds a block's compiled code,
and the list is a pure function of the SWF's bytes, so the JIT and AOT
modules agree on it. `readPlace` and `readButton`, given the list, give
the indices of the blocks they own.

Where adl reads clip actions otherwise than Ruffle, adl decides: only
flags of 0 end a place's records (one of unknown events is skipped), a
record runs only for the events the place's field of all events also has,
and a record that runs past its tag stops the whole SWF, every timeline
of it, none of the place's records run. Flash reads a place's records as
the first event of its field of all events comes, and stops there: as it
places the clip for `load` and `initialize`, before any of the frame's
actions; after the frame's DoInitActions for `construct`; at the next
frame for `enterFrame`; and as an `unload`, a key, the pointer or `data`
comes for those, never if none does (adl, the SWF's whole player hung).
Such a tag has no blocks and is in the list's `corrupt`, its field of all
events in `corruptEvents`, for the player to stop the SWF there. A
malformed button action keeps the records before it; adl defines the
button, and whether those run there is not checked yet (step 12). The
list has the blocks of an ActionScript 3 SWF too, whose FileAttributes
flag says it runs none of them.

## Compiling

`Codegen.compileActions(bytes, actions)` compiles a SWF's whole list of
blocks, as `format`'s `readActions` gives it (the SWF's version and each
block's range of its decompressed bytes), to one ES module, as `compile` compiles an ABC to one: one
module a SWF, not one a block, since a SWF has a block for every frame
script, event and button and a `Function` each would cost more than the
code. The SWF's version is an input, since the compiler picks the
version's operations (below), and part of the module's key with the
compiler's identity and the SHA-256 of the SWF's decompressed bytes
(`actionsKey`), so the module cache and AOT modules serve AVM1 as they
serve ABCs. `compileActionBlocks` compiles blocks alone, by index, each
byte for byte its entry in the module, as a JIT that compiles a block
when it first runs would. AVM1 needs no domain: a block
links to nothing at compile time, every name resolves at run time.

In `codegen/assembly/avm1/`, grouped as `avm2/` is, by stage:

- `actions/`: the opcodes and their operands (`opcodes.ts`), the
  decoder (`decode.ts`). Actions below 0x80 have no operands; from 0x80 a
  length follows. The decoder reads every action reachable from a block's
  start, following jumps, and decodes each offset once, so a jump into the
  middle of an action, as obfuscators write, decodes from there as Flash
  reads it. An unknown opcode is skipped, as adl does. An operand or a
  length past the block's end, and a `Push` of a value type Flash does not
  know, stop the whole SWF there, as adl does, as at a clip action past
  its tag, even with the SWF's next tag behind it: the emitter writes
  `V.halt(cx)`, which the player is to take as it takes `corrupt`. Flash
  Player 9 and Ruffle skip the unknown value type instead; adl decides.
  The one place swf2es knowingly parts from adl is a jump before the
  block's first byte (below). Never a trap: errors are sticky flags, as
  in the ABC parser.
- `flow/`: blocks and regions. A block starts at a jump's target, an
  `If`'s, a `WaitForFrame`'s skip, and after each. A **region** is code
  Flash runs as an activation of its own: a block's whole code, or a
  DefineFunction's body. Flash runs a region until its program counter
  leaves its end: a jump past the end, or the code running off it, leaves
  the region (for a function, returns), and a jump back before its start
  stays in it, running the bytes there (adl runs a function's body that
  jumps back before its `DefineFunction`, and Ruffle's `run_actions` over
  a subslice does the same). So a region's blocks are its own, and an
  offset reached from two regions is in each (decoded once, emitted in
  each). Each `DefineFunction` action has a region, since a
  `DefineFunction2`'s header (its registers and preloads) shapes its body's
  code, and an action is decoded once, so a body that jumps back before its
  own `DefineFunction` defines itself again with the same region: regions
  form a graph, cycles included, and the emitter writes each once, not
  inlined into its parent. A target before the
  block's first byte is taken as the block's exit; adl, as Ruffle, runs
  the SWF's bytes before the block there, which a block compiled alone
  does not have. The constant pool is tracked along
  the flow: where one `ConstantPool` reaches a `Push` on every path, its
  strings are literals, and a constant past the pool's end `undefined`, as
  Ruffle pushes it; where none or several may, the push reads the
  activation's pool at run time, `cx.pool[i]`, which `V.constantPool`
  sets as the action runs. A region starts with the activation's pool,
  which the runtime gives it (see "The constant pool" below), and so
  does a `Try`'s catch or finally, which a throw reaches from anywhere in
  the try body (`flow/pool.ts`).

  `With` and `Try` bodies are not regions, though Ruffle runs them as
  activations: in adl their code runs in the activation that reached
  them, and the `With`'s scope or the `Try`'s handler holds while the
  program counter stays in their bytes. A jump out of a body, back before
  it or past its end, drops them and goes on at its target: a `With`'s body
  that jumps back before the `With` finds no scope there, and opens one
  again at the `With`; a `Try`'s body that jumps back has no handler for
  a throw there. Code running off a try body runs the catch's bytes and
  the finally's after them, thrown or not, which is why compilers end a
  try body with a jump past its catch. A jump into a body from outside
  has no scope or handler either. So for the flow a `With` branches to
  its body and past it, a `Try` to its try body and, where a throw lands,
  to its catch's or finally's bytes, and their bodies' bounds start
  blocks, where the emitter drops what is no longer held (see "With and
  Try" below for when exactly).
- `emit/`: a block as an array of its regions' functions (`block.ts`),
  the block's own code first, then the bodies of the functions it
  defines, in the order the flow finds them; the module around them
  (`module.ts`); strings as JavaScript literals (`strings.ts`), read as
  adl reads them. Up to SWF 5 a string is its bytes, each the character of
  its value (0x80 is U+0080, not Windows-1252's euro, which Ruffle reads).
  From SWF 6 it is UTF-8 read leniently, as Unicode's old `ConvertUTF.c`
  sums a sequence: a lead byte takes the bytes its high bits ask for,
  continuation bytes or not, so overlong forms read and `C3 41` is
  U+0081; a byte that leads nothing is its own character; a surrogate or
  a code point past U+10FFFF is U+FFFD; and a code point of 0, or a
  sequence the string's end cuts short, ends the string there.

### The dispatcher

Each region is written in the dispatcher form the AVM2 emitter falls back
to, `let b = 0; for (;;) switch (b) { case 0: ...; b = 3; continue; }`, a
case per block. That handles any control flow AVM1 compilers and
obfuscators write. A region of one block that nothing jumps back into is
written straight, without the dispatcher. Structured output, as
`emit/structure.ts` makes for AVM2, comes later, for blocks that profile
hot.

The operand stack is a JavaScript array, `st`, which a region takes from
the activation, `cx.st`: a `Push` is `st.push(...)` and an action's
operands `st.pop()`, which gives `undefined` on an empty stack, as
Flash's AVM1 does. In adl it is one stack, not one an activation: what a
frame's block leaves on it the next block run in that frame pops, a
DoInitAction's and a clip event's included, and a function's body pops
its caller's values below its own and leaves what it does not pop under
the value the call pushes. Frames do not share it: what a frame left is
gone when the next frame's actions run. So the runtime gives every
activation of a frame's actions the same array and empties it between
frames (step 4). AVM1's stack depth is not fixed at a merge (`Enumerate`
pushes as many names as an object has, and the loop after it pops until
`null`), and a region may pop below its start, so registers for stack
slots, as AVM2's `s0`, come later, for regions whose depths the decoder
can prove, spilling to `st` at calls and at the region's ends.

- **Jump** and **If**: `b = k; continue;`, and `if (V.toBoolean(st.pop()))`
  before it. A jump out of the region is the region's exit.
- **WaitForFrame** and **WaitForFrame2**: the skip's target is a count of
  actions, which the decoder turns into an offset; the branch asks the
  host whether the frame is loaded. The player has the whole SWF before it
  plays, so every frame is, but the branch stays for SWFs that test it.
- **With**: `V.with(cx, st.pop(), from, to)` puts the object on the
  activation's scope chain, held over the body's blocks, from `from` to
  `to`: a region's blocks are in the order of their offsets, and a body's
  bounds start blocks, so each body is a range of them. It gives false,
  and the code goes on past the body, for `undefined` and `null`, in adl
  as in Ruffle (`action_with`), and where the chain is full (below).
- **Try**: `V.try(cx, ...)` puts its handlers on the activation, held over
  the try and catch bodies' blocks, with where a throw lands and the
  catch's variable or register. The dispatcher's loop of a region with a
  `Try` runs in a JavaScript `try`/`catch` whose catch asks `V.caught`
  which block to go on at, and sets the register a catch took the value
  into, a DefineFunction2's own `let` among them; so in such a region
  every block sets `b` as control falls into it, for a throw to know
  where it was. `Throw` throws the runtime's `Avm1Throw` with the value.
  An error of the host's, a bug's, or the recursion limit's passes
  through every catch and finally.
- **Leaving a body**: what is held is the activation's (`control.ts`),
  each entry over a range of blocks. A branch or a fall-through from a
  block in a try, catch or finally body to one outside it goes through
  `b = V.leave(cx, k); continue;`, which takes off the Trys that do not
  hold over block `k`, and where a finally that a throw or a Return
  reached is left, throws or returns instead. A scope comes off one action
  late, as adl has it (below): a block that an edge out of a With's or a
  catch's body reaches calls `V.scopes(cx, k)` after its first action,
  before it where that action branches, ends the block or opens a body.
  The other blocks, and every region without a `With` or a `Try`, are
  written as before, with no cost of either.
- **Return** pops the value it returns, `return st.pop();`, from a
  function's region; in a frame's block it ends the block, the value
  popped all the same. A region that runs off its end returns undefined.
  In a try or catch body of a `Try` with a finally it is
  `b = V.ret(cx); continue;`: the finally runs first, and the region
  returns the stack's top as control leaves it, through the case `-1`,
  `return cx.ret;`, that such a region's dispatcher has for its exit.

A region's function takes the activation, `cx`: its scope chain, target,
`this`, the constant pool, the operand stack, the registers, the
version's operations and the SWF's host. A module, an entry per block in
the order `readActions` lists them, looks like:

```js
export default function (rt) {
const V = rt.version(6);
return [
[function (cx) {
const st = cx.st;
V.constantPool(cx, ["frame"]);
st.push("frame");
V.trace(cx, st.pop());
return;
}],
[function (cx) {
const st = cx.st;
let b = 0;
for (;;) switch (b) {
case 0:
st.push(cx.pool[0]);
if (V.toBoolean(st.pop())) { b = 2; continue; }
case 1:
V.notYet("GetVariable");
V.stop(cx);
case 2:
return;
}
}, function (cx) {
const st = cx.st;
st.push("in a function");
V.trace(cx, st.pop());
return;
}],
];
}
```

Step 3 writes `Push` of constants, `ConstantPool`, `Trace`, `Pop`,
`Jump`, `If`, `Play`, `Stop` and `End`, and step 5 the arithmetic,
comparison, logical, bitwise, string and conversion actions, each a call
of its version's operation with the values it pops, the top first,
`st.push(V.subtract(st.pop(), st.pop()));`, and `PushDuplicate` and
`StackSwap` inline. Step 6 writes the variable, member, object and call
actions as calls that take the activation and their operands as popped,
`st.push(V.getMember(cx, st.pop(), st.pop()));` (the name, then the
object), or that pop them themselves where their number is on the stack
(`V.initObject(cx)`, `V.callMethod(cx)`...), and step 7 `DefineFunction`,
`DefineFunction2`, `StoreRegister`, a `Push` of a register and `Return`
(below). Every other action Flash knows is `V.notYet("<name>")`, which
throws, so the steps after fill them in one at a time; an unknown opcode is
skipped, and an action Flash cannot read is `V.halt(cx)`. A block the flow finds too large is `V.tooLarge()`.

### Version-dependent semantics

What an action does depends on the version of the SWF whose code runs it,
not the version of the objects it touches: `Add2` of `undefined` is `0` up
to SWF 6 and `NaN` from 7, `ToString(undefined)` is `""` up to 6 and
`"undefined"` from 7, names are case-insensitive up to 6, a string is
true by its number up to 6 and by its length from 7, a boolean is the
string `1` or `0` up to SWF 4, and a string is bytes up to SWF 5. A module
is compiled for its SWF's version, so the emitter picks the operations then: `rt.version(v)`
gives a table of the operations for versions like `v`, `V.add2`,
`V.equals2`, `V.toString`, `V.getVariable`, made once per version and
shared, so a call site sees one function, never a version test. The
corpus's version-specific quirks, each in Ruffle with a test, come with it:
SWF 4's `Divide` by zero pushes `"#ERROR#"`, `-0x10` is `NaN` while `0x10`
reads as hex from SWF 6, `>>>` is signed in
SWF 8 and 9, `SetTarget2(undefined)` resets the target differently up to
SWF 6, and `this` is case-insensitive up to SWF 5. Where an
action's behaviour does not depend on the version, the emitter writes it
inline (`PushDuplicate`, `StackSwap`).

What adl traces of the operators at SWF 4, 5, 6, 7, 8 and 10 (the
`avm1-operators-swf*` player cases), where it is not what Ruffle does or
what the specification says:

- Every comparison and logical action pushes a boolean in every version,
  SWF 4's `Equals`, `Less`, `And`, `Or`, `Not` and `StringEquals` too (as
  Ruffle has it, not the specification's 1 and 0); a SWF 4 traces it as
  `1` or `0`, as it writes any boolean.
- Flash has a NaN equal to a copy of itself and to no other NaN, in
  `Equals2` and `StrictEquals`: the global `NaN` read twice is equal, as
  the corpus's `NaN == NaN` is, but `0/0 == 0/0`, and two pushed NaNs,
  are not (its numbers are references to doubles, compared first by
  reference). SWF 4's `Equals` has none equal. A JavaScript number has no
  identity, so swf2es takes every NaN equal to every other in `Equals2`
  and `StrictEquals`, as Ruffle does: the corpus's `NaN == NaN` and
  `x != x` of a variable answer as Flash does, two NaNs computed apart do
  not. The player cases compare no NaN with another.
- A division by zero from SWF 5 takes the zero as unsigned: `1 / -0` is
  `Infinity`, `-1 / -0` `-Infinity` (Ruffle divides as IEEE does).
- `Less2` and `Greater` have the empty string after every other string:
  `"" < "a"` is false and `"a" < ""` true (Ruffle compares them as
  ECMAScript does). Other strings compare by code unit, a SWF 5 one by
  byte, as Ruffle does.
- Up to SWF 5, `StringLess` and `StringGreater` of the empty string and a
  string from a byte 0x80 up have neither less than the other, and each
  greater (Ruffle orders them).
- A string with no digit is no number: `"."` is `NaN` from SWF 5, as `""`
  is (Ruffle reads it as 0).
- Up to SWF 5 a string is bytes: `AsciiToChar` takes the code's low byte
  (Ruffle a UTF-16 unit), `MBAsciiToChar` writes a code past 0xFF as two
  bytes, the high one first (Ruffle one character), `StringLength`,
  `CharToAscii` and their MB actions count and read bytes, as a
  single-byte locale such as adl's has the MB actions do, and `trace`
  writes the bytes as UTF-8, what is not UTF-8 as U+FFFD, as the encoding
  standard's decoder has it (Ruffle reads a SWF 5 string as Windows-1252).
  A double-byte locale's MB actions (Shift-JIS) are left out. From SWF 6
  the char actions take UTF-16 units, a surrogate as U+FFFD, as in Ruffle.
- `StringExtract` and `MBStringExtract` take their start as `index - 1`
  in 32 bits, so an index of -2^31 starts past the end (Ruffle clamps it
  to the first character). From SWF 6, each half of a surrogate pair they
  cut is U+FFFD wherever it is compared or joined, so the halves joined
  again are two U+FFFD, not the pair (Ruffle keeps the halves). adl's
  trace of a cut low half alone writes three U+FFFD, the bytes it keeps;
  swf2es writes one.
- Numbers are written alike in every version, and read alike from SWF 6;
  adl hangs on a string such as `"1e2147483648"` as a number, scaling by
  ten once per unit of its exponent, which swf2es reads as `Infinity`.

### Functions and registers

`DefineFunction` and `DefineFunction2` make a function of a region of the
block, `V.defineFunction(cx, k, "name", ["a", "b"])`, the region `k` of
the block's entry, `function (cx, self, args) { ... }`, not a JavaScript
closure: an AVM1 closure captures the scope chain, which the function
object keeps, so the region needs nothing of the JavaScript frame it was
defined in, and each block is written alone, as the JIT/AOT invariant
asks of AVM2's methods. The function object keeps the activation's scope
chain, its constant pool (see below), its target and its `this`; a named
one is defined as `DefineLocal` defines a variable, an anonymous one
pushed. A call (`functions.ts`'s `ScriptFunction`) makes the activation:
an activation object for its local variables above the chain it closes
over, its parameters without a register set on it (undefined past the
arguments given, the later of two of a name), and the caller's operand
stack, so a body pops its caller's values and leaves what it does not
pop under the value the call pushes.

A DefineFunction2's registers below its register count are the region's
own `let`s, `r0` to `rN`, since their indices are in the code: its preloads
(`this`, `arguments`, `super`, `_root`, `_parent`, `_global`, in that
order from `r1`, each where its flag is set, one also suppressed
undefined but `arguments`, which preload and suppress loads) and then its
parameters with a register are set on entry, a later parameter over an
earlier one of the same register. A parameter whose register is at or
past the count is neither a register nor a variable, and a preload past
it is dropped. A root, which has no parent, takes no register for
`_parent`: `_global` takes its place (the corpus's
`define_function2_preload_order`; adl, whose harness loads the SWF, gives
its root a parent, whose register is undefined). Every other register,
of a frame's block, a DefineFunction's or one past a DefineFunction2's
count, is one of the movie's four, `cx.g[i]`, which the frame's blocks
share and which are undefined again as the next frame starts; a register
from 4 is none, undefined, and `StoreRegister` to it stores nothing.
`StoreRegister` leaves its value on the stack (popped and pushed again,
undefined on an empty one).

Local variables (`DefineLocal`, a parameter without a register) live on
the activation object, since `eval` and `GetVariable` of a computed name
can reach them; a later step can make them `let`s in a function that
names all its variables with constants and has no `eval`, `with` or
nested function. `arguments` and `super` are variables on it too, which
most functions never read, so the object makes each as a lookup first
misses it (`Avm1Object.lazy`): a call allocates the activation, its
object and the arguments' array, nothing else.

What adl traces of them at SWF 5 to 10 (the `avm1-functions-swf*` player
cases), where it is not what Ruffle does:

- `this` is the object a method was found on (`CallMethod`), the object a
  path names (`CallFunction("o.f")`), and for a name the scope that had
  it, a function's activation object too (a function called by name
  inside another gets that one's activation object); in a SWF 5 a
  function found on an activation object gets the target's clip.
  `CallMethod` of an empty name calls the object with `this` undefined.
  A primitive's method gets the primitive boxed.
- A DefineFunction2 that preloads or suppresses `this` has, as its
  `this`, the `this` of the activation that defined it, undefined in a
  SWF 5 (Ruffle: its caller's).
- From SWF 6 a function closes over the scope chain it was defined in; a
  SWF 5 function runs above the clip of its `this`, or else of its
  caller's target, as Flash 5 did, its variables not found reaching the
  timeline (`counter()` of a SWF 5 counts on the root). A SWF 5
  function's named `DefineFunction` defines it on that clip, not as a
  local variable, which `DefineLocal` still makes.
- `arguments` is an array of the arguments, `callee` and `caller`
  DontEnum on it, `caller` the function that called, null from a block; a
  new one each call, not tied to the parameters. `Delete2` removes it.
- `super` is made where a method is called on an object: by
  `CallMethod`, `new`, a getter or setter, `Function.call` and `apply`; a
  function called by name has none, and a SWF 5 none at all (Ruffle makes
  one wherever `this` is an object). `super(...)` runs the
  `__constructor__` of the prototype above the one the method was found
  on, with the method's `this`; `super.m()` finds `m` from the prototype
  above, a method on the object itself counting as on its prototype, so a
  chain of three classes calls each level once. That is from SWF 7, a
  method a getter gives counting as found where the getter was; up to
  SWF 6 a method's `super` is the prototype above `this`'s wherever the
  method was found, and `super.m()`'s one above that.
- What the player does not do yet: the activation object a function
  called by name inside another gets as `this` lists `arguments` in
  `for..in`, after its variables, but not `super`, and its `arguments`
  read from the inner function is the inner function's; a parameter named
  `arguments` given null or undefined leaves `arguments` there, one named
  `super` gives way to `super`, and a local variable named `this`, a
  parameter too, is what `this` reads in the function.
- `new` gives the object it made, whatever the constructor returns;
  `Function.call` and `apply` take null or undefined as the global
  object, a primitive boxed, and `apply` an array or anything with a
  `length`; `Function()` of nothing is an object without a prototype.
- A SWF up to 6 runs no getter, setter or watcher of a property inside
  another of the same property: the getter gives the stored value, the
  setter and watcher are skipped. From SWF 7, 65 run one inside another,
  as Ruffle has it for every version (the corpus's `*_recursion_swf6`
  are Ruffle's known failures).
- Function calls go 999 deep, the 1000th disabling every action of the
  movie, the rest of its frame and every frame after, while its
  timelines play on (Flash Player's documentation says 256, Ruffle stops
  at 255). In adl the actions of every AVM1 SWF loaded after it stay
  disabled too, so the player cases that reach the limit are drawn in an
  adl of their own. A SWF's `ScriptLimits` tag sets the depth, `n`
  allowing `n - 1` calls (the frame's actions are a level of their own:
  1 or 0 runs no action at all), in adl too; it takes effect as its frame
  comes, before the frame's actions, and of two in a frame the later
  (`avm1-script-limits`). Its script timeout, in seconds, is kept for when
  scripts have one. JavaScript's own stack running out, which a `toString`
  that calls itself can do, disables the actions as well; so can a limit
  set high, and a chain of calls near the default limit whose JavaScript
  frames are large: in node, plain calls run out after some 1100 levels,
  `apply` after some 680 and a DefineFunction2 of 64 registers after
  some 730, where adl allows 999 (a smaller stack per call, or a call not
  on JavaScript's stack, would be needed to match it). Any other
  RangeError is an error like the rest.

### With and Try

What adl traces of them at SWF 5 to 10 (the `avm1-control-swf*` player
cases), where it is not what Ruffle does, which runs each body as an
activation of its own:

- A With's object, a primitive boxed, is above the chain while control
  is in its body and at the first action past it, which control reaches
  by running off the body's end or by a jump to it, and comes off after
  that action. So `with (o) { ... }` followed at once by a function's
  definition gives the function `o` in the chain it closes over, and a
  GetVariable that is the first action past a body finds `o`'s
  properties. Control going anywhere else, by a jump forward past that
  action or back before the `With`, takes the scope off at once, and a
  jump into a body from outside finds none; a branch at that first action
  back into the body keeps it. adl looks only at the scope on top: a With
  that is the first action past a body puts its object over the scope,
  which stays under it until both come off past the second body.
- A With is skipped, as `with (undefined)` is, where the scope chain
  already holds 15 scopes, `_global` and the clip included: 13 Withs one
  in another in a frame's code, 12 in a function's from SWF 6 (its
  activation object is one more), but 13 in a SWF 5 function's, and fewer
  in a function that closes over Withs or a catch. Ruffle has no limit.
- `DefineLocal` in a With's body defines the variable on the scope under
  the With's object where the object lacks it, as in Ruffle; `SetVariable`
  sets it where the chain has it, else on the timeline.
- A catch into a variable makes an object for it, held over the catch
  body above the chain, as a With's object is (Ruffle sets the variable
  as SetVariable does): the variable is gone after the catch, an outer
  one of the name is unchanged, a function defined in the catch closes
  over it, and the name is taken as it is, never as a path. A catch into
  a register sets a DefineFunction2's own, else one of the movie's four,
  else none, as StoreRegister does. A throw in a With's body, or at the
  first action past it, caught by a catch outside it, keeps the With's
  object over the catch body, under the variable's, whether the catch
  takes a variable or a register; a catch that throws again keeps them
  over the next catch's. A finally reached by a throw or a `Return` keeps
  a scope only as a jump there would, for its first action where that is
  the first past the scope's body.
- A throw cuts the operand stack back to its height as the `Try` ran, as
  Ruffle does, landing in a catch or a finally; a value nothing catches
  leaves the stack as it is.
- Code running off a try body runs the catch's bytes, the variable not
  set, then the finally's. A jump out of a try or catch body runs no
  finally; a `Return` in one runs the finally, the stack cut back to its
  height as the `Try` ran and the value left on top of it while it runs,
  and then returns what is on top of the stack: what a finally pushes is
  returned, the value under it left on the stack, and a finally's own
  `Return` returns its value and leaves the first. A
  finally reached by a throw or a `Return` throws or returns as control
  leaves it, at once, even by a jump; a throw or a `Return` in it takes
  their place.
- A thrown value nothing catches ends its block, function calls included,
  and writes nothing: the frame's next block runs, and the next frame.
  Every value can be thrown, `undefined` too, as `Throw` on an empty stack
  does. Past the recursion limit no catch or finally runs.
- A throw in a function a native calls, a getter, a setter, `__resolve`,
  `valueOf`, `toString`, `Function.call` or `apply`, a constructor, goes
  through the native to the caller's catch, the rest of the native's work
  undone (`Array.join` calls no other `toString`). `trace` of an object
  whose `toString` throws writes `[type Object]`, or `[type Function]`,
  then throws; a watcher that throws sets the property to undefined, then
  throws. Ruffle does neither.
- `Try` and `Throw` run in a SWF 5 and 6 too, and `Error` is there in
  every version, on `_global` and not enumerated: `new Error(m)` has its
  own `message` where `m` is given and not undefined, the prototype's
  `message` and `name` are `"Error"` and listed by `for..in`, with its
  `toString`, which gives `this.message`, and `Error(...)` called as a
  function gives undefined. Step 9 completes the classes.

### The constant pool

What adl does with `ConstantPool`, for the runtime (steps 4 and 7):

- A frame's `DoAction` blocks share a pool: a block without a
  `ConstantPool` of its own reads the one the frame's last block set.
  A frame's pool is not the next frame's, and neither a
  `DoInitAction`'s nor a clip event's pool reaches the blocks after it.
- A function keeps the pool of the activation that ran its
  `DefineFunction`, as it was then: a `ConstantPool` after the
  definition, before the call, does not change what the body reads, in
  the frame it was defined in or a later one. A `ConstantPool` in its
  body sets its own activation's pool, not its caller's, nor the
  frame's, nor what its next call starts with.
- A `With`'s and a `Try`'s bodies run in their activation, and a
  `ConstantPool` in them holds after them.
- A constant past the pool's end, an empty pool's included, is
  `undefined`.
- A constant read where no pool was set (a frame's first block, a
  `DoInitAction`, a clip event, a function defined before any pool)
  reads whatever adl's memory holds there: most often `""`, at times
  bytes of other strings, `undefined` past a few indices, and in a
  `Push` of several values it can end the block. No compiler writes
  that; swf2es reads `undefined` there, as past a pool's end.

## The runtime

`runtime/src/avm1/` holds AS1 and AS2 as a language, with no display
list, so its unit tests run in node.

### Values

An AVM1 value is a JavaScript primitive, `undefined`, `null`, a boolean, a
number (always a double: AVM1 has no int type, and `Push`'s integer type
is a number) or a string, or an `Avm1Object`. AVM1 values are not AS3
values: an AS3 object never appears in AVM1 code and an AVM1 object never
in AS3; what crosses between them is copied (below).

The conversions are per version, as Ruffle's `Value` has them
(`coerce_to_f64`, `coerce_to_string`, `abstract_eq`, `abstract_lt`): a
string to a number reads hex, an exponent and spaces as Flash does, which
is neither JavaScript's `Number` nor AS3's, and a number to a string has
AVM1's own formatting (15 significant digits, its own exponent form),
which `numbers.ts` writes, apart from AS3's avmplus-derived one. Both are
Ruffle's, translated with the carry's bugs (-9999999999999996 is `-e+16`),
and adl traces them alike (the `avm1-hello` case). `values.ts` has the
conversions, `toBoolean`, `toNumber` and `stringOf`; `operators.ts` the
actions that take more than a conversion (`Add2`, `Equals2`, `Less2`,
`StringExtract`...); `runtime.ts` the `Activation`
(`st`, `pool`, `target`, `host`), the operations a version's `V` holds,
and the errors: `NotYet`, an action not done yet, which ends its block
and is reported, `Halt`, thrown once the host has stopped the SWF at
an action Flash cannot read, and `Avm1Throw`, a value `Throw` throws,
which ends its block where nothing catches it (`control.ts` has what
`With` and `Try` hold). `trace` writes `undefined` whatever the
version, as Flash does, and its text as it is: Flash's log breaks a line
at a carriage return as at a line feed (the corpus's `trace`, and AS3's
`edittext_newline_stripping`), where adl's stderr keeps the `\r`, so the
tests' harnesses break lines so, in the player's traces and adl's alike,
for AS3 as for AVM1 (`oracle/flash.ts`, `tests/player/page.ts`); a host
writing a log does the same.

Converting an object calls its `valueOf` or `toString`: `ToNumber`,
`Less2` and `Equals2` (both sides first, up to SWF 5) ask `valueOf`, `Add2`
asks it but a Date's `toString` from SWF 6, `ToString` asks `toString`, a
clip writes its path. Step 5 does every primitive's conversion and leaves
these to hooks, `objects` in `values.ts` (`valueOf`, `toPrimitive`,
`toString`, `typeOf`), which `realm.ts` sets: each calls the object's
method as Flash's "special" calls do, without `__resolve`, a method that is
missing or no function giving undefined, so a bare object's `valueOf` is
undefined and `_global == null` is true. Step 9 adds the classes' own
(Date's `toString` in `Add2`); the version is their argument, so they are
set once for all. An object compared with `null` or `undefined` by
`Equals2` goes through its `valueOf` too, as in adl and Ruffle.

### Objects

An `Avm1Object` (`objects.ts`) keeps its properties in a JavaScript `Map`
by their exact names, in the order they were added, each a `Property`
with its value or its getter and setter (`addProperty`) and its
attributes (`ASSetPropFlags`: don't enum 1, don't delete 2, read only 4,
and the version bits that hide a builtin from SWFs before the version
that introduced it). Lookups take the calling SWF's case sensitivity, so
a SWF 6 and a SWF 7 that share an object each find names as their version
does: a SWF from 7 asks the `Map` for the exact name and nothing else; a
SWF up to 6 asks for the exact name first, as code mostly spells a name
one way, then the name folded to lower case, and on a miss an index of
the names that folding changes (`Beta`, not `alpha`), which the object
builds the first time such a lookup misses and keeps up to date from then
on, so an object only SWF 7 code touches never has one, and one whose
names are all lower case has none. Folding is Flash's lower case, code
unit by code unit (`lowercase.ts`), cached by name: not JavaScript's, as
adl folds `İ` to `i` and `Σ` to `σ` alone, and leaves `ẞ`, Cherokee,
Glagolitic and the later Latin letters as they are; adl's names fold as
its `String.toLowerCase` does, which gave the table. Where two spellings
of a name exist (set by SWF 7 code), a SWF 6 finds the exact one, else
the lower-case one, else the first added. Within
one SWF, an object made by a SWF 6 and read by a SWF 7 behaves so by
construction; adl's harness runs one SWF, so that is not checked against
it yet (step 15 brings `loadMovie`).

`__proto__` is a property like any other (it can be listed, flagged and
set), which the object also keeps at hand for the walks up its chain. A
walk takes `__proto__` only where its version sees it: a function's
`__proto__` has the bit that hides it from SWF 5, so a SWF 5 finds nothing
on a function's prototype, not even `toString` (adl: `Object.toString()`
is undefined in a SWF 5, and `trace(Object)` writes `[type Function]`). A
walk stops after 255 prototypes, as Ruffle's does.

`get` (GetMember, a variable's value) takes the first property the
version sees along the chain, calling its getter with the receiver as
`this`; where none has it, the first `__resolve` on the chain that holds
an object is called with the name (a primitive one is skipped, an object
that is no function gives undefined), whatever version bits it has. Until some object has had a
property named `__resolve`, a miss skips that second walk. `set` calls the
object's watcher of the name first, whose result is the value set; then a
property of the object's own takes it (its setter called, the value kept
unless read only, and a set over a hidden builtin clearing its version
bits), else the first getter on the prototypes takes it through its
setter, or ignores it without one, else the object gets a new property.
A primitive's members are its class's: `"abc".length` and up to SWF 6
`constructor` are the box's own, the rest is looked up from the class's
`prototype` with the primitive as `this`, without making the box, as long
as `_global`'s `String`, `Number` or `Boolean` is the builtin; one a SWF
replaced boxes it as Flash does, by constructing it. A set on a primitive
sets on a box made for it, which is then lost; `undefined` and `null`
have no members. A native function's `this` is boxed as Flash boxes it.

`for..in` (`Enumerate`, `Enumerate2`) pushes `undefined`, as adl and
Ruffle do (not the specification's null), then the names, so that the
first to visit is on top: a prototype's names first, the deepest
prototype's first, then the object's own, the last added first, a name
deleted and set again last added; DontEnum ones left out. A prototype's
name is left out where the object lists the same name itself, but not
where the object's own is DontEnum (adl lists `constructor` from an
`Object.prototype` whose flags were cleared, though `{}` has its own,
DontEnum; Ruffle leaves it out). An array's indices come as `2 1 0`, and
`{10: 1, 2: 2, 1: 3}` as `10 2 1`, insertion order reversed, numbers or
not.

What adl showed of the rest (the `avm1-objects-swf5` to `-swf10` cases),
where it is not what Ruffle does:

- `ASSetPropFlags(o, names, set, clear)` finds the names whatever their
  case, in every version; the names are a string split at commas, or what
  an array converts to, and null is every property, `__proto__` and
  `constructor` included. The version bits hide a property as Ruffle's
  masks have it: 0x80 from SWF 5, 0x100 from SWF 6 alone, 0x400 from 5
  and 6, 0x1000 up to 7, 0x2000 up to 8, 0x4000 up to 9; 0x200 and 0x8000
  hide nothing. `set` and `clear` are ints whose low 16 bits are taken
  (65537 is 1, -1 is 0xffff, NaN 0). A set shows the property again, but a SWF 6's set leaves
  0x400, so the property stays hidden from it. `hasOwnProperty` is false
  for a property with 0x100, in every version. Bit 0x800 hangs adl's
  script; `ASSetPropFlags` on an array, by name or with null, empties it
  (its length 0): neither is reproduced. Nor is what version bits on
  `__proto__` do to the walk up it, which adl has its own way: a SWF 5
  stops at any bit that hides from it, a SWF 6 only at 0x400, a later
  SWF at none, though `o.__proto__` itself is hidden as any property is
  (adl hangs on a cycle of prototypes, where swf2es stops after 255).
- `addProperty` takes a function as getter and a function or null as
  setter (null: read only), and gives false for anything else, an object
  that is no function included (Ruffle takes any object). The property is
  listed by `for..in` and is `hasOwnProperty`'s, and on an array an index's
  property lengthens it as its element would.
- `watch(name, callback, data)` is false without a function callback; a
  second `watch` of the name replaces the first; `unwatch` is true where
  there was one, the name found by the version's case. The callback gets
  the name (the property's own spelling where it has one, as a SWF 6
  sets `FOO` over `foo`), the old value (the stored one, no getter called), the new
  one and the data, with the object as `this`.
- InitObject's object has its own `constructor` (`_global.Object`, don't
  enum and don't delete) before its `__proto__`, in every version; `new`
  gives `__proto__`, then `constructor` up to SWF 6, then
  `__constructor__`, both deletable (Ruffle: none on InitObject's, and
  `__constructor__` first). InitObject's and InitArray's count is
  truncated, then taken where it is from 0 to 2^31 - 1: -0.5 makes an
  empty one, NaN, -1 and 2^31 undefined, popping nothing; 1.7 pairs are 1.
- A set of an index past an array's `length` grows it: up to SWF 6 a
  name's leading spaces, sign and digits are its index whatever follows
  (`3abc` is 3, `1.9` is 1), from SWF 7 only alone; the digits wrap to 32
  bits (`4294967298` is 2). Up to SWF 6, `LENGTH` is `length`, and a
  `__PROTO__` set on an object without `__proto__` is its prototype.
- `NaN` and `Infinity` are getters on `_global` that give undefined to a
  SWF 4, so its `x == NaN` is `x == 0`; Flash's own globals leave a
  variable `o`, null.

A getter, a setter, a watcher or `__resolve` is a native or a function
of the SWF's, called with the depth a method call has (a getter's and a
setter's `super` is their object's prototype's), each under the property
recursion limit (see "Functions and registers"). The natives so far are `Object` and `Object.prototype`'s methods, `ASSetPropFlags`,
`Function.prototype`'s `call` and `apply`, `Array` and `String` (see
"Array and String"), `Error` as `Throw`'s values need it, and what
boxing and the conversions need of `Function`, `Number` and `Boolean`
(their constructors, `valueOf` and `toString`), which step 9 completes. `CallFunction`,
`CallMethod`, `NewObject` and `NewMethod` call them; a name that holds no
function gives undefined, as in Flash.

Performance: a property read is a `Map` lookup per prototype walked, with
no allocation for an object or a primitive; a SWF up to 6 pays a second
lookup only on a miss of the exact spelling. Measured in node, a read of
an own property takes about 5 to 7 ns, one of `Object.prototype`'s
methods 12 ns (22 in a SWF 6, which folds the name), a miss 12 to 21 ns,
a root variable 11 to 16 ns and a global one 28 to 38 ns. Inline caches at the GetMember and GetVariable sites, as
AVM2's untyped lookups have, are left for later: AVM1 objects have no
shapes to key a cache on, so a site's cache would hold an object and a
property and need invalidating as properties are added and deleted along
chains; they come with the measurements on the corpus's heaviest SWFs
the plan's end names.

A function is an `Avm1Function`: a native one's code is TypeScript, and a
`ScriptFunction` (`functions.ts`) has its region, the scope chain and
constant pool it captured, and a `prototype` of its own, an object whose
`constructor` it is. `new` makes an object whose `__proto__` is the
constructor's `prototype`, then calls it; AS2's classes, which the AS2
compiler turns into prototypes, `Extends`, `ImplementsOp` and `CastOp`,
need nothing more.

### Scopes, targets and names

An activation's scope chain is a list, searched from the top: a frame's
or an event's block has the clip it belongs to above `_global`; a
function has its own activation object above the chain it captured; a
`With`, or a catch into a variable, puts its object above either. The activation also has a
**target**, the clip that timeline actions (`Play`, `GotoFrame`,
`GetProperty` with an empty path) act on and names without a path
resolve in. It starts as the clip the code belongs to, `SetTarget` and
`SetTarget2` (`tellTarget`) change it, and a `SetTarget` of `""` gives
back the original, which the activation keeps for that.

`GetVariable`, `SetVariable`, `GetProperty`, `SetProperty`, `CallFunction`
and `eval` take names that may be paths: `/a/b:x` (slash syntax, SWF 4),
`_root.a.b.x`, `_level1.a`, `../x`, `_parent._parent.x`, or `this.x`
(`scope.ts`, as Ruffle's `get_variable`, `set_variable` and
`resolve_target_path`). A name with a `:`, or a `.` from SWF 5, is a path
and a variable after its last one; the path is resolved from each scope in
turn, top down, and the variable read where the first object it reaches
has it (GetVariable) or set on the first object it reaches (SetVariable).
A path's steps are a clip's children by name or else properties, `..` a
clip's parent, a leading `/` the root, and `this`, `_root` and `_levelN`
at its start; what needs the display list the host gives (`root`,
`level`, `parent`, `child` in `host.ts`), which step 10 fills in, so for
now a path walks objects' properties, `this` and the root. A name with a
`/` and no variable, from SWF 5, is the object the path names. A name
without a path walks the scope chain, top down, and is read from the
first scope object that has it on its chain; a name none has is `_root`,
`_parent`, `_global` (from SWF 6) or `_levelN`, else undefined: a
variable is never resolved by `__resolve`. `this` is the activation's
`this`, case-insensitively in SWF 5 and 6, in a function too (adl; Ruffle
has it case-sensitive in a SWF 5 function), and
so is a path's first step (with `_root`, and `_global` from SWF 6),
though a SetVariable path takes no `this`: adl sets nothing for
`this.x`. adl keeps a frame's `this` as a variable that `Delete2` can
remove, after which a SetVariable of `this` makes a property of the clip;
that is not reproduced. A slash path without a variable (`/a/b`) names a
clip in adl, never another object, which waits for step 10. A
variable set without a path goes where the chain has it, else on the
target's clip; `DefineLocal` and `DefineLocal2` define it on the top
scope, which at a frame's level is the clip. A clip's properties
`_x` to `_ymouse` are also reachable by index (`GetProperty` and
`SetProperty`'s 0 to 21), from a table shared with `globals/MovieClip.ts`.

Until step 10 gives clips their class, the player gives the root a plain
object for its AVM1 face, which holds the timeline's variables: `this`
and `_root` are it, and what tells a clip from an object (`typeof` is
`movieclip`, it converts to its path, compares as no number) is not there
yet.

### Builtins

The language's classes are the runtime's, written in TypeScript as
AVM2's natives are: `Object` (but `registerClass`, which binds a symbol
and is the player's), `Function`, `Array`,
`String`, `Number`, `Boolean`, `Math`, `Date`, `Error`, `AsBroadcaster`,
and the global functions (`parseInt`, `parseFloat`, `isNaN`, `escape`,
`ASSetPropFlags`, `setInterval` through the host's clock). Each is
installed on `_global` with the version flags Flash gives it, so a SWF 5
does not see what SWF 6 added. They are in `runtime/src/avm1/globals/`, a
file per class (`array.ts`, `string.ts`...), each under Ruffle's header
where it translates Ruffle's; a class's properties are defined in the
order adl lists them once `ASSetPropFlags` shows them all (a prototype's
`constructor` before its `__proto__`).

### Array and String

An array keeps its elements apart from its other properties while it is
dense, each of 0 to n - 1 there: `Avm1Object.elems`, by index, a
`Property` each, so that `a[i]` with a number (GetMember and SetMember's
fast paths), `push`, `join` and the other methods need no name and no
`Map`. Its first hole, an element deleted from the middle or set past the
end, moves them into the `Map`. Each property has the sequence number of
its adding, which for..in lists them by, elements among the rest: adl
lists an array's names in the order they were set, and its methods set
elements again in their own orders.

Array's methods read and write an object's own elements as adl does
(the `avm1-array-swf*` cases trace what follows at SWF 5, 6, 7, 8 and 10):

- A read takes the element's stored value: no getter is called, nothing
  is inherited (`Array.prototype[0]` is not an array's), a hole is
  undefined; `length` is the own `length` as an int, whatever the object.
- A write tells the element's watcher, and before it an array's
  `length`'s watcher where it grows, then stores the value unless the
  element is read-only; no setter is called (Ruffle calls no watcher).
  Most writes delete the element first, so it comes last in for..in's
  order and loses its attributes, unless it cannot be deleted: `reverse`
  sets each pair in turn, `shift` each element down then `length`,
  `sort` only the elements that moved; `splice` sets `length` to 0, which
  deletes all, then sets every element again (Ruffle moves only those
  past the cut); `unshift` sets `length`, moves the elements up from the
  last, sets the first ones undefined, sets `length` again and then the
  new ones, and does nothing with nothing to add; `push` sets each new
  element, an array's `length` growing with it; `pop` deletes the last
  and sets `length`. adl's `shift` and `unshift` tell no watcher of an
  element but the first's once an array has five elements, or four
  after `sort` moved some: that is not reproduced.
- `length`'s watcher is told of each of these sets of it, and of an
  element set past the end (before the element's watcher), but what it
  gives is not kept, an array's or not: the methods keep their number.
- A `length` set shorter deletes the elements past it, but those that
  cannot be deleted, and only if the old `length` is a number; set
  longer it makes no elements; it is stored as given (`"3"` stays a
  string, `1.9` a fraction). Under a watcher, adl sets an array's
  `length` twice, as the array and then as the set: the watcher is told
  of both, the elements are cut to the length set, and what the second
  call gives is stored. An element set at 2^31 - 1 wraps it to -2^31,
  which deletes them all.
- `join`'s separator converts as the version converts it (`undefined` is
  `""` to a SWF 6 and `"undefined"` to a 7); `splice` gives undefined for
  no start, an undefined count or a negative one.
- `sort` and `sortOn` sort as Flash's quicksort does, as Ruffle has it
  (the leftmost element the pivot), which a comparator that traces its
  calls shows; an object that is no function sorts by the default order
  (Ruffle compares nothing then). `sortOn` reads its fields as own stored
  values.

What a non-array object's watchers see of Array's methods called on it
(`Array.prototype.push.call(o)`) is left as Ruffle has it: adl's order
there is its own.

String's methods take `this` unboxed, so a string's method call makes no
String object (`Avm1Function`'s `raw`). Up to SWF 5 a string is its
bytes: the methods count and cut bytes, the case mappings map a byte only
to a byte, `fromCharCode` writes a code past 0xFF as two bytes,
`charCodeAt` past the end is 0, and `split` splits only at one character:
at a comma by default, an empty or longer delimiter leaving the string
whole, an empty one whatever the limit (Ruffle: an empty one is a comma
too). From SWF 6, `split` without a delimiter gives the string whole
whatever its limit, and so does an empty string by any but `""`.
`substring` from the end on is `""`, whatever its end (Ruffle swaps the
two first: `"abcdef".substring(10, 2)` is `cdef`). From SWF 6 the methods cut
UTF-16 code units, keeping half a surrogate pair as it is, so the halves
joined again are the pair (adl; StringExtract's halves are U+FFFD each).
Flash's log writes half a pair as U+FFFD, which `trace` does; adl writes
a low half followed by more as three. `toUpperCase` and `toLowerCase` are
Flash's own tables (`case.ts`, measured in adl over every code unit), one
code unit to one. `String.prototype.valueOf` of anything that is no
String gives it as a string, by its `toString` (Ruffle: undefined),
`toString` undefined.

## The player

### Hosting AVM1 objects

The player keeps one object with two faces, the player's `DisplayObject`
and its AS3 object (`object`). An AVM1 movie's display objects have a
third: `avm1`, the AS2 object a script sees, made as the clip is placed,
a `MovieClip`, `Button` or `TextField` of `player/src/avm1/globals`, whose
natives read and write the display object as playerglobal's do. Nothing in
`display/` or `render/` changes for it: the display list, the timeline,
text layout and drawing are the same for both VMs.

AVM1 references to clips are by path in Flash: a variable holding a clip
finds the clip that has its path now, if the one it was taken from was
removed and another placed by the same name. The AS2 object of a clip
keeps its display object and, once that is removed, resolves its path
again on its next use, as Ruffle's `MovieClipReference` does.

A text field with a variable name (DefineEditText's `VariableName`)
shows a variable on the clip its path names, and a change to either
updates the other; the player keeps the binding on the field, and the
runtime tells the player when a variable it binds is set.

### The frame

`Avm1` (`player/src/avm1/avm1.ts`) holds a player's AVM1: the modules of
each AVM1 SWF loaded, the action queue and the global registers. The
`Player` takes it beside, or in place of, `Scripting`, and the input
(pointer and keyboard) report to whichever VM a display object belongs to.
An AVM1 main SWF needs no AS3 runtime and no playerglobal.

The order of a frame is Flash's, as Ruffle has it (`Avm1::run_frame`,
`MovieClip::run_frame_avm1`, `ActionQueue`) and the corpus checks it, which
is not AS3's: AVM1 clips run in the reverse of the order they were made,
the newest first, each dispatching `load` on its first frame and
`enterFrame` after, then running its timeline's tags, which queue its
DoAction blocks (a DoInitAction runs at once). Then the queue runs in
three passes: initialisation (`onClipEvent(initialize)`), construction (a
registered class's constructor, then `construct`), then the rest, frame
actions and events in the order queued, skipping what belongs to a clip
removed meanwhile but its `unload`. A goto from the queue queues the frames
it enters. Intervals run by the clock between frames, as AS3's timers do.
The player keeps AVM1's execution list beside the display list, as its
clips are made and removed, not by walking the tree each frame.

Step 4 runs the root's frames only, and without the queue: the `Player`
takes an `Avm1` beside its `Scripting` (null for an AVM1 SWF), which
`start` has compile the SWF's blocks into one module and run the first
frame's actions, and each tick after the clips advance runs those of the
frame the root entered, if it entered one: a stopped root, or one of one
frame, runs nothing again. A frame runs its DoInitAction blocks first, each
sprite's once, in tag order, then its DoAction blocks in tag order; empty
blocks are skipped. Every activation of the frame shares the operand
stack, which the frame starts empty, and the DoAction blocks the constant
pool, each starting with the one the block before left; a DoInitAction's
pool is its own. The `avm1-hello` case has adl agree on each: an init
whose tag comes after the frame's DoActions runs first, a value one block
pushes the next pops, and the next frame's `trace` of the empty stack
writes `undefined`. A root frame holding a tag in `corrupt` stops the
SWF where the tag's first event comes (above): before the frame's actions
for `load` and `initialize`, after its DoInitActions for `construct`, as
the next frame comes for `enterFrame`, whether the root moves on or not;
those of other events wait for the steps that bring them (an `unload` as
the clip is removed, step 11), and a sprite's for clips' frames. A stopped
SWF, there or by `V.halt`, advances no timeline and runs no action again.

An AVM1 timeline has as many frames as its ShowFrame tags end, whatever
its header says: Flash plays and loops one so (the corpus's
`looping_real_1_declared_2` and `looping_real_2_declared_1`, as Ruffle's
`determine_next_frame` has it), where an AS3 timeline has its header's
count. What follows the last ShowFrame is no frame of its own: in adl its
DoActions run with the last frame, after its others (late enough that the
harness's last frame ends first), and its places place nothing. A root
without an End tag stays on its last frame rather than loop, as Ruffle
has it too; adl agrees, for a SWF loaded as an `AVM1Movie` as for a main
one (adl's harness loads them all so).

### Clip events and buttons

A place's clip actions are registered on the clip it places, by event:
`load`, `enterFrame`, `unload`, `mouseMove`, `mouseDown`, `mouseUp`,
`keyDown`, `keyUp`, `keyPress` with its key, `data`, `initialize`,
`construct`, and the button-like `press`, `release`, `releaseOutside`,
`rollOver`, `rollOut`, `dragOver`, `dragOut`. Each runs its block with
the clip as target and `this`, and the handler functions of the same names
(`onLoad`, `onEnterFrame`, `onPress`...) run after it. A clip with a
button event, or with a handler such as `onPress` set, is a button to the
pointer: it takes the hand cursor and the pointer's hits, as a
SimpleButton does in AS3.

A button's condition blocks run on the state change their flags name
(idle to over down, over down to over up...) or on their key, with the
button's parent as target, as Flash runs them. The player's buttons
already change state and play their sounds for AS3; for AVM1 the pointer
gives them the same transitions.

### AVM1 and AVM2

Two VMs meet in three places, each its own step in the plan:

- **An AVM1 SWF loaded by AS3**: the `AVM1Movie` the player already makes
  runs its actions; its `_root` and `_level0` are the movie's root, and it
  shares the player's AVM1 with any other.
- **`LocalConnection`** between an AS2 and an AS3 SWF, the way Flash's
  content talks across VMs: messages are copied as AMF0 values, which the
  runtime's AMF code reads and writes.
- **`AVM1Movie.call` and `addCallback`**, which throw #2014 today, once
  both VMs run; the corpus's `avm2/avm1movie_addcallback_call` shows what
  Flash copies across.

An AS3 SWF loaded by AS2 (`loadMovie`, the corpus's
`mixed_avm/avm1_loads_avm2*`) comes after the steps here.

### Out of scope at first

The first steps leave out: `loadMovie` into levels other than 0, `print`,
`fscommand` beyond ExternalInterface's, `NetStream` and video, the
context menu, `TextSnapshot`, `CloneSprite` of a sprite with clip events
(it clones without them, as a first approach), the 15-second script
timeout (a block that loops forever hangs the page; the corpus runner
stops one at its test's timeout), and structured output and stack
registers in the compiler.

## Testing against Flash

- **Ruffle's corpus**: `avm1/` has 715 tests at the pinned commit, every
  one with Flash's `output.txt`; 649 pass the collector's filters (no
  input, audio, video or default font), 41 of those Ruffle's own known
  failures. Most were built by Flash's authoring tool, a `.fla` beside
  them, at versions 4 to 10, AVM1 as content has it; some 250 are version
  15, built by other compilers. `pnpm corpus` runs them
  as it runs `avm2/` and `timeline/` (`run.ts` takes `avm1/` among its
  default prefixes), in Chrome, the trace compared line by line, each
  test's standing in `baseline.json`, which a change may not lower; the
  first baseline, step 4's, has 10 of the 649 passing (`looping*`,
  `single_frame`, `trace`, and three whose traces need no action run), most
  stopping at their first action not done yet. `mixed_avm/` (12 tests, AS3
  loading AS2 and the reverse) and `from_gnash/` (404) join later. The tests with `[approximations]` (16) compare numbers within
  their tolerance once the runner reads it.
- **adl**: the harness loads a SWF with a `Loader`, so an AVM1 SWF runs
  as an `AVM1Movie`, and adl prints its AVM1 traces with AS3's: the
  corpus's `looping_real_1_declared_1`, `undefined_to_string_swf6` and
  `call_method_empty_name` trace their `output.txt` exactly under adl,
  given two frames at least: adl prints nothing of the movie's first frame
  until its second, which prints both frames' traces, and from there a
  frame each, so a test of one frame takes two and one of more frames its
  own count (`check-references.ts`, and `run.ts --update` for a case). A player
  case of its own (`tests/player/cases.ts`) is an AVM1 SWF the test
  assembles from actions, through a small assembler in the tests
  (`tests/avm1-assembler.ts`), traced and drawn by adl with `--update`;
  the classes' cases are AS1 source (`tests/player/avm1/*.as`), which a
  small compiler in the tests (`tests/avm1-script.ts`) turns into the
  actions Flash's own compiler writes for it, in its shape: a constant
  pool, batched pushes, and from SWF 7 DefineFunction2 with what it
  preloads and its variables in registers (each case traces the same
  in adl and the player as one push per value and DefineFunction gave).
  The cases of the earlier steps stay assembled by hand, so that the
  actions no compiler writes stay covered.
  What only a main AVM1 SWF shows, `_level0` as the root of the stage or
  `Stage.width`, comes from the corpus, as adl cannot run one as the main
  movie.
- **Conformance**: semantics with no display, conversions, operators,
  objects, Array and String, get unit tests in node with the expected
  output taken from Flash, as a corpus test or an adl case traces it;
  avmshell runs no AVM1.
- **The compiler**: the decoder and the emitter are fuzzed as the ABC
  parser is (`tests/fuzz/avm1.ts`: mutated action blocks never trap,
  their modules import as ES modules, each block alone is its entry);
  `tests/unit/codegen/avm1-emit.test.ts` runs modules of assembled blocks
  with a stub runtime that records its calls; and `pnpm determinism`
  (`tests/conformance/determinism-avm1.ts`) compiles the tests'
  assembled blocks, and the corpus's AVM1 SWFs where it is fetched (it is
  not in CI), in each of its orders and every build, each block alone and
  in its module.

## Code taken from other implementations

Where a file takes code from another implementation it keeps that code's
licence and copyright header at its top, as
`as3/playerglobal/src/flash/net/XMLSocket.as` does, and the file says what
it took. Nothing of avmplus goes into an Apache-2.0 file; avmplus has no
AVM1, so nothing is expected from it.

- **Ruffle** (`core/src/avm1/`, `swf/src/avm1/`; MIT or Apache-2.0): the
  primary reference for what each action and builtin does by version:
  `value.rs`'s conversions and `f64_to_string`, `activation.rs`'s actions,
  `resolve_target_path` and the scope rules, `function.rs`'s preloads,
  `property_map.rs`, `globals/`'s classes, the event and queue order in
  `frame_lifecycle.rs`. Its code is Rust, so what swf2es takes is the
  algorithm and its tables, translated, under its header.
  Some of its globals are AS1 source (`globals.as`, `AsBroadcaster.as`,
  `Error.as`, `flash/geom`'s `Point`, `Matrix` and `Rectangle`), compiled
  into its build; swf2es has no AS1 compiler, so it writes those in
  TypeScript.
- **AwayFL** (`@awayfl/avm1`; Apache-2.0, much of it Shumway's, Copyright
  Mozilla Foundation): TypeScript to start from where it is not bound to
  its interpreter or its scene graph: the conversions in `runtime.ts`,
  `AVM1Object`'s property bag, `natives.ts`'s builtins, the geometry
  classes, `XML` and `LoadVars`, and the clip event table of
  `AVM1EventHandler.ts`. Its interpreter, its path resolution and its
  display classes carry fixes for particular content and are not taken; a
  file taking from it keeps Mozilla's header and adds AwayFL's notice.
- **Flash Player**, through the corpus and adl, decides where they differ.

## Open questions

- **Writing AVM1 test cases.** The tests assemble actions
  (`tests/avm1-assembler.ts`), or compile a subset of AS1
  (`tests/avm1-script.ts`: no classes, `with`, `try` or `tellTarget`);
  an AS2 compiler in the oracle's image (MTASC, or Ruffle's test
  compiler) would take AS2's classes too.
- **A main AVM1 SWF without `Scripting`.** The pointer and keyboard take
  `Scripting` today. Either they report through an interface both VMs
  implement (the plan), or an AVM1 SWF gets a `Scripting` with
  playerglobal loaded, simpler but a cost for every AVM1 SWF.
- **Ruffle's AS1 globals.** Written in TypeScript here; or swf2es could
  compile them from AS1 once it has an assembler or a compiler for them.
- **`from_gnash/`** in the corpus baseline: 404 more tests with Flash's
  output, Gnash's test suite for each class at SWF 5 to 8 (`Math-v5` to
  `Math-v8`...), many of them Ruffle's known failures. They suit the
  class steps from 9 on; whether they join the baseline then or from the
  start is open.

## The plan

Each step is one pull request the user reviews and merges. Every step
keeps `pnpm check`, `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm
determinism` green, and the corpus baseline may only go up.

1. **Action blocks in `format`.** `format/src/actions.ts` lists a SWF's
   blocks (DoAction, DoInitAction, clip actions split into their records,
   button actions and conditions) as `ActionBlock`s with their owners;
   `display.ts` and `button.ts` record the indices of theirs. Unit tests
   on hand-built tags, including SWF 5's 16-bit event flags. No behaviour
   changes.
2. **The decoder.** `codegen/assembly/avm1/actions/`: opcodes, operands,
   `Push`'s value types, jumps into an action's middle, truncated input;
   `avm1/flow/`: regions and blocks. Exposed in the test build, and fuzzed
   (`tests/fuzz/avm1.ts`). Moves `Output` beside `avm2/` for both.
3. **Emitting a block.** `codegen/assembly/avm1/emit/` for `Push` of
   constants, `ConstantPool`, `Trace`, `Pop`, `Jump`, `If`, `Play`,
   `Stop`, `End`, every other action a call that throws "not yet";
   `Codegen.compileActions`, the module's key, and `swf2es file.swf`
   writing an AVM1 SWF's module in place of refusing it. A node unit test
   runs modules with a stub runtime that records its calls; `pnpm
   determinism` compiles the tests' assembled blocks, and the corpus's
   AVM1 SWFs where it is fetched, each block alone and in its module.
   Built: `swf2es compile` writes `avm1.js` and a manifest whose `avm1`
   entry names it, its key and length, which step 17 reads; the
   assembler is `tests/avm1-assembler.ts`, for the player's cases too.
4. **Hello world.** `runtime/src/avm1` with values, `rt.version`,
   `toString` and `toBoolean`; `player/src/avm1/avm1.ts` running a main
   AVM1 SWF's frame blocks in order, never an ActionScript 3 SWF's; the web element and the corpus page
   giving an AVM1 SWF codegen. `pnpm corpus` takes `avm1/` among its
   default prefixes and records every AVM1 test's standing, and
   `check-references.ts` gives an AVM1 SWF two frames at least. Passes the
   corpus's `looping_real_1_declared_*`, a constant traced from a frame
   script. Verified: the corpus, and an adl case of a trace in each of two
   frames and a `stop`, assembled by `tests/avm1-assembler.ts`.
   Built: the root's frames only (see "The frame"), DoInitAction before
   the frame's DoActions as adl orders them, and AVM1 timelines counting
   their ShowFrame tags, which also passes `looping_real_2_declared_*` and
   two of `timeline/`; 10 of the 649 `avm1/` tests pass. `numbers.ts`'s
   number formatting and string-to-number came with it, `trace` needing
   the one and `toBoolean` the other; step 5 adds the rest of the
   conversions. The `avm1-hello` case traces a frame's blocks sharing the
   stack and the pool, an init first, AVM1's number formats and the
   empty stack of the next frame, as adl does.
5. **Arithmetic, comparison and strings, by version.** `Add`, `Add2`,
   `Equals`, `Equals2`, `StrictEquals`, `Less`, `Less2`, `Greater`, the
   bitwise and string actions, `ToNumber`, `ToString`, `TypeOf`;
   `numbers.ts`'s number formatting and string-to-number, each per
   version. Passes `add`, `add2`, `add_swf4`, `add_swf5`, `swf4_bool`,
   `swf4_actions_bool`, `equals*`, `lessthan*` and `undefined_to_string_swf6`;
   unit tests per version from their traces, `f64_to_string`'s cases among
   them.
   Built: also `Subtract`, `Multiply`, `Divide`, `Modulo`, `And`, `Or`,
   `Not`, `Increment`, `Decrement`, `ToInteger`, the char actions,
   `PushDuplicate` and `StackSwap`; an object's conversions are hooks steps
   6 and 9 fill (see "Values"). The `avm1-operators-swf4` to `-swf10`
   cases trace some 2000 results each in adl, at SWF 4, 5, 6, 7, 8 and 10,
   which the player matches line for line; what adl showed is under
   "Version-dependent semantics". The corpus's tests named above also set
   variables or define functions, so they pass with steps 6 and 7:
   `swf6_string_as_bool` passes (11 of the 649), and `action_to_integer`,
   `divide_swf4`, `logical_ops_swf8`, `strictly_equals` and
   `undefined_to_string_swf6` match more of their lines, each up to an
   action of those steps.
6. **Variables, objects and the global object.** `Avm1Object` and its
   property map with case sensitivity by version, `GetVariable`,
   `SetVariable`, `DefineLocal`, `GetMember`, `SetMember`, `Delete`,
   `InitObject`, `InitArray`, `Enumerate`, `_global`, `Object`,
   `ASSetPropFlags`, `addProperty`, `watch` and `__resolve`. Passes
   `new_object_wrap`, `init_array_invalid`, `watch*`, `prototype*`.
   Built: also `DefineLocal2`, `Delete2`, `Enumerate2`, `hasOwnProperty`,
   `isPropertyEnumerable`, `isPrototypeOf`, paths of objects' properties,
   and `CallFunction`, `CallMethod`, `NewObject` and `NewMethod` of native
   functions, with what boxing, InitArray and the conversions need of
   `Function`, `Array`, `String`, `Number` and `Boolean` (see "Objects").
   The `avm1-objects-swf5` to `-swf10` cases trace some 200 lines each in
   adl, which the player matches. `watch*`, `prototype*` and most of the
   corpus's object tests define functions, so they wait for step 7: the
   corpus goes from 11 to 47 of the 649 (`new_object_wrap`,
   `init_array_invalid`, `init_object_invalid`, `delete`,
   `global_is_bare`, `has_own_property`, `as_set_prop_flags_version_*`,
   `equals_swf4`...), and DefineFunction, DefineFunction2 and StoreRegister
   are what most of the rest stop at.
7. **Functions.** `DefineFunction`, `DefineFunction2` with registers and
   preloads, `CallFunction`, `CallMethod`, `NewObject`, `NewMethod`,
   `Return`, `arguments`, `super`, `Function.call` and `apply`, recursion's
   limit, SWF 5's functions without closures. Passes `call_method_empty_name`,
   `define_function_case_sensitive`, `define_function2*`, `define_local*`,
   `register_underflow`, `register_globals_across_frames`, `this_swf5` to
   `this_swf7`; determinism of function entries compiled alone.
   Built: also `StoreRegister`, the global registers by frame, the
   property recursion limit by version, `Function()`, and `ScriptLimits`'
   depth; what adl showed is under "Functions and registers". The
   `avm1-functions-swf5` to `-swf10` cases trace some 1100 lines each in
   adl, which the player matches, `avm1-recursion` shows a
   `ScriptLimits` depth disabling the actions while the timeline plays on,
   and `avm1-script-limits` when a frame's `ScriptLimits` takes effect.
   The corpus goes from 47 to 104 of the 649 (`call_method_empty_name`,
   `define_function2`, `define_function_case_sensitive`,
   `register_underflow`, `function_as_function`, `timeline_function_def`,
   the `*_recursion*` tests but `watch_recursion_swf6`, and many of steps
   5 and 6 that define functions). The rest stop mostly at `GetUrl` and
   `GetUrl2` (54), `Extends` (21), `Try` (20), the clip actions of step 10
   (`GotoFrame`, `GetProperty`, `SetProperty`, `SetTarget2`), `With` and
   `InstanceOf`; `this_swf*` and `define_local*` need clips, and
   `register_globals_across_frames` traces every line, then stops at a
   `GetUrl`. 21 tests loop forever
   without Array's methods (step 9), where Flash's script timeout would
   stop them: the corpus runner stops a test's script at its timeout.
8. **`With`, `Try` and `Throw`.** Regions entered and left as Flash runs
   them, `Error`. Passes `with`, `with_return`, `with_variable_scopes`,
   `try_catch_finally`, `try_catch_stack`, `try_finally_simple`; an adl
   case for a jump out of a `with` body and back before its start.
   Built: With and Try bodies as ranges of a region's blocks, held on the
   activation (`control.ts`), not regions; the limit of 15 scopes; the
   scope over the first action past its body; a catch's variable as its body's own scope; the
   finally after a throw or a Return; `Error` as far as `Throw` needs it.
   What adl showed is under "With and Try". The `avm1-control-swf5` to
   `-swf10` cases trace some 190 lines each in adl, which the player
   matches. The corpus goes from 104 to 111 of the 649 (`with_return`,
   `with_variable_scopes`, `try_finally_simple`,
   `catch_references_registers`, `error`, `watch`,
   `infinite_recursion_function`); `with` waits for `GetProperty` (step
   10), `try_catch_finally` for `CastOp` (step 9), and `try_catch_stack`
   traces every line, then stops at a `GetUrl` (step 15).
9. **The language's classes.** `Array`, `String`, `Number`, `Boolean`,
   `Math`, `Date`, `AsBroadcaster`, `Extends`, `InstanceOf`, `CastOp`,
   `ImplementsOp`, the global functions. Corpus tests of each; the
   largest step, and may split by class.
   Built in three: 9a `Array` and `String` (see "Array and String"),
   with arrays' dense elements, and `tests/avm1-script.ts`, a small
   compiler of AS1 source to actions for the cases, whose
   `avm1-array-swf*` and `avm1-string-swf*` trace some 300 and 55 lines
   each in adl, which the player matches. The 21 tests that looped
   forever without Array's methods finish, and the corpus goes from 104
   to 112 of the 649; most of the rest of those reach `InstanceOf` (28),
   `Extends` (21) and `GetUrl` (34).
10. **Clips and paths.** `MovieClip`'s AS2 face, targets, `SetTarget`,
    `SetTarget2`, path resolution (slash, dot, `_root`, `_levelN`,
    `_parent`), `GetProperty` and `SetProperty` by index, `eval`, timeline
    actions (`GotoFrame`, `GotoLabel`, `GotoFrame2`, `NextFrame`,
    `PrevFrame`, `CallFrame`, `WaitForFrame`), clip references by path.
    Passes `target_*`, `tell_target*`, `this_scoping`, `goto*` (15) and
    `movieclip*` that need no events; adl cases for gotos in the frame
    order.
11. **The frame: DoInitAction, clip events and the queue.** The action
    queue in Flash's order, `onClipEvent`, `on*` handlers, `onEnterFrame`,
    `#initclip`, `Object.registerClass`, `attachMovie`,
    `duplicateMovieClip`, `createEmptyMovieClip`, `removeMovieClip`,
    depths, and the SWF stopped at a tag in `ActionList.corrupt`. Passes
    `register_class*`, `register_and_init_order` and the corpus's
    event-order tests.
12. **Buttons, the pointer and the keyboard.** Button conditions, clips as
    buttons, `Key`, `Mouse`, `Selection`, `startDrag`, `hitTest`,
    `_droptarget`. Corpus tests that run without input, adl cases for
    the rest, as AS3's pointer cases do.
13. **Text.** `TextField` and `TextFormat`'s AS2 faces,
    `createTextField`, variable bindings, `htmlText`, `TextField.StyleSheet`.
    Corpus tests of text fields.
14. **Drawing, display and sound classes.** The drawing API, `Color`,
    `Transform`, `ColorTransform`, `Matrix`, `Point`, `Rectangle`,
    `BitmapData`, filters, `Stage`, `Sound`, timeline sounds that
    `stop()` now stops. Corpus tests and the visual tests' traces.
15. **Loading and I/O.** `loadMovie`, `loadVariables`, `MovieClipLoader`,
    `LoadVars`, `XML`, `XMLNode`, `SharedObject`, `XMLSocket`,
    `getURL`, `ExternalInterface`. Corpus tests of each.
16. **AVM1 in AS3.** An `AVM1Movie` runs its actions, `LocalConnection`
    across the VMs, `AVM1Movie.call` and `addCallback`; the `avm1-movie`
    case's AVM1 then traces, recorded again with adl. Passes
    `mixed_avm/avm2_loads_avm1*` and `avm2_doaction`, and
    `avm2/avm1movie_addcallback_call`.
17. **AVM1 modules cached and ahead of time in the player.** The
    IndexedDB module cache and precompiled modules (`player-hosts`) take
    AVM1 modules by their key, as `tests/player/module-cache.ts` and
    `precompiled.ts` check for ABCs.

After them: structured output and stack registers in the emitter, local
variables as `let`s, inline caches for names, each measured on the
corpus's heaviest SWFs and kept only for a gain that repeats.
