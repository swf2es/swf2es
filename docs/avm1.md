# AVM1

ActionScript 1 and 2 in swf2es: what AVM1 bytecode is compiled to,
where each piece lives, and how the runtime and the player run it. The
player passes 592 of the 715 `avm1/` tests of Ruffle's corpus
([coverage.md](coverage.md#ruffles-corpus)); what it leaves out is under
"Known gaps". [architecture.md](architecture.md) describes the rest of
the player.

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
imports it. `player/src/avm1/` mirrors `playerglobal/`: the frame's AVM1
work at its top, the AS2 classes the player provides in `globals/`, a
file per class.

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
as `ActionBlock`s: the bytes, what they belong to and their index, which
is how the player finds a block's compiled code. The list is a pure
function of the SWF's bytes, so the JIT and AOT modules agree on it. It
has the blocks of an ActionScript 3 SWF too, whose FileAttributes flag
says it runs none of them.

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
button, and whether those run there is not checked yet.

## Compiling

`Codegen.compileActions(bytes, actions)` compiles a SWF's whole list of
blocks to one ES module, which `swf2es compile` writes as `avm1.js`.
`compileActionBlocks` compiles blocks alone, each byte for byte its entry
in the module, which the player does as a block first runs
(`player/src/avm1/compile.ts`), so code for scenes never entered is never
generated or parsed. The SWF's version is an input, as the compiler
picks the version's operations, and part of the module's key
(`actionsKey`). A block's region array keeps its identity as its
placeholder is replaced, so defined functions and ExternalInterface
still know the code's SWF by it. AVM1 needs no domain: a block links to
nothing at compile time.

A block needs the whole SWF, which its backward jumps may reach, so the
wrapper copies a SWF into Wasm once and holds it (`actionsHold`) for the
four SWFs it compiled last: a copy for each block cost some 2 ms a block
for a SWF of 35 MB. It collects after each block, so the compiler's
memory is bounded by the block being compiled. In
`codegen/assembly/avm1/`, by stage:

- `actions/`: the decoder reads every action reachable from a block's
  start, following jumps, and decodes each offset once, so a jump into
  the middle of an action, as obfuscators write, decodes from there as
  Flash reads it. An unknown opcode is skipped, as adl does. An operand
  or a length past the block's end, and a `Push` of a value type Flash
  does not know, stop the whole SWF there, as adl does, even with the
  SWF's next tag behind it: the emitter writes `V.halt(cx)`, which the
  player takes as it takes `corrupt` (Flash Player 9 and Ruffle skip the
  unknown value type). Errors are sticky flags, never a trap.
- `flow/`: blocks and regions. A block starts at a jump's target, an
  `If`'s, a `WaitForFrame`'s skip, and after each. A **region** is code
  Flash runs as an activation of its own: a block's whole code, or a
  DefineFunction's body. Flash runs a region until its program counter
  leaves its end: a jump past the end, or the code running off it, leaves
  the region (for a function, returns), and a jump back before its start
  stays in it, running the bytes there, any earlier byte of the SWF (adl
  runs a function's body that jumps back before its `DefineFunction`, and
  Ruffle's `run_actions` over a subslice does the same). So an offset
  reached from two regions is in each, and a body that jumps back before
  its own `DefineFunction` defines itself again with the same region:
  regions form a graph, cycles included, and the emitter writes each
  once. A region is compiled within its **home**, the block's own bytes,
  and goes on in **units** (below) outside them. Where one `ConstantPool`
  reaches a `Push` on every path, its strings are literals, and a
  constant past the pool's end `undefined`, as Ruffle pushes it; where
  none or several may, the push reads the activation's pool at run time,
  `cx.pool[i]` (`flow/pool.ts`).

  `With` and `Try` bodies are not regions, though Ruffle runs them as
  activations: in adl their code runs in the activation that reached
  them, and the `With`'s scope or the `Try`'s handler holds while the
  program counter stays in their bytes. A jump out of a body, back before
  it or past its end, drops them, and a jump into one from outside finds
  none; code running off a try body runs the catch's bytes and the
  finally's after them, thrown or not, which is why compilers end a try
  body with a jump past its catch. So a body's bounds start blocks, where
  the emitter drops what is no longer held.
- `emit/`: a block as an array of its regions' functions, its own code
  first, then the bodies of the functions it defines; strings as
  JavaScript literals, read as adl reads them. Up to SWF 5 a string is
  its bytes, each the character of its value (0x80 is U+0080, not
  Windows-1252's euro, which Ruffle reads). From SWF 6 it is UTF-8 read
  leniently, as Unicode's old `ConvertUTF.c` sums a sequence: a lead byte
  takes the bytes its high bits ask for, continuation bytes or not, so
  overlong forms read and `C3 41` is U+0081; a byte that leads nothing is
  its own character; a surrogate or a code point past U+10FFFF is
  U+FFFD; and a code point of 0, or a sequence the string's end cuts
  short, ends the string there.

### Units

Obfuscators jump back into other tags' bytes: other frames' code, or
data that decodes as junk. Compiled into each block that reaches it,
that code made each a closure of most of the SWF before it: an
obfuscated real-world SWF of 2.2 MB of actions compiled to 128 MB of
JavaScript, a block of 3 KB to 1 MB. So where control leaves a region's
home while staying in the region, the region returns `V.far(cx, at, end,
bound, five)`: go on at offset `at` of the SWF in a region that ends at
`end`, whose actions' bytes end at `bound`, as a SWF 5's function if
`five`. V.far runs **units** until control leaves the region.

A unit is the code from `at` that it reaches within the bytes up to the
next bound of a block, at most 32 KB (`emit/units.ts`), compiled once for
the SWF rather than in every block that jumps there. It returns where
control goes on, an offset, or -1 where the region ends and -2 where it
returns, and V.far looks the next unit up, counting down the script
timeout's budget as a jump back does. A region keeps all it reaches
where a unit could not run its code as it runs: where control leaves the
home from a With's or a Try's bytes, while what they hold stays on the
activation, and in a DefineFunction2 with registers of its own, `let`s a
unit cannot see. What a unit compiles to depends on `end` and `bound`
only where it reaches them, so V.far first asks for the unit that ends
at the next bound of a block, which most regions can share. Units are
compiled on first use, byte for byte their entries in the module's
`units(rt)` export, and units whose code is the same are written once.

On the obfuscated SWF above, with the folding of pushes (below), the
module is 33 MB, of which the blocks' own code is 11.5 MB, its 3 KB block
16 KB; after a replay of its first minutes in Chrome, V8 holds 29 MB of
code rather than 132 MB, and the JS heap is 55 MB rather than 192 MB.

### The dispatcher

Each region is written in the dispatcher form the AVM2 emitter falls back
to, `let b = 0; for (;;) switch (b) { case 0: ...; b = 3; continue; }`, a
case per block, which handles any control flow compilers and obfuscators
write. A region of one block that nothing jumps back into is written
straight.

The operand stack is a JavaScript array, `cx.st`, whose `pop()` gives
`undefined` on an empty stack, as Flash's AVM1 does. In adl it is one
stack, not one an activation: what a frame's block leaves on it the next
block run in that frame pops, a DoInitAction's and a clip event's
included, and a function's body pops its caller's values below its own
and leaves what it does not pop under the value the call pushes. So
every activation of a frame's actions gets the same array, emptied
between frames. A stack's depth is not fixed at a merge (`Enumerate`
pushes as many names as an object has) and a region may pop below its
start, so there are no registers for stack slots, as AVM2's `s0`.

- **Jump** and **If**: `b = k; continue;`, and `if (V.toBoolean(st.pop()))`
  before it. A jump out of the region is the region's exit.
- **WaitForFrame** and **WaitForFrame2** ask the host whether the frame is
  loaded. The player has the whole SWF before it plays, so every frame
  is, but the branch stays for SWFs that test it.
- **With**: `V.with(cx, st.pop(), from, to)` puts the object on the
  activation's scope chain, held over the body's blocks, `from` to `to`.
  It gives false, and the code goes on past the body, for `undefined`
  and `null`, in adl as in Ruffle, and where the chain is full.
- **Try**: `V.try(cx, ...)` puts its handlers on the activation, held over
  the try and catch bodies' blocks. The loop of a region with a `Try`
  runs in a JavaScript `try`/`catch` whose catch asks `V.caught` which
  block to go on at, and sets the register a catch took the value into;
  so in such a region every block sets `b` as control falls into it. An
  error of the host's, a bug's, or the recursion limit's passes through
  every catch and finally.
- **Leaving a body**: a branch or a fall-through out of a try, catch or
  finally body goes through `b = V.leave(cx, k); continue;`, which takes
  off the Trys that do not hold over block `k`, and where a finally that
  a throw or a Return reached is left, throws or returns instead. A
  scope comes off one action late, as adl has it: a block that an edge
  out of a With's or a catch's body reaches calls `V.scopes(cx, k)` after
  its first action, before it where that action branches, ends the block
  or opens a body. A region without a `With` or a `Try` pays for neither.
- **Return** is `return st.pop();` in a function's region; in a frame's
  block it ends the block, the value popped all the same, and a region
  that runs off its end returns undefined. In a try or catch body with a
  finally it is `b = V.ret(cx); continue;`: the finally runs first, and
  the region returns the stack's top as control leaves it, through its
  dispatcher's case `-1`, `return cx.ret;`.

A module's default export, given the runtime, gives an entry per block,
in the order `readActions` lists them, each an array of its regions'
functions, which take the activation, `cx`: its scope chain, target,
`this`, constant pool, operand stack, registers and the SWF's host. An
action is a call of its version's operation with the values it pops,
the top first, `st.push(V.subtract(st.pop(), st.pop()));`, with the
activation where it needs it, `V.getMember(cx, ...)`, popping its
operands itself where their number is on the stack (`V.callMethod(cx)`);
`PushDuplicate` and `StackSwap` are inline. An unknown opcode is
skipped, an action Flash cannot read is `V.halt(cx)`, and a block the
flow finds too large `V.tooLarge()`. Where an action takes the value the
one before it pushed, nothing coming between them, the push and the pop
fold into the value itself, `V.trace(cx, "frame")`, evaluated where the
push was and popped first as the top is, so every call sees what it
would have; only the top folds.

### Version-dependent semantics

What an action does depends on the version of the SWF whose code runs it,
not the version of the objects it touches: `Add2` of `undefined` is `0` up
to SWF 6 and `NaN` from 7, `ToString(undefined)` is `""` up to 6 and
`"undefined"` from 7, names are case-insensitive up to 6, a string is
true by its number up to 6 and by its length from 7, a boolean is the
string `1` or `0` up to SWF 4, and a string is bytes up to SWF 5. So the
emitter picks the operations as it compiles: `rt.version(v)` gives a
table of them for versions like `v`, made once per version and shared,
so a call site sees one function, never a version test. The corpus's
version-specific quirks, each in Ruffle with a test, come with it:
SWF 4's `Divide` by zero pushes `"#ERROR#"`, `-0x10` is `NaN` while
`0x10` reads as hex from SWF 6, `>>>` is signed in SWF 8 and 9,
`SetTarget2(undefined)` resets the target differently up to SWF 6, and
`this` is case-insensitive up to SWF 5.

What adl traces of the operators at SWF 4, 5, 6, 7, 8 and 10 (the
`avm1-operators-swf*` player cases), where it is not what Ruffle does or
what the specification says:

- Every comparison and logical action pushes a boolean in every version,
  SWF 4's `Equals`, `Less`, `And`, `Or`, `Not` and `StringEquals` too (not
  the specification's 1 and 0); a SWF 4 traces it as `1` or `0`.
- Flash has a NaN equal to a copy of itself and to no other NaN, in
  `Equals2` and `StrictEquals`: the global `NaN` read twice is equal, but
  `0/0 == 0/0`, and two pushed NaNs, are not (its numbers are references
  to doubles, compared first by reference). SWF 4's `Equals` has none
  equal. A JavaScript number has no identity, so swf2es takes every NaN
  equal to every other there, as Ruffle does: the corpus's `NaN == NaN`
  and `x != x` of a variable answer as Flash does, two NaNs computed
  apart do not. The player cases compare no NaN with another.
- A division by zero from SWF 5 takes the zero as unsigned: `1 / -0` is
  `Infinity`, `-1 / -0` `-Infinity` (Ruffle divides as IEEE does).
- `Less2` and `Greater` have the empty string after every other string:
  `"" < "a"` is false and `"a" < ""` true (Ruffle compares them as
  ECMAScript does). Other strings compare by code unit, a SWF 5 one by
  byte. Up to SWF 5, `StringLess` and `StringGreater` of the empty string
  and a string from a byte 0x80 up have neither less than the other, and
  each greater (Ruffle orders them).
- A string with no digit is no number: `"."` is `NaN` from SWF 5, as `""`
  is (Ruffle reads it as 0).
- Up to SWF 5 a string is bytes: `AsciiToChar` takes the code's low byte
  (Ruffle a UTF-16 unit), `MBAsciiToChar` writes a code past 0xFF as two
  bytes, the high one first (Ruffle one character), `StringLength`,
  `CharToAscii` and their MB actions count and read bytes, as a
  single-byte locale such as adl's has the MB actions do, and `trace`
  writes the bytes as UTF-8, what is not UTF-8 as U+FFFD (Ruffle reads a
  SWF 5 string as Windows-1252). A double-byte locale's MB actions
  (Shift-JIS) are left out. From SWF 6 the char actions take UTF-16
  units, a surrogate as U+FFFD, as in Ruffle.
- `StringExtract` and `MBStringExtract` take their start as `index - 1`
  in 32 bits, so an index of -2^31 starts past the end (Ruffle clamps it
  to the first character). From SWF 6, each half of a surrogate pair they
  cut is U+FFFD wherever it is compared or joined, so the halves joined
  again are two U+FFFD, not the pair (Ruffle keeps the halves). adl's
  trace of a cut low half alone writes three U+FFFD; swf2es writes one.
- Numbers are written alike in every version, and read alike from SWF 6;
  adl hangs on a string such as `"1e2147483648"` as a number, scaling by
  ten once per unit of its exponent, which swf2es reads as `Infinity`.

### Functions and registers

`DefineFunction` and `DefineFunction2` make a function of a region of the
block, `V.defineFunction(cx, k, "name", ["a", "b"])`, not a JavaScript
closure: an AVM1 closure captures the scope chain, which the function
object keeps with the activation's constant pool, target and `this`, so
each block is written alone, as the JIT/AOT invariant asks. A call makes
an activation object for its local variables above the chain it closes
over, its parameters without a register set on it (undefined past the
arguments given, the later of two of a name).

A DefineFunction2's registers below its register count are the region's
own `let`s, since their indices are in the code: its preloads (`this`,
`arguments`, `super`, `_root`, `_parent`, `_global`, in that order from
`r1`, each where its flag is set, one also suppressed undefined but
`arguments`, which preload and suppress loads) and then its parameters
with a register are set on entry, a later parameter over an earlier one
of the same register. A parameter whose register is at or past the count
is neither a register nor a variable, and a preload past it is dropped.
A root takes no register for `_parent`: `_global` takes its place (the
corpus's `define_function2_preload_order`; adl's harness gives its root
a parent). Every other register is one of the movie's four, `cx.g[i]`,
which the frame's blocks share and which are undefined again as the next
frame starts; `StoreRegister` to one from 4 stores nothing, and leaves
its value on the stack.

Local variables live on the activation object, since `eval` and
`GetVariable` of a computed name can reach them; `arguments` and
`super`, which most functions never read, are made on it as a lookup
first misses them (`Avm1Object.lazy`).

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
  1 or 0 runs no action at all); it takes effect as its frame comes,
  before the frame's actions, and of two in a frame the later
  (`avm1-script-limits`). JavaScript's own stack running out, which a
  `toString` that calls itself can do, disables the actions as well; so
  can a limit set high, or a chain near the default limit whose
  JavaScript frames are large (in node, `apply` runs out after some 680
  levels and a DefineFunction2 of 64 registers after some 730).
- Not reproduced: the activation object a function called by name inside
  another gets as `this` lists `arguments` in `for..in`, after its
  variables, but not `super`, and its `arguments` read from the inner
  function is the inner function's; a parameter named `arguments` given
  null or undefined leaves `arguments` there, one named `super` gives way
  to `super`, and a local variable named `this`, a parameter too, is what
  `this` reads in the function.

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
  properties. Control going anywhere else takes the scope off at once,
  and a jump into a body from outside finds none; a branch at that first
  action back into the body keeps it. adl looks only at the scope on
  top: a With that is the first action past a body puts its object over
  the scope, which stays under it until both come off past the second
  body.
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
  over it, and the name is never a path. A throw in a With's body, or at
  the first action past it, caught outside it, keeps the With's object
  over the catch body, under the variable's, and over the next catch's
  where the catch throws again. A finally reached by a throw or a
  `Return` keeps a scope only as a jump there would.
- A throw cuts the operand stack back to its height as the `Try` ran, as
  Ruffle does; a value nothing catches leaves it as it is.
- Code running off a try body runs the catch's bytes, the variable not
  set, then the finally's. A jump out of a try or catch body runs no
  finally; a `Return` in one runs the finally, the stack cut back to its
  height as the `Try` ran and the value left on top of it while it runs,
  and then returns what is on top of the stack: what a finally pushes is
  returned, the value under it left on the stack, and a finally's own
  `Return` returns its value and leaves the first. A finally reached by a
  throw or a `Return` throws or returns as control leaves it, at once,
  even by a jump; a throw or a `Return` in it takes their place.
- A thrown value nothing catches ends its block, function calls included,
  and writes nothing; `undefined` can be thrown too. Past the recursion
  limit no catch or finally runs.
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
  function gives undefined.

### The constant pool

What adl does with `ConstantPool`:

- A frame's `DoAction` blocks share a pool: a block without a
  `ConstantPool` of its own reads the one the frame's last block set. A
  frame's pool is not the next frame's, and neither a `DoInitAction`'s
  nor a clip event's pool reaches the blocks after it.
- A function keeps the pool of the activation that ran its
  `DefineFunction`, as it was then: a `ConstantPool` after the
  definition does not change what the body reads. A `ConstantPool` in its
  body sets its own activation's pool, not its caller's, nor the
  frame's, nor what its next call starts with.
- A `With`'s and a `Try`'s bodies run in their activation, and a
  `ConstantPool` in them holds after them; a catch or finally starts with
  the activation's pool, as a throw reaches it from anywhere in the try
  body.
- A constant past the pool's end, an empty pool's included, is
  `undefined`. One read where no pool was set (a frame's first block, a
  `DoInitAction`, a clip event, a function defined before any pool)
  reads whatever adl's memory holds there: most often `""`, at times
  bytes of other strings, and in a `Push` of several values it can end
  the block. No compiler writes that; swf2es reads `undefined` there.

## The runtime

`runtime/src/avm1/` holds AS1 and AS2 as a language, with no display
list, so its unit tests run in node.

### Values

An AVM1 value is a JavaScript primitive, `undefined`, `null`, a boolean, a
number (always a double: AVM1 has no int type, and `Push`'s integer type
is a number) or a string, or an `Avm1Object`. AVM1 values are not AS3
values: an AS3 object never appears in AVM1 code and an AVM1 object never
in AS3; what crosses between them is copied (see "AVM1 and AVM2").

The conversions are per version, as Ruffle's `Value` has them
(`coerce_to_f64`, `coerce_to_string`, `abstract_eq`, `abstract_lt`): a
string to a number reads hex, an exponent and spaces as Flash does, which
is neither JavaScript's `Number` nor AS3's, and a number to a string has
AVM1's own formatting (15 significant digits, its own exponent form),
which `numbers.ts` writes, apart from AS3's avmplus-derived one. Both are
Ruffle's, translated with the carry's bugs (-9999999999999996 is `-e+16`),
and adl traces them alike (the `avm1-hello` case). `trace` writes
`undefined` whatever the version, as Flash does, and its text as it is:
Flash's log breaks a line at a carriage return as at a line feed (the
corpus's `trace`, and AS3's `edittext_newline_stripping`), where adl's
stderr keeps the `\r`, so the tests' harnesses break lines so, in the
player's traces and adl's alike (`oracle/flash.ts`,
`tests/player/page.ts`); a host writing a log does the same.

Converting an object calls its `valueOf` or `toString`: `ToNumber`,
`Less2` and `Equals2` (both sides first, up to SWF 5) ask `valueOf`,
`Add2` asks it but a Date's `toString` from SWF 6, `ToString` asks
`toString`, a clip writes its path. Each calls the method as Flash's
"special" calls do, without `__resolve`, a method that is missing or no
function giving undefined, so a bare object's `valueOf` is undefined and
`_global == null` is true. An object compared with `null` or `undefined`
by `Equals2` goes through its `valueOf` too, as in adl and Ruffle.

### Objects

An `Avm1Object` keeps its properties in a JavaScript `Map` by their exact
names, in the order they were added, each with its value or its getter
and setter and its attributes (`ASSetPropFlags`: don't enum 1, don't
delete 2, read only 4, and the version bits that hide a builtin from
SWFs before the version that introduced it). Lookups take the calling
SWF's case sensitivity, so a SWF 6 and a SWF 7 that share an object each
find names as their version does: a SWF from 7 asks for the exact name
alone; a SWF up to 6 asks for the exact name first, as code mostly
spells a name one way, then the name folded to lower case, then, on a
miss, an index of the names that folding changes, built only as such a
lookup first misses. Folding is Flash's lower case, code unit by code
unit (`lowercase.ts`), not JavaScript's: adl folds `İ` to `i` and `Σ` to
`σ` alone, and leaves `ẞ`, Cherokee, Glagolitic and the later Latin
letters as they are. Where two spellings of a name exist (set by SWF 7
code), a SWF 6 finds the exact one, else the lower-case one, else the
first added.

`__proto__` is a property like any other, which the object also keeps at
hand for the walks up its chain. A walk takes `__proto__` only where its
version sees it: a function's `__proto__` has the bit that hides it from
SWF 5, so a SWF 5 finds nothing on a function's prototype, not even
`toString` (adl: `Object.toString()` is undefined in a SWF 5, and
`trace(Object)` writes `[type Function]`). A walk stops after 255
prototypes, as Ruffle's does.

`get` takes the first property the version sees along the chain, calling
its getter with the receiver as `this`; where none has it, the first
`__resolve` on the chain that holds an object is called with the name (a
primitive one skipped, one that is no function giving undefined),
whatever version bits it has. `set` calls the object's watcher of the
name first, whose result is the value set; then a property of the object's
own takes it (its setter called, the value kept unless read only, and a
set over a hidden builtin clearing its version bits), else the first
getter on the prototypes takes it through its setter, or ignores it
without one, else the object gets a new property. A primitive's members
are its class's: `"abc".length` and up to SWF 6 `constructor` are the
box's own, the rest is looked up from the class's `prototype` with the
primitive as `this`, without making the box, while `_global`'s `String`,
`Number` or `Boolean` is the builtin; one a SWF replaced boxes it as
Flash does, by constructing it. A set on a primitive is lost.

`for..in` (`Enumerate`, `Enumerate2`) pushes `undefined`, as adl and
Ruffle do (not the specification's null), then the names, so that the
first to visit is on top: a prototype's names first, the deepest
prototype's first, then the object's own, the last added first, a name
deleted and set again last added; DontEnum ones left out. A prototype's
name is left out where the object lists the same name itself, but not
where the object's own is DontEnum (adl lists `constructor` from an
`Object.prototype` whose flags were cleared, though `{}` has its own,
DontEnum; Ruffle leaves it out). An array's indices come as `2 1 0`, and
`{10: 1, 2: 2, 1: 3}` as `10 2 1`, insertion order reversed.

What adl showed of the rest (the `avm1-objects-swf5` to `-swf10` cases),
where it is not what Ruffle does:

- `ASSetPropFlags(o, names, set, clear)` finds the names whatever their
  case, in every version; the names are a string split at commas, or what
  an array converts to, and null is every property, `__proto__` and
  `constructor` included. The version bits hide a property as Ruffle's
  masks have it: 0x80 from SWF 5, 0x100 from SWF 6 alone, 0x400 from 5
  and 6, 0x1000 up to 7, 0x2000 up to 8, 0x4000 up to 9; 0x200 and 0x8000
  hide nothing. `set` and `clear` are ints whose low 16 bits are taken
  (65537 is 1, -1 is 0xffff, NaN 0). A set shows the property again, but
  a SWF 6's set leaves 0x400, so the property stays hidden from it.
  `hasOwnProperty` is false for a property with 0x100, in every version.
  Not reproduced: bit 0x800 hangs adl's script; `ASSetPropFlags` on an
  array, by name or with null, empties it; and version bits on
  `__proto__` change the walk up it in adl (a SWF 5 stops at any bit that
  hides from it, a SWF 6 only at 0x400, a later SWF at none).
- `addProperty` takes a function as getter and a function or null as
  setter (null: read only), and gives false for anything else, an object
  that is no function included (Ruffle takes any object). The property is
  listed by `for..in` and is `hasOwnProperty`'s, and on an array an
  index's property lengthens it as its element would.
- `watch(name, callback, data)` is false without a function callback,
  and replaces an earlier `watch` of the name. The callback gets the name
  (the property's own spelling where it has one), the stored old value
  (no getter called), the new one and the data, the object as `this`.
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

A getter, a setter, a watcher or `__resolve` is called with the depth a
method call has (a getter's and a setter's `super` is their object's
prototype's), under the property recursion limit. A property read is a
`Map` lookup per prototype walked, with no allocation: in node about 5
to 7 ns for an own property, 12 for one of `Object.prototype`'s (22 in a
SWF 6), 28 to 38 for a global variable. AVM1 objects have no shapes to
key an inline cache on, so a site's cache would hold an object and a
property and need invalidating as properties change along chains.

A function's `prototype` is an object whose `constructor` it is, and
`new` makes an object whose `__proto__` is that `prototype`, then calls
the function; AS2's classes, which the AS2 compiler turns into
prototypes, `Extends`, `ImplementsOp` and `CastOp`, need nothing more.

### Scopes, targets and names

An activation's scope chain is a list, searched from the top: a frame's
or an event's block has the clip it belongs to above `_global`; a
function has its own activation object above the chain it captured; a
`With`, or a catch into a variable, puts its object above either. The
activation also has a **target**, the clip that timeline actions act on
and names without a path resolve in. It starts as the clip the code
belongs to, `SetTarget` and `SetTarget2` (`tellTarget`) change it, and a
`SetTarget` of `""` gives back the original.

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
at its start; the host gives what needs the display list (`root`,
`level`, `parent`, `child`). `_root` is the code's own: the clip whose
code runs, a function's the one that defined it, gives its level, or the
first clip up from it whose `_lockroot` is set (Ruffle's `avm1_root`). A
name with a `/` and no variable, from SWF 5, is the object the path
names. A name without a path is read from the first scope object that
has it on its chain; a name none has is `_root`, `_parent`, `_global`
(from SWF 6) or `_levelN`, else undefined: a variable is never resolved
by `__resolve`.

`this` is the activation's `this`, case-insensitively in SWF 5 and 6, in
a function too (Ruffle has it case-sensitive in a SWF 5 function), and
so is a path's first step (with `_root`, and `_global` from SWF 6),
though a SetVariable path in a timeline's code takes no `this`: adl sets
nothing for `this.x` there, where a function's sets it. adl keeps a
frame's `this` as a variable that `Delete2` can remove, which is not
reproduced. A variable set without a path goes where the chain has it,
else on the target's clip; `DefineLocal` defines it on the top scope, at
a frame's level the clip.

### Builtins

The language's classes are the runtime's, in `runtime/src/avm1/globals/`:
`Object` (but `registerClass`, which binds a symbol and is the
player's), `Function`, `Array`, `String`, `Number`, `Boolean`, `Math`,
`Date`, `Error`, `AsBroadcaster`, and the global functions. Each is
installed on `_global` with the version flags Flash gives it, so a SWF 5
does not see what SWF 6 added, and a class's properties are defined in
the order adl lists them once `ASSetPropFlags` shows them all (a
prototype's `constructor` before its `__proto__`).

### Array and String

An array keeps its elements apart from its other properties while it is
dense, so that `a[i]` with a number and Array's methods need no name and
no `Map`; its first hole moves them into the `Map`. Each property has
the sequence number of its adding, which for..in lists them by: adl
lists an array's names in the order they were set, and its methods set
elements again in their own orders.

Array's methods read and write an object's own elements as adl does
(the `avm1-array-swf*` cases at SWF 5, 6, 7, 8 and 10):

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
  gives is not kept: the methods keep their number.
- A `length` set shorter deletes the elements past it, but those that
  cannot be deleted, and only if the old `length` is a number; set
  longer it makes no elements; it is stored as given (`"3"` stays a
  string, `1.9` a fraction). Under a watcher, adl sets an array's
  `length` twice, as the array and then as the set: the watcher is told
  of both, the elements are cut to the length set, and what the second
  call gives is stored. An element set at 2^31 - 1 wraps it to -2^31,
  which deletes them all.
- `splice` gives undefined for no start, an undefined count or a
  negative one.
- `sort` and `sortOn` sort as Flash's quicksort does, as Ruffle has it
  (the leftmost element the pivot), which a comparator that traces its
  calls shows; an object that is no function sorts by the default order
  (Ruffle compares nothing then). `sortOn` reads its fields as own stored
  values.
- Called on another object (`Array.prototype.push.call(o)`), they tell
  its watchers in Ruffle's order, not in adl's own.

String's methods take `this` unboxed, so a string's method call makes no
String object. Up to SWF 5 a string is its bytes: the methods count and
cut bytes, the case mappings map a byte only to a byte, `fromCharCode`
writes a code past 0xFF as two bytes, `charCodeAt` past the end is 0, and
`split` splits only at one character: at a comma by default, an empty or
longer delimiter leaving the string whole, an empty one whatever the
limit (Ruffle: an empty one is a comma too). From SWF 6, `split` without
a delimiter gives the string whole whatever its limit, and so does an
empty string by any but `""`. `substring` from the end on is `""`,
whatever its end (Ruffle swaps the two first: `"abcdef".substring(10, 2)`
is `cdef`). From SWF 6 the methods cut UTF-16 code units, keeping half a
surrogate pair as it is, so the halves joined again are the pair (adl;
StringExtract's halves are U+FFFD each); `trace` writes half a pair as
U+FFFD, as Flash's log does. `toUpperCase` and `toLowerCase` are Flash's
own tables (`case.ts`, measured in adl over every code unit), one code
unit to one. `String.prototype.valueOf` of anything that is no String
gives it as a string, by its `toString` (Ruffle: undefined), `toString`
undefined.

### Number, Boolean and Math

Number's and Boolean's methods give undefined for anything but their own
kind (Number's `valueOf` too, unlike String's);
`Boolean()` of nothing is undefined. `toString(radix)` from 2 to 36 but 10
casts the number to an int as Flash casts one where it clamps (x86's
cast: NaN, the infinities and anything out of range are -2^31), whose
digits Flash writes as the remainders it takes, each negative:
`(1e20).toString(16)` is `-(0000000`, NaN's in base 3
`-/.//./..././/0.0./0.`, adl and the corpus alike. Number's constants are
read-only, as Math's are.

Math's methods are ASnative(200, i): each converts its first two arguments
whether it uses them or not, and a SWF up to 6 gets NaN from one given
fewer than it takes (min and max of none are the infinities); `round` is
`floor(x + 0.5)`, and min and max take two arguments, NaN from either.
`pow` is C's, as the corpus's math tests have it: 1 to any power is 1
(`Math.pow(true)`, NaN's power, is 1 in `math_swf6` to `math_swf8`, Flash
Player's own traces), and so, by C's rules, is -1 to an infinite one,
where adl's and JavaScript's are NaN. adl is AIR's runtime under Wine,
whose pow is not the Flash Player's that recorded the corpus: it is also
off JavaScript's elsewhere, by a last bit (`Math.pow(2, 0.5)`) or from
the ninth digit (`Math.pow(1.0000001, 1e9)`), which the corpus's tests
leave to their tolerance. So swf2es takes the corpus's special cases and
JavaScript's precision, and the cases trace no result adl and Flash
Player may differ in. RandomNumber (`random(n)`) is an int below its max
cast as Rust casts one (saturated), 0 for a max below 1: the next value
of Flash's generator modulo the max, as avmplus' Random. RandomNumber and
Math.random draw from one generator, the realm's, as adl's interleaved
sequences show; it is AS3's (docs/architecture/runtime.md, "Random
numbers"), so Math.random's values are multiples of 2^-31.

### Date

Date's calendar and methods are Ruffle's (`globals/date.ts`). Local time
is Flash's on Windows, as adl has it: today's standard offset in every
year, plus daylight saving's by today's rule (its month, weekday and
time, read from the host's offsets this year), 1900, 1938 and 2050
alike, not the zone's history (Ruffle adds a constant offset, no daylight
saving at all; AVM2's Date follows avmshell's `localtime_r` instead).
Local fields go back to UTC as Windows compares them with the rule's
local standard times, so a time in the spring-forward gap comes out an
hour earlier and one in the hour that repeats as it falls back is the
later, standard one, east of UTC and west alike. From SWF 7, `setMonth`
without a day keeps the day within the month it sets (Ruffle leaves this
a TODO); `setMonth()` of nothing is January. The player's cases trace
only what holds in any zone, as the tests run in the host's;
`tests/unit/runtime/avm1-date-zone*.test.ts` pin adl's local times in
Helsinki's and New York's. adl under Wine takes its zone from `TZ`, so
`TZ=Australia/Sydney node oracle/flash.ts` shows another zone's (the
oracle keys its cache by `TZ` where it is set).

### Classes

`Extends` gives the subclass a new `prototype` whose prototype is the
superclass's, with `__constructor__` (hidden from SWF 5) and no
`constructor` of its own (adl; Ruffle gives one), through a set, which
leaves a read-only `prototype`: `Object`'s, `Number`'s and `Date`'s are
(adl), not `Function`'s, `Array`'s, `String`'s or `Boolean`'s.
`InstanceOf` walks the object's prototypes for the class's own stored
`prototype` (no getter, a primitive one boxed by `_global`'s class), and
each prototype's interfaces, and theirs; a primitive is no instance.
`CastOp` gives the object or null, boxing a primitive first for nothing,
as Flash does. `ImplementsOp` gives the constructor's prototype its
interfaces' prototypes only the first time, even in a SWF 6 (Ruffle: each
time replaces them, from SWF 7). A primitive where these take an object,
but undefined and null, changes nothing and writes Flash's line to the
log, `Parameters of primitive types are no longer coerced into the
required type - Object.`, and an object for ImplementsOp's count
`Parameters of type Object are no longer coerced into the required
primitive type - number.`, as adl writes them (`inheritance.ts`).

### AsBroadcaster

Flash writes AsBroadcaster in ActionScript, Ruffle in Rust, swf2es in
TypeScript as adl runs it: `addListener` calls the object's
`removeListener`, then pushes the listener, so a listener added again
comes last (Ruffle keeps its place); `removeListener` splices out the
first listener equal to it by `==`; `broadcastMessage` calls each
listener's method of the name, or the listener itself for an empty name,
with the listener as `this`, and gives true, or undefined without
listeners or a name. From SWF 7 it calls the listeners as they were when
it was called; up to SWF 6 the array as it is by then, so that a
listener another removes is not called (Ruffle: by index, a removed
one's place skipped). `initialize` sets a new `broadcastMessage` each
time and AsBroadcaster's own `addListener` and `removeListener` on the
object, and a new `_listeners`, each hidden from SWF 5.

### The global functions

`escape` writes each byte but a letter or digit as `%XX`, of a SWF 5's
string its bytes, of a later one's its UTF-8; `unescape` reads them back,
`+` a space, a `%` before what is no hex digit dropping that character,
and a SWF 6's bytes as its strings' UTF-8 is read (leniently: `%e9%C3%A9`
is U+A0E9; Ruffle replaces what is not UTF-8). `parseInt` is Ruffle's,
which adl agrees with, `parseFloat` the conversions' own; `isNaN` and
`isFinite` convert by version.

`ASnative(category, index)` gives a new function of Flash's table each
call: 4 ASSetNative and ASSetNativeAccessor, 100 escape, unescape,
parseInt, parseFloat and trace, 101 Object's methods, 103 Date's, 200
Math's, 250 the timers', 252 Array's. An index past a table's natives
gives a function of none, returning undefined (Math's NaN), and so does
any index of Flash's other categories (1 to 5, 9, 11 to 15, 102 to 107,
110 to 113, 251, 253, the display, text, sound and I/O classes' up to
2401, as adl has them); any other category gives undefined.
`ASSetNative` and `ASSetNativeAccessor` set methods and accessors from it
as Ruffle has them, a version before a name hiding it from earlier SWFs.

`_global.trace` and ASnative(100, 4) write to the log, as Flash's
authoring tool shows them in its Output panel, where the corpus's
`asnative` was recorded, though Flash Player's `flashlog.txt` and adl get
nothing from them: content that calls them means them to be seen.

## The player

### Hosting AVM1 objects

An AVM1 movie's display objects have, beside their AS3 face, an `avm1`
one, the AS2 object a script sees, made as the clip is placed: a
`MovieClip`, `Button` or `TextField` whose natives read and write the
display object as playerglobal's do. The display list, the timeline,
text layout and drawing are the same for both VMs. Its `display`, a
`DisplayNative` the player gives it, puts after the object's own
properties, and before its prototypes', `_root`, `_parent`, `_global`
and `_levelN`, its children by instance name, then the display
properties `_x` to `_ymouse` in any case, as Ruffle's `stage_object.rs`
orders them;
a set of a display property's name goes to the display object where the
object has no property of its own of the name; for..in lists its
children last, the highest depth first. `typeof` a clip is `movieclip`, a
button's or a text field's `object`; any of them converts to its path
from its level, `_level0.a.b`, and `_target` is its slash path, `/a/b`,
`_level1/a` below another level and `/` for any level itself. A clip, a
button, a text field and a video get one as they are made; a shape, a
morph, a bitmap or static text has none, and its name finds its
parent's. A clip, a button or a text field without a name is named
`instance1`, `instance2`... as it is made (the corpus's
`default_names`), the root never.

AVM1 references to clips are by path in Flash: a variable holding a clip
finds the clip that has its path now, if the one it was taken from was
removed and another placed by the same name. The AS2 object of a clip
keeps the path it had as it was removed, and an action taking it as a
value reaches the object placed at that path since, or nothing, as
Ruffle's `MovieClipReference` does; its `typeof` stays `movieclip`.

A text field with a variable name (DefineEditText's `VariableName`, or
`variable` set) shows a variable on the clip its path names, resolved
from the field's parent past any button, and a change to either updates
the other (after Ruffle's `try_bind_text_field_variable`): the runtime
tells a clip's `DisplayNative.changed` before it stores any property, and
the field shows the value as HTML. As a field is made it takes the
variable's value, or gives it its text where the variable has none; one
whose path names no object yet waits, tried again as each display object
is made, and the fields bound to a clip that is unloaded wait again.

### Text fields

`TextField.prototype` (after Ruffle's `text_field.rs`) has accessors that
read and write the same text, formats and layout AS3's `TextField` has,
finding the field each time, so another object given them reads
undefined. Each field is a broadcaster that hears itself first.
`TextFormat`'s numbers are ints from SWF 8, rounded half to even and out
of range -2^31, before it wrapped. `createTextField` makes a field in
whole pixels, which only a SWF 8 gets back; `_width` and `_height` set a
field's own size in whole twips, whatever its scale. Setting the text or
HTML a field already has changes nothing, its formats included.
`TextField.StyleSheet` keeps each style copied in `_css` and its
TextFormat in `_styles`; a field with a sheet reads its text as HTML
styled by it and gives back the HTML as set, and a new sheet styles that
HTML again. `StyleSheet.load` loads as `LoadVars.load` does, but with no
`onHTTPStatus` (adl), its default `onData` calling the overridable
`parse`, false for a missing or empty response or invalid CSS.

Input fields use AS3's editor: keys edit the focused field, with
`restrict`, `maxChars` and the clipboard, unless a button or clip took
the character's keyPress. An edit by the user sets the bound variable,
then broadcasts `onChanged(field)`; a script's does not broadcast it.

`MovieClip.setMask`, from SWF 6, takes an object or a path, null or
undefined clearing the mask, and a path that finds nothing giving false,
the mask left as it was. The drawing API, from SWF 6, draws into the
same `Drawing` as AS3's: coordinates cut to twips, line widths to whole
pixels, alpha a percentage. Bounds take in paths without a style; before
SWF 8 they are the control points padded by the whole line width, from
SWF 8 the curves' extremes padded by half of it, grown with each segment.

`TextSnapshot` (as Ruffle's) is a clip's static texts' text, its own
children's in the order they are drawn, as it was when made: `new
TextSnapshot(clip)`, or `clip.getTextSnapshot()`, which makes one by
whatever `_global.TextSnapshot` is then. `getCount`, `getText(from, to,
newlines)` (at least one character, the indices clamped, a "\n" between
texts with newlines) and `findText(from, text, caseSensitive)` (ASCII's
case aside) answer undefined for other argument counts, as Flash's do.
Its methods are enumerable, from SWF 6, and `_global` defines it last,
so it is the first name enumerated, as in Flash.

### The frame

`Avm1` (`player/src/avm1/avm1.ts`) holds a player's AVM1: the modules of
each AVM1 SWF loaded, the action queue and the global registers. An AVM1
main SWF needs no AS3 runtime and no playerglobal, as AVM1 has a pointer
and a keyboard of its own. The order of a frame is Flash's, as Ruffle has
it (`Avm1::run_frame`, `MovieClip::run_frame_avm1`, `ActionQueue`) and
the corpus checks it, which is not AS3's: AVM1 clips run in the reverse
of the order they were made, the newest first, each dispatching `load` on
its first frame and `enterFrame` after, then running its timeline's tags,
which queue its DoAction blocks. Then the queue runs, by priority, each
time the most urgent first: initialization (`onClipEvent(initialize)`),
the root's DoInitAction blocks, construction (a registered class's
prototype, `construct`, then the class's constructor), then the rest,
frame actions, events and the AS2 methods in the order queued, skipping
what belongs to a clip removed meanwhile but its `unload`. The player
keeps AVM1's execution list as clips are made and removed, not by walking
the tree each frame.

The timeline tells AVM1 of each DoAction tag it reaches in tag order
(`TimelineActions` in `display/timeline.ts`), so a child placed before a
frame's actions runs its first frame first. A goto queues the frame it
lands on (none past the last frame, nor one to the frame it is on), the
children it makes on frames before it running their first frames first,
then the frame's places and actions in tag order, as adl orders them
(Ruffle runs the target frame's actions before every child the frame
places); a goto from the queue queues the frames it enters. A rewind
keeps what is at a script's depths, a timeline's clip swapped there too,
and removes a script's clip at the timeline's depths (Ruffle's
`survives_rewind`).

A root frame runs its DoInitAction blocks first, each sprite's once,
then its DoAction blocks, in tag order, sharing the operand stack and
the constant pool as "The dispatcher" and "The constant pool" say (the
`avm1-hello` case: an init whose tag comes after the frame's DoActions
runs first, and the next frame's `trace` of the empty stack writes
`undefined`). A tag in `corrupt` stops the SWF where its first event
comes, and a stopped SWF, there or by `V.halt`, advances no timeline and
runs no action again.

An AVM1 timeline has as many frames as its ShowFrame tags end, whatever
its header says, and Flash plays and loops it so (the corpus's
`looping_real_*`), where an AS3 timeline has its header's count. What
follows the last ShowFrame is no frame of its own: its places place
nothing, and its DoActions run with the last frame where the timeline
loops, one of two frames or more ending in an End tag; a timeline of one
frame, or without an End tag, stops on its last frame and runs them
once, as the next frame comes (the corpus's `looping_child_*`). A place
at a depth already taken writes `Warning: Failed to place object at depth
N.` to the log, as Flash's does.

### Clips and paths

The main timeline starts with an ordinary, enumerable `$version`
property, writable and deletable, using the same platform and player
version as AS3's `Capabilities.version`. `getVersion()` compiles to
GetVariable of `/:$version`, so it reads that property even when a local
variable shadows it; there is no global function named `getVersion`.
Each SWF a load puts in a level has its own afresh, level 0's
replacement too, whatever the old one's was, so `getVersion()` in a
level reads its own level's; child clips, SWFs loaded into them and
AVM1 movies loaded by AS3 have no initial `$version`, and a SWF loaded
into a clip with `_lockroot` reads none through `getVersion()`.
These behaviours were checked in adl both with a SWF as the application's
main content and through the usual AS3 Loader harness, and the levels'
in Flash's plug-in (PepperFlash 32); the main-content traces are asserted
in `tests/unit/player/avm1/avm1.test.ts`, the levels' in `loads.test.ts`.

`System` has `capabilities`, the values AS3's `Capabilities` reports, as
plain, enumerable, writable values; `security`, whose `allowDomain`
and, from SWF 7, `allowInsecureDomain` return true and grant nothing
more, `loadPolicyFile` doing nothing, and `sandboxType` "remote";
`useCodepage` false; and from SWF 6 `exactSettings`, true from SWF 7.

What adl traces of clips at SWF 4 to 8 (the `avm1-clips-swf*`,
`avm1-gotos-swf*`, `avm1-paths-swf*` and `avm1-scopes-swf*` cases), and
the corpus, where it is not what Ruffle does:

- `_x` and `_y` are whole twips, cut toward zero (`1.234` is `1.2`), and
  what does not fit an int -2^31 twips; `_alpha` is an 8.8 multiplier,
  the percentage's 256ths cut toward zero (`33` is `32.8125`); `_xscale`
  and `_yscale` give back the percentage set, so integer steps reach
  exact ends (`avm1-scale-ramp`), and past 32768 times draw at that;
  `_rotation` is set modulo 360 into -180 to 180; `_width` and `_height`
  are the bounds through the clip's matrix with each corner rounded to
  twips, and set over a base, the content's own bounds turned by the
  clip's rotation, unscaled, in whole twips: the side set scales to the
  value over its base, the other to its size now over its base, both
  positive (not Ruffle's `set_width`), a negative one ignored;
  undefined, null and NaN leave any of them be. `_visible` takes a
  number. `_droptarget` is `""` in every version (Ruffle: undefined up to
  SWF 5). `_quality` is `HIGH`, which ToggleQuality toggles, drawn by
  from the next frame; `_soundbuftime` is 5 and `_focusrect` a SWF 5's
  1, a later one's null on a clip.
- SetTarget and SetTarget2 resolve their path from the code's own clip,
  not from the target, so a tellTarget inside another names from there;
  one that finds nothing leaves no target, and names then resolve on the
  root. SetTarget2 of undefined is the code's own clip up to SWF 6 and no
  target from 7. GetProperty and SetProperty name from the target, or
  from the code's own clip where there is none, the index truncated.
- A path's empty step names nothing first or after a slash (`//a`, `.a`)
  or at the end after a colon (`a::`), and is no step at all after a dot
  or a colon (`a..`, `a:/`); `..` of a level is the level, but where a
  slash follows; `_levelN` is any name starting so, its N the digits that
  follow, none 0 (`_level0..:_flash0` is the root). Ruffle fails these.
  A step at a primitive, where a clip's path is taken as an object
  (GetProperty, SetProperty, tellTarget, Delete2) writes `Parameters of
  primitive types are no longer coerced into the required type -
  Object.` to the log from SWF 5.
- A SWF 4's GetVariable gives no clip, undefined in its place, as Ruffle
  has it, and a SWF 4's functions run as a SWF 5's (`V5`).
- A clip compares as NaN with anything, Less2 and Greater giving
  undefined, and a clip as `__resolve` is skipped as a primitive is.
  Equals2 and StrictEquals take two clip references as equal where they
  reach the same clip now; one that reaches none equals no other
  reference, nor undefined.
- `gotoAndStop` takes a whole number as a frame, anything else as a
  frame's number or label, after a path's last `:` or `.` (`b:start`),
  labels in any ASCII case; a frame past the last goes there, its
  actions not run, 0 and below nothing.
- Code whose clip a call, a `new` or a CallFrame takes off the display
  list returns right after it, as Ruffle's `continue_if_base_clip_exists`
  has it: a block ends, a function returns undefined, and its caller goes
  on unless its own clip went too. A function's clip is the one it was
  defined in, from SWF 6, and in a SWF 5 the clip of its `this` or of
  the caller's target. A goto, in a tellTarget too, is no such call, nor
  a method of undefined or null: the code after them runs (the corpus's
  `removed_clip_halts_script`).
- `hitTest(x, y)` is in the root's space against the clip's bounds on the
  stage, `localToGlobal` and `globalToLocal` work in twips, rounding as
  Flash's matrices do; `getBounds` of nothing is 6710886.35 each way, and
  in another clip's space 6710886.4 for good once code of SWF 8, or any
  code under a root of SWF 8, has called `getBounds` or `getRect`.
- Not reproduced: `_width` of a turned clip scaled past 32768 times is
  off by a few twips, and a function's clip, once removed and placed
  again, is not found again by its path.

adl's harness loads a SWF as an `AVM1Movie`, whose root traces as
`_root`, with a name and a parent of the harness's, where a main
movie's root is `_level0`, as the corpus shows; so the player cases
trace no root's path or name.

### Clip events and buttons

A place's clip actions are registered on its clip by event: `load`,
`enterFrame`, `unload`, `mouseMove`, `mouseDown`, `mouseUp`, `keyDown`,
`keyUp`, `keyPress` with its key, `data`, `initialize`, `construct`, and
the button-like `press`, `release`, `releaseOutside`, `rollOver`,
`rollOut`, `dragOver`, `dragOut`. From SWF 5 each runs its block with the
clip as target and `this`, and from SWF 6 the methods of the same names
(`onLoad`, `onPress`...), looked up as the queue reaches them, without
`__resolve`, run after it; `initialize`, `construct`, `keyPress` and
`data` have none. A clip gets its `load` as it enters its first frame,
before its tags run, and its `enterFrame` each frame after, before it
plays, whether it plays or not.

What adl traces of them at SWF 5 to 8 (the `avm1-events-swf*`,
`avm1-construct-swf*`, `avm1-depths-swf*` and `avm1-initclip` cases), and
the corpus, where it is not what Ruffle does:

- A clip the timeline places has its `initialize` events queued as it is
  made, before its children's, and its construction after: the class
  `Object.registerClass` binds to its symbol's export name as the queue
  reaches it, which its prototype becomes, then its `construct` events,
  then the class's constructor on it, with `__constructor__` (and
  `constructor` up to SWF 6) as `new` gives them. Its `initialize` events
  see MovieClip's prototype, not the class's (Ruffle gives the class's as
  the clip is made). Only a sprite's clip takes a class: a button of a
  registered symbol stays a Button.
- The root's DoInitAction blocks run as the root enters their frame, in
  tag order, a sprite's once, after the `initialize` events of what the
  frame places and before its constructions (Ruffle runs them all as the
  SWF loads), so a class an `#initclip` registers after its frame's
  places is theirs. An attachMovie of a sprite whose `#initclip` has not
  run attaches it all the same. An ExportAssets name is found as the root
  reaches its frame. A goto registers the exports and queues the
  initializations of the frames it skips, even one beyond the last
  frame, but runs none of their DoAction blocks. A rewind replays exports
  from frame 1; a sprite's initialization still runs only once.
- A clip a script makes, by `attachMovie`, `duplicateMovieClip` (with the
  source's matrix, colour and clip actions) or `createEmptyMovieClip`, is
  placed, its first frame entered and its `load` and first frame's
  actions queued; then at once its class's prototype, its `construct`
  events, the init object's properties (before the `construct` events up
  to SWF 6, after them from 7), set in the reverse of for..in's order,
  its class's constructor and its `onConstruct`, which nothing it throws
  leaves; its `initialize` events wait in the queue. Ruffle runs neither
  event for such a clip, and `onConstruct` only for
  `createEmptyMovieClip`'s. `attachMovie`, like `duplicateMovieClip`,
  gives a SWF 5 nothing back.
- Where a function of the SWF's, called by CallFunction or CallMethod,
  returns to code the queue runs, the initializations and constructions
  queued by then run, before the code goes on (Ruffle runs them only in
  the queue's order).
- `removeMovieClip` and RemoveSprite remove only what is at a script's
  depths, below Ruffle's 2130706416 (a timeline's clip swapped there
  too); `attachMovie`, `duplicateMovieClip` and CloneSprite place at a
  script's depths up to 2130706428, and `createEmptyMovieClip` anywhere,
  its depth wrapped as an int. CloneSprite takes its depth as it is,
  which Flash's compiler biases.
- A clip removed with an `unload` handler, a clip event's or an
  `onUnload` anywhere on its object, or with such a clip in it, gets its
  `unload` now, the children's first, and stays, drawn and found by its
  name, at a depth below the timeline's until the next frame, as Ruffle
  keeps it. What it queued before runs where it has no clip actions of
  its own, and does not where it has (Ruffle runs none of it); a clip
  removed without such a handler runs none of it.
- The main movie's root gets its `load` once its first frame's actions
  have run, so an `onLoad` they set is called (the corpus's
  `root_onload`, a known failure of Ruffle's); adl's harness, whose root
  is a loaded movie's, calls none.
- `super(...)` by name, CallFunction of `super`, runs the class above's
  constructor, as CallMethod of it does.
- Flash Player's log writes `Warning: Uncaught exception, ...` for a
  value thrown that nothing catches, where adl writes nothing; the
  player follows adl.

The pointer (`avm1/pointer.ts`) follows AVM1's rules in Ruffle's order
(`update_mouse_state`, `mouse_pick_avm1`, `event_dispatch`). Each input
first goes to every clip, the newest first, as `mouseMove`, `mouseDown`
or `mouseUp` (the left button's alone), and what they queue runs; then
the object under the pointer is picked again and gets its button
events (a `press` only if it was under the pointer before those clip
events too, Flash's rule in docs/architecture/input.md), all queued
before the queue runs once: as the hover moves with
the button up, `rollOut` of what it was over and `rollOver` of what it
is over; with it down, `dragOut` and `dragOver`, any button's as a
menu's items have them, none while a script drags a clip; then `press`,
or a `release` where the pointer is over what it pressed (or what a goto
made again in its place, at its depth, of its character), else
`releaseOutside` of that and a `rollOver` of what it is over.

Only a button, or a clip in button mode, takes the pointer: one whose
clip actions have a button event, or, below the root and from SWF 6,
whose object has or inherits one of the seven button methods (`onPress`,
`onRelease`, `onReleaseOutside`, `onRollOver`, `onRollOut`, `onDragOver`,
`onDragOut`). Levels are searched from the top: in a button, what its
state shows, then its hit test state; a clip in button mode takes the
pointer itself, its buttons with it, where its `hitArea` or it is drawn;
other clips' children are searched topmost first. A hidden button that
is up gets no button event, one not up all of them, and a hidden clip
only those of the pointer leaving it, `rollOut`, `dragOut` and
`releaseOutside`, as Flash Player 32 sent them to clips hidden from
under a still pointer by a frame, an interval, their own `onRollOver` or
`onPress`, or a press's `onMouseDown` (Ruffle's `filter_clip_event`
lets the last alone through); one whose `enabled` is false gets none, and a
button so goes up unless the event would show it over (a `rollOver`,
`release` or `dragOut`) and the pointer lets go of it. After each frame
the pointer is picked again where nothing was under it or what was is
hidden or gone, so a button that comes under an idle pointer gets its
`rollOver`. The hand shows over a button, or a clip whose nearest
ancestor in button mode has it, whose `useHandCursor` and `enabled` are
true; these and `hitArea` are read as code reads them, a getter
`addProperty` gave included.

`startDrag` drags one clip at a time, its centre on the pointer where it
locks it, within its bounds in the parent's space, at whole twips.
`_xmouse` and `_ymouse` (Ruffle's `local_mouse_position`) go through the
matrix from the clip's twips to the screen's pixels (`Avm1.pixelRatio` a
stage pixel), whose translation a matrix keeps in whole screen pixels,
and back to whole twips, each rounded half to even; where that matrix
cannot be inverted, as for a clip scaled to nothing, the screen pixels
are taken as its twips (the corpus's `mouse_pos*`). As it moves, a
dragged clip's `_droptarget` becomes the slash path of what is under the
pointer, the clip left out (`""` for nothing), picked as the pointer
picks but where a clip's own drawing counts too, the topmost of what is
in it deciding, and a clip in button mode by its drawing, not its
`hitArea` (the corpus's `drag_drop`).

A button's condition blocks run on the transition their flags name,
with the button's parent as target: `rollOver` idle to over up,
`rollOut` over up to idle, `press` over up to over down, `release` over
down to over up, `releaseOutside` out down to idle, `dragOut` over down
to out down, `dragOver` out down to over down; idle to over down and
over down to idle come of none. The button's blocks are queued, it plays
the transition's sound, the drags' none, goes to the state, over for
`dragOut`, and from SWF 6 its AS2 method is queued. A clip in button
mode goes to the event's frame label and stops, where it has one (`_up`
for `rollOut` and `releaseOutside`, `_over` for `rollOver`, `release`
and `dragOut`, `_down` for `press` and `dragOver`), then queues its clip
actions and method, itself their target.

A key pressed goes, as Ruffle orders it, to every clip's `keyDown` clip
actions, as they are drawn, the lowest first and what is in one before
it (a clip's `onKeyDown` waits for focus), then to Key's listeners'
`onKeyDown`; then, if the key is a keyPress, to the first button or
clip, in drawing order, whose keyPress it is: a button's condition
blocks with that key, enabled or not, or a clip's `on (keyPress)`. A
hidden clip takes none, nor what is in it, a hidden button none while it
is up, and a button in a button none. A key let go goes to the clips'
`keyUp` and Key's listeners' `onKeyUp`. A keyPress's key is Flash's own
code (Ruffle's `ButtonKeyCode`): a printable ASCII character's, or one
below 20 for an editing key (Left 1, Right 2, Home 3, End 4, Insert 5,
Delete 6, Backspace 8, Enter 13, Up 14, Down 15, Page Up 16, Page Down
17, Tab 18, Escape 19).

`Key` has Flash's key constants, `isDown` (the mouse's buttons are keys
1, 2 and 4), `isToggled` (each press of a key, a mouse button's too,
turns it on or off, a held key's repeats not), and `getCode` and
`getAscii`, the last key pressed or let go. `Mouse`'s listeners hear
`onMouseMove`, `onMouseDown` and `onMouseUp` after every clip's clip
events, and `onMouseWheel(delta, target)`; `hide` and `show` give 1
where the pointer showed before, else 0, as adl gives them (Ruffle the
opposite). A listener that is a clip taken off the display list hears
nothing, as a clip is found by its path.

The focus (`avm1/focus.ts`) is as Ruffle's FocusTracker has it. A
button, or a clip below the root in button mode or whose `focusEnabled`
is true, may be focused; `Selection.setFocus` of nothing gives false, of
undefined or null takes the focus away, and of an object or a path from
the code's target focuses it where it may be and gives true, else false;
`getFocus` gives the target path, or null. As the focus changes, at once
and not queued, the object that had it hears `onKillFocus(new)`, the one
that has it `onSetFocus(old)`, then Selection's listeners
`onSetFocus(old, new)`; focusing it again tells none. A focused object
removed, or hidden by its own `_visible`, loses the focus. The highlight
shows as the focus moves where the object draws something and its
`_focusrect` (from SWF 6 its own where set, else the stage's; in SWF 5
any clip's sets the stage's) is true, a later change leaving it as it is;
a left press makes it inactive, and below SWF 9 any press, release or move
does, until the focus moves again. While it shows, the view draws the
yellow rectangle around the object, as AS3's (docs/architecture/input.md),
all measured in Flash Player 32's projector at SWF 5, 6 and 8. While it is not inactive the focused
object hears `onKeyDown` and `onKeyUp` (from SWF 6), after its keyDown
clip actions; while it shows, Enter and Space that no keyPress took
press and release it, if enabled.

Tab, and Shift+Tab, that no keyPress took moves the focus through the
tab order, after what the key queued runs, round past the end. The order
is walked as the list is drawn, each object before what is in it,
leaving out what is hidden or in a clip whose `tabChildren` is false: a
button or an input text field unless its `tabEnabled` is false, a clip
whose `tabEnabled` is true or, not set, one in button mode or with a
`tabIndex`. Once any has a `tabIndex` (an int; -1 none; a value but a
number or boolean the least), the order is by it, equal ones as walked,
those without one left out; else by place, 6 × y + x of the top left
corner on the stage in twips (a button's hit area's), the first walked
at a place alone kept. A field given the focus has all its text selected
once the focus's events have run, which see no selection, and loses its
selection with the focus; Selection's indices are the focused field's,
-1 without one.

### Time and the script timeout

The timers of `setInterval` and `setTimeout` run by the player's clock,
every interval of at least 10 ms (Ruffle's minimum), with ids from 1.
They fire between frames, the earliest first, with the root's clip as
target and what they queued run after them, at most 10 a pass (Ruffle's
`MAX_TICKS`); a method's on a removed clip stops its timer. adl fires an
interval shorter than a frame several times a frame, by its clock (the
`avm1-timers` cases trace what does not depend on the host's timing).
With `realTime: null`, as the tests have it, a frame's duration passes
after each frame's actions. `getTimer` gives whole ms since the start:
on that frame clock, which stands still through a frame, a script asking
again and again sees a ms pass every fifth call from the twentieth, as
Ruffle has it, so a wait for it ends.

Scripts that run past the script timeout, Flash's 15 seconds or the
SWF's ScriptLimits', have the movie's actions disabled from there, its
timelines playing on, as past the recursion limit: Flash Player asks
whether to stop them, Ruffle stops them, and adl hangs. The time counts
from when the player starts running scripts, a frame or a pass of the
timers, and the timers fired after a frame's actions share its budget.
The check costs a loop nothing measurable: a jump back counts down
`V.budget`, a call and a step of the queue `realm.budget`, and only as
one runs out, every 100000, is the clock read.

### Sound, Color and SharedObject

These follow Ruffle's classes. A `Sound` or a `Color` keeps its target as
given, a clip or a path, and finds the clip again each time it is used.
A Sound's transform is its clip's, which every sound under the clip
plays by, or with no target the global one; the sounds it starts are the
timeline's kind, held to the same 32 and stopped with them, StopSounds
included, and `onSoundComplete` runs after the frame's actions. A loaded
movie's own sounds stop as the movie goes, removed, unloaded or replaced
by another load, a movie it loaded going with it: a sound of its library
a Sound plays on a clip of it never completes (adl), and the event sounds
its timeline started there, which AVM1 cannot observe, go too. Other
sounds play on and complete (adl): the parent's Sound on the clip a load
fills, through the load, a failed one, the unload and the clip's removal;
one on a clip of a movie's own that it removes, or that unloadMovie
emptied though nothing was loaded into it; and the global Sound's. A Color
keeps the clip's colour transform as a clip keeps one, the multipliers
in 8.8 fixed point and the offsets whole, 16 bits each, wrapped. A
`SharedObject` keeps its data in the host's storage as the .sol file
Flash writes for AVM1, AMF0, under the key AS3's SharedObject uses, so a
SWF's saves are found whichever AVM reads them.

### flash.geom

`_global.flash` (from SWF 8, DONT_ENUM) holds `geom`'s classes, as
Ruffle's have them. `Point`, `Rectangle` and `Matrix` are plain objects,
as Flash writes them in ActionScript: their methods read and write `x`,
`width`, `a`... by name, so any object with them will do, a constructor
keeps its arguments as given, NaN and `{}` among them, and what a method
makes is made by the class `flash.geom` has then, -1 where it has none.
In doubles where Ruffle works in floats: `rotate`,
`scale` and `translate` apply after the matrix, `concat` applies its
argument after; `invert` of a singular matrix is the identity;
`createBox` without a rotation is NaN; `createGradientBox` scales by
1/1638.4. A rectangle's `topLeft` and `size` are points of its values as
they are; `contains*` of a NaN is undefined; `union` treats a size not
above 0 as empty, so NaNs go into it; `equals` asks for a Rectangle.
`normalize` leaves a point of no length as it is.

`ColorTransform` keeps its eight values as given, its accessors defined
alpha first, as for..in lists them backwards; `rgb` gives and sets the
offsets, zeroing the multipliers. `Transform` holds a clip's AVM1 object,
read again as it is used, so it follows the clip: `matrix` a new Matrix
in pixels, set where all six fields are its own, the translation to
whole twips; `colorTransform` set as a clip keeps one, the multipliers in
8.8 fixed point and the offsets whole, 16 bits each and wrapped, which
the concatenation up the parents keeps at each step too
(`concatenatedColorTransform`: -523 × 127.5 is -1147);
`concatenatedMatrix` to the stage; `pixelBounds` the box on the stage. A
clip's `transform` is a new Transform of it each read, and one assigned
gives it the matrix and colour transform of the Transform's clip.

### BitmapData

`flash.display.BitmapData`, as Ruffle's bitmap_data.rs has it, holds the
player's bitmap, whose operations AS3's BitmapData shares. What AS3
throws, AS2 answers with a number: -1 for too few arguments or a
disposed bitmap, -2 for a source that is none, -3 for a disposed one, -4
for a rectangle that is none. The constructor takes at least two
arguments and sizes Flash makes (0 never; up to SWF 9 2880 a side; to 12
under 8192 a side and 2^24 pixels; then up to 0x6666666 a side and under
2^29), else `new` gives undefined; a transparent or fill given as
undefined is false or 0, one not given true or 0xFFFFFFFF. `width`,
`height`, `transparent` and `rectangle` are -1 once disposed.

`getPixel` and `getPixel32` are signed; `setPixel`, `setPixel32`,
`fillRect` (a rectangle's fields, own or inherited, as ints) and
`copyPixels` (an alpha bitmap counts only with its point given, and
mergeAlpha is false unless given) give 0; `draw` takes a BitmapData or a
clip or button, drawn by the host's renderer at the stage's quality
(`Avm1.drawer`), and a blend mode by BlendMode's name or PlaceObject3's
number, anything else normal (adl); `clone` keeps the prototype;
`floodFill` gives 0 for a point off the bitmap or its own colour,
`scroll` 0, `colorTransform` -1 even done, as Flash; `loadBitmap` gives
the library's bitmap exported by a name, transparent. The rest run AS3's
operations with AVM1's conversions, ints where AS3 takes uints, and
AVM1's answers (the corpus's `bitmap_data_thorough`):
`copyChannel`, `merge` (its multipliers clamped to 0 to 256, the alpha
one optional), `paletteMap` (its tables' entries summed as they are; no
red table, -1) and `threshold` (an unknown operation is "<") take a rect
spanning back from a negative size, as AS3's do; `noise`, `perlinNoise`
(a base's sign dropped), `pixelDissolve` (five arguments at least, a
negative count a uint's; a seed past the generator's states steps down
as any state, and one a count of 0 or a rect it cannot dissolve leaves
unused comes back, 0 as the tap), `getColorBoundsRect` and `hitTest`
(its errors -2 to -4; a point needs an alpha above 0, a rect not at
threshold 0). `threshold` and `getColorBoundsRect` compare the pixels as
they are kept, premultiplied, unlike AS3's, and threshold writes its
colour premultiplied by its own alpha. Flash leaves the alpha it writes
into an opaque bitmap, which its getPixel32 reads back; here an opaque
bitmap keeps every alpha at 255, as its drawing, copies and filters take
it to, so only getPixel32 of threshold's and pixelDissolve's copies
differs. `compare` gives -1 for no argument, -2 for no live bitmap, -3
and -4 for other sizes, 0 for the same pixels, else a bitmap of the
differences. `applyFilter` gives -4 for no rect, -5 for no filter
object, -6 for a glow, shadow or bevel into an opaque bitmap or a rect or
filter AS3 refuses (its rect's numbers taken as AS3's, not as ints), and
0 done, a point that is none (0, 0); `generateFilterRect` -1 for no
rect, -2 for no filter object (adl). A clip's `attachBitmap` shows a
BitmapData at a depth, with no AVM1 object of its own, its later changes
showing: real content caches its art so, a level's tiles drawn from its
clips once, then attached.

### Stage dimensions

`Stage.width` and `Stage.height` read the player's stage size, for AVM1
content AS3 loaded too, and stay as they are when scripts transform the
root or load another SWF into a clip or level. Flash Player 32 has them
as enumerable, deletable getters: assigning them does nothing, even
after clearing their property flags. Stage has AsBroadcaster's listener
methods from SWF 6.

### flash.filters

`flash.filters`' nine classes and BitmapFilter (as Ruffle's) hold the
record a display object's filters keep, its values kept as Flash keeps
them, which their getters read back: an alpha in a byte, a strength in
256ths up to 255, an angle within a turn by `%`, kept in radians, blurs
clamped to 0 to 255, a quality to 0 to 15, colour and convolution
matrices in floats (a colour matrix's twenty NaN past a list given, a
convolution's grown to its size, never shrunk), a gradient's colours in
sixteen slots whose alphas and ratios outlast a shorter list, a bevel's
or gradient's type `inner`, `outer` or else `full`. Their properties are
getters and setters on each prototype, listed, from SWF 8; the
prototypes extend BitmapFilter's, whose `clone` copies a filter. A
clip's, a button's and a text field's `filters` read back new objects of
its records each time and take the filter objects of a list up to its
length (an object without a length sets none; a list's length is read up
to 2^20, as Function.apply's), a displacement map's pixels as they are
then, as AS3's are; the renderer draws them as AS3's.

A clip's and a button's `blendMode`, from SWF 8 (a button's listed),
reads its mode's name and takes BlendMode's name or PlaceObject3's
number, a byte, undefined and null as normal; anything else leaves it as
it was, where BitmapData's `draw` takes it as normal (adl). Their
`cacheAsBitmap`, from SWF 8 too, reads whether Flash draws the object
from a bitmap it keeps, which a filtered one always is, as AS3's reads
it, and takes what the script asks for, as Ruffle has it; with
`setMask`, both cached make an alpha mask
([architecture/compositing.md](architecture/compositing.md#masks-and-scroll-rectangles)).

### getURL and fscommand

`GetURL` and `GetURL2` (`urls.ts`), which `getURL`, `fscommand`,
`loadMovie`, `loadMovieNum`, `unloadMovie`, `loadVariables` and
`loadVariablesNum` compile to, route as Ruffle's `action_get_url` and
`action_get_url_2` do, and the host acts:

- A URL `FSCommand:` in any case is fscommand, the target its arguments.
  Without a host's handler, "quit" stops the SWF once its frame has run,
  as a projector quits and Ruffle's test harness ends a test, and the
  rest are dropped; the web element passes every command to its page,
  "quit" too, stopping nothing, as the plug-in did, where its
  allowScriptAccess allows the callers, known as ExternalInterface's are.
- `GetURL` with a target `_levelN` loads into that level, nothing where
  N is not an int; `GetURL2` reads N as a float and truncates it, and
  `_level` alone is level 0. Its flags pick `loadVariables` into the
  target's clip or level (a path's clip that is not the root opens a page
  after all), `loadMovie` into a clip or a level (an empty URL unloads),
  `loadMovieNum` into a level, or else a page. `GetURL2` converts its
  target before its URL.
- A page opens in the window named, "blank" in any case and with or
  without its underscore as "_blank". A method of GET or POST sends the
  innermost scope's variables, but `loadMovieNum` sends none. The player
  refuses by default a target that would replace the page; the test page
  opens none, and traces them for a corpus test with `log_fetch`.

### ExternalInterface

`flash.external.ExternalInterface` (from SWF 8 but `call`) talks to the
page through the bridge AS3's Scripting takes, in Flash's XML: `call`
offers the call to the host's `evalJS` where it has one, then sends it
to `callOut` as an `<invoke>` and reads the answer back with the realm's
`XML`, as content would; `addCallback(name, instance, method)` takes a
function only, and the page's call is read the same way, the method run
and its answer written as AVM1 code between frames. A native call
converts at most 2^16 values in all, an array-like's claimed length
included, so that an object shared down a tree of them stops there and
not after an exponential walk; an object met inside itself is null.

Without a bridge, or one whose `allows` refuses the calling SWF's URL,
`available` is false, `call` null and `addCallback` false. The calling
SWF is the one whose block or function is running, known by its code; a
native called with none running, by a timer, a network callback or the
page, needs every SWF that has had code so far allowed, as AS3's natives
ask when they cannot tell their caller, so that a child from another
origin cannot call the page through `setInterval(ExternalInterface.call,
...)`. A native called implicitly, by a getter, a watcher or a listener,
is the call of the code that set it off, as in Flash.

The underscored helpers Flash's own AS2 class is built of (`_escapeXML`,
`_toXML`, `_toAS`, `_arrayToXML`, `_argumentsToAS`...) are there for
content to call, answering as Flash's do: an empty string escapes to
null and serialises as `<string>null</string>`, an object with an own
`length` (a String object too) is an array, `_argumentsToXML` skips the
first element, the function's name, and `_toAS` reads a node's
`nodeName` only as a string or a String object and a number by AVM1's
conversion (the corpus's `external_interface_*`). `_arrayToAS` and
`_objectToAS`, which Ruffle leaves empty, read a node's `<property id>`
children.

### The network: XML, LoadVars, loadVariables and XMLSocket

Requests go through the host fetch AS3's `URLLoader` uses, resolved
against the movie's base (in the web element the page's or its `base`,
[web.md](architecture/web.md); else the SWF's URL), as getURL's windows
are, and marked "data" for a host that judges requests as Flash did; `XMLSocket`
connects through the
`SocketHost` AS3's sockets use. Without either, a load fails as a
missing file does (`onHTTPStatus(0)`, `onData(undefined)`) and a connect
with `onConnect(false)`, never an error. Answers are delivered between
frames, in the root's activation, as Flash's network callbacks come,
each inside a call of its own, so a setter, watcher or timeout it sets
off ends that one alone; a SWF stopped for good has its loads aborted
and its connections closed. `XML.send`, which sends without a window, is
refused under allowNetworking "internal", as AS3's sendToURL is.
`XMLSocket` refuses a port outside 0 to 65535 as AS3's Socket does,
fails a connection not open by its `timeout` with `onConnect(false)`, and
closes one whose message passes 16 MB without its zero byte. The tree
builds, prints and clones in loops, however deep.

XML and XMLNode follow Ruffle's `xml.rs`, `xml_node.rs` and `tree.rs`,
and adl where they part (cases written to a SharedObject, adl tracing no
AVM1): the parser's statuses are Flash 8's list (an unclosed element -9,
an end tag of an element further up -9 and closes those within it, an
unquoted value -6, an unterminated one -8, any `<?` but the declaration
-6); `<!x>` is an element; attributes need no space between them and
keep a name's first value; `&nbsp;` decodes, and `&#0;` is nothing; the
declaration and DOCTYPE are found in any case and toString writes them
first; `new XML(undefined)` parses nothing; an `XMLNode` without a type
and a value is no node; and the prototypes' properties are in Flash's
for..in order, XMLSocket's hidden. Up to SWF 5, where a string is bytes,
text loaded or received is its UTF-8's bytes, and `loadVariables` reads
Windows-1252.

### NetConnection

`NetConnection` (as Ruffle's) connects locally for `connect(null)`, at
once, telling `onStatus` `NetConnection.Connect.Success`, and to Flash
Remoting for an http or https URL; a new connection closes the one
before (`Connect.Closed`). Remoting calls are queued, and at the frame's
end each connection's go as one AMF0 packet POSTed to its URL with its
headers (`addHeader`, one of a name, its case aside); an answer's
`/n/onResult` or `/n/onStatus` goes to the n-th call's responder, and a
failed request tells nothing. The values are AMF0 as a .sol file's, but
a call's arguments share one table of references, the arguments' array
its first and a header's value its own first (adl, through a server it
POSTed to), an array of indices alone is a strict array, an XML node its
text, a date's zone 0, and a typed object goes by the name
Object.registerClass last gave its constructor. A value writes at most
2^20 values and cuts nesting at the reader's depth limit of 1,024, so a
script's length of 2^31 - 1 or a long chain cannot hang the page.

### Loading movies

`loadMovie`, `loadMovieNum` and `MovieClipLoader.loadClip` load a SWF or
an image into a clip or a level, and `unloadMovie` and `unloadClip`
empty one. The player keeps each AVM1 SWF it runs apart (`Avm1Swf`): its
blocks, library, frames, exports and the DoInitAction blocks it has run;
a queued action carries the SWF whose block it runs. Every SWF shares
the realm, `_global` and its classes among it, as Flash does, and
Object.registerClass binds a name for every SWF (the corpus's
`register_class`): in its case where the registering code is from
SWF 7, folded up to SWF 6, and looked up by the SWF of the clip.

A load goes through the host's fetch, as AS3's Loader's does ("content",
which allowNetworking "internal" allows and "none" refuses), the clip's
variables sent where a method is given. Its URL resolves against the
movie's base, whichever SWF asks, as Flash's plug-in resolves every
relative URL against the page's `base` or the page (the embedder's
choice, [web.md](architecture/web.md)), where AIR's adl takes the asking
SWF's; that URL, or the one a redirect took it to, is the loaded movie's
`_url`, its query included, and the one its access is checked by.
It arrives between frames, its images decoded and its code compiled.
Loads into one clip, or by one MovieClipLoader, arrive in the order
asked, as Ruffle's test runner has them, one slow to answer holding the
next two seconds at most; a second load into a clip replaces one under
way, which is neither read nor told of. As it arrives, as Ruffle has it:

- what the clip showed unloads, its unload events queued, its own
  variables go (a level 0's too), and a MovieClipLoader's listeners hear
  onLoadStart;
- a SWF, sniffed by its bytes and not its name, takes the clip's place
  as Flash keeps the clip: its name, depth, transform, clip actions and
  `_lockroot` stay, its timeline becomes the SWF's root's, entered as the
  next frame plays; the URL's query becomes its variables, and the
  listeners hear onLoadProgress and onLoadComplete(clip, status);
- a JPEG, PNG or GIF shows as a bitmap at depth 1 of the emptied clip, a
  movie of no version (`getSWFVersion()` -1);
- other bytes leave the clip in Flash's error state: no frames,
  `_framesloaded` -1, -1 bytes in all, no version; onLoadProgress(0, 0)
  and onLoadComplete; a missing file leaves it so too, with
  onLoadError(clip, "URLNotFound", status) and no more.

Each load that loaded has its loader's onLoadInit queued after the next
frame's clips have played, after the loaded movie's first frame's
actions, the latest load's first: the frame's queue runs out first, so
the frames its gotos entered have run their actions too (adl: a first
frame that sends a clip to a frame that stops it, then an onLoadInit
that sends it back to play, leaves it playing; Ruffle queues onLoadInit
before those frames, which stop it again). A clip removed before its load arrives
takes nothing; one unloaded meanwhile tells onLoadStart as it arrives,
and no more (adl's `load_cancel_*`, which Ruffle fails); one whose
listener removes or unloads it is told no more after that listener.

A clip's clip actions run by the version of the SWF that placed it, and
its AS2 event methods by the SWF it shows, or where that has no version
(an image, the error state, nothing) by the SWF that made it. Filling
level 0 makes the SWF the main one, whose version and length the movie
gives from then on.

A level is a clip on the stage at its number as depth; a load into a
level that is not there makes it empty at once, of the SWF whose code
asked. Its `_parent` is none, `_root` in its SWF's code is itself, its
`getDepth()` its number less 16384. Unloading a level, or the root of a
loaded SWF, waits for the next delivery between frames, as Ruffle's
`avm1_unload_movie` does; another clip unloads at once, to an empty movie
of its parent's SWF. `_url`, `getSWFVersion`, `getBytesLoaded` and
`getBytesTotal` are those of the SWF whose timeline a clip is in;
MovieClipLoader's `getProgress` gives the size as it came, compressed.
`_lockroot`, any value as a boolean, makes a clip `_root` for the code in
it, a SWF loaded into it among it, and stays across a load.

An ActionScript 3 SWF loaded by AS2 plays as AVM1, as Ruffle forces it:
its timeline plays, and none of its code runs.

### AVM1 and AVM2

An AVM1 SWF loaded by AS3 runs its actions in an AVM1 realm of its own,
its compiler, host services and LocalConnection broker the parent
player's; the pointer reaches its buttons and clips by AVM1's rules
(`input/avm1.ts`). Its `fscommand` and `ExternalInterface` reach the page
through the parent's bridge, beside the host's own calls and callbacks,
as the plug-in passed every movie's on; AS3 hears none of its
fscommands, as in Flash. It has no levels, as Flash Player 32's projector
traced it (`tests/unit/player/scripting/loads.test.ts`): its root is
`_root`, which is what it converts to and `targetPath` gives, its clips
`_root.a.b` and `_target` `/a/b`; `_level0` and every `_levelN` are
undefined, and the root has no `_parent`. Nothing loads into a level or
the root itself, or unloads it: `loadMovieNum`, `loadVariablesNum`,
`unloadMovieNum`, the root's `loadMovie`, `loadVariables` and
`unloadMovie` do nothing, and `MovieClipLoader.loadClip` into a level
gives false; `MovieClipLoader`, a clip's `loadMovie` and `loadVariables`,
and `LoadVars` load into its clips and objects. A `loadClip` into the
root gives true in the projector, which then traced nothing more, the
host's frames included; the player loads it. Not yet followed: Flash
gives the AS3 display list to the SWFs loaded into such a movie's clips,
whose `_level0` is the host's root, a MovieClip to them, with its
children by name (the corpus's `avm2/avm1_root`), and the path of a clip
a MovieClipLoader loaded into runs through it,
`_level0.loader.movie.clip`, the root's own `_parent` then becoming its
Loader.

`LocalConnection` carries messages from AVM1 to AVM1 and between AVM1
and AVM2 within a player. Names are case-insensitive; a leading
underscore opts out of the domain prefix. `send` copies its arguments
into AMF0, keeping references and cycles, and queues the delivery;
arguments over 40 KiB give false. Under an AS3 host, AS3's and its
movies' deliveries share one queue, which delivers up to 16 a frame, so
that a message a handler sends arrives in the same frame unless a chain
keeps sending (`Loads.deferLocal`): Flash delivers as it polls, in real
time, which adl shows as a median of 10 to 25 a frame at 30 fps and
Flash Player 32's projector as 2 to 4, so the tests trace no frame
numbers for it. A standalone AVM1 player delivers on its network's
queue, the next frame. AS3 sends AMF3, which the broker turns into AMF0
only for an AVM1 receiver, so AS3-only types survive between AS3 peers.
The receiver's methods, `allowDomain`, `allowInsecureDomain` and
`onStatus` run in the receiver's or the sender's own activation, and the
actions they queue run after them, as the frame script of a
`gotoAndStop` in a handler runs at once in adl and the projector; the
status says whether a listener was found, even where its domain callback
refuses the call, which is asked of the sender's domain whether it is
the receiver's or not. A method the receiver lacks, or a property that
is no function, is passed over in silence; in AS3, what the method
throws, or a sealed client's #1069, is an AsyncErrorEvent. A movie an
AS3 Loader unloads keeps its connections, as Flash Player 32 and adl
keep them even after `unloadAndStop`, a removal and a collection: it
plays no more, but takes messages and answers them, its sends' onStatus
comes, and its names stay taken until it closes them or the player ends;
a send still to be delivered keeps it too, as a movie unloaded by the
first of its two messages still delivers the second
(`Avm1.unloadFromLoader`; the `avm1-local-connection` case). Then, or
once it stops for good, it is destroyed, its code let go of. Connections
are not shared with other tabs or applications.

### PrintJob

`PrintJob` (as Ruffle's) prints nothing: `start` gives false, as Flash
does where the user cancels its dialog, so `addPage` gives false and
`send` does nothing. Its methods are SWF 7's, and up to SWF 6 its
prototype's `__proto__` is hidden too, so that it inherits nothing, not
even `toString` (adl: the object traces as `[type Object]`). The first
job made adds the page's and paper's measures to the prototype, listed,
over what a script set there, and no later job again: a job's are 0,
unchanged by a set, anything else's undefined (adl).

## Testing against Flash

- **Ruffle's corpus**: `avm1/` has 715 tests at the pinned commit, all
  with Flash's `output.txt`; 66 have recorded input, which `replay.ts`
  plays, and 41 are Ruffle's own known failures. Most were built by
  Flash's authoring tool at versions 4 to 10, as content was; some 250
  are version 15, built by other compilers. `pnpm corpus` runs them in
  Chrome, the trace compared line by line, each test's standing in
  `baseline.json`, which a change may not lower. The runner stops a
  test's script at its script timeout, as Flash would, so a test that
  loops forever on what the player lacks still ends.
- **adl**: the harness loads a SWF with a `Loader`, so an AVM1 SWF runs
  as an `AVM1Movie`, and adl prints its AVM1 traces with AS3's, given two
  frames at least: adl prints nothing of the movie's first frame until
  its second, which prints both frames' traces, and from there a frame
  each, so a test of one frame takes two (`check-references.ts`, and
  `run.ts --update` for a case). A player case of its own is an AVM1 SWF
  assembled from actions (`tests/avm1-assembler.ts`), or AS1 source
  (`tests/player/avm1/*.as`) that a small compiler in the tests
  (`tests/avm1-script.ts`, without classes or `try`) turns into what
  Flash's own compiler writes: a constant pool, batched pushes, and from
  SWF 7 DefineFunction2 with its preloads and variables in registers.
  Actions no compiler writes stay assembled by hand. An AS2 compiler in
  the oracle's image (MTASC, or Ruffle's test compiler) would let cases
  use AS2's classes. What only a main AVM1 SWF shows, `_level0` as the
  root of the stage or `Stage.width`, comes from the corpus.
- **Conformance**: semantics with no display get unit tests in node,
  their expected output from a corpus test or an adl case; avmshell runs
  no AVM1.
- **The compiler**: `tests/fuzz/avm1.ts` fuzzes the decoder and the
  emitter (mutated blocks never trap, their modules import, each block
  alone is its entry); `tests/unit/codegen/avm1-emit.test.ts` runs
  modules with a stub runtime that records its calls; and `pnpm
  determinism` compiles the tests' blocks, and the corpus's AVM1 SWFs
  where it is fetched, in each of its orders, each block alone and in
  its module.

## Code taken from other implementations

Where a file takes code from another implementation it keeps that code's
licence and copyright header at its top, as
`as3/playerglobal/src/flash/net/XMLSocket.as` does, and the file says what
it took. Nothing of avmplus goes into an Apache-2.0 file; avmplus has no
AVM1, so nothing is expected from it.

- **Ruffle** (`core/src/avm1/`, `swf/src/avm1/`; MIT or Apache-2.0): the
  primary reference for what each action and builtin does by version,
  its event and queue order and its loads. Its code is Rust, so what
  swf2es takes is the algorithm and its tables, translated, under its
  header. Some of its globals are AS1 source (`globals.as`,
  `AsBroadcaster.as`, `Error.as`, `flash/geom`'s), compiled into its
  build; swf2es writes those in TypeScript.
- **AwayFL** (`@awayfl/avm1`; Apache-2.0, much of it Shumway's, Copyright
  Mozilla Foundation): TypeScript to start from where it is not bound to
  its interpreter or its scene graph, such as its conversions, property
  bag, builtins, geometry classes, `XML` and `LoadVars`. Its interpreter,
  path resolution and display classes carry fixes for particular content
  and are not taken; a file taking from it keeps Mozilla's header and
  adds AwayFL's notice.
- **Flash Player**, through the corpus and adl, decides where they differ.

## Known gaps

- **AS3 and AVM1 together.** `AVM1Movie.call` and `addCallback` throw
  #2014 (the corpus's `avm2/avm1movie_addcallback_call`; the
  `avm1-movie` case is to be recorded again with adl once they work).
  An AS3 SWF that AS2 loads runs none of its code.
- **Modules.** The player compiles AVM1 itself: the IndexedDB module
  cache and precompiled modules do not take AVM1 modules, though
  `swf2es compile` writes them.
- **The compiler.** No structured output, registers for stack slots,
  local variables as `let`s (in a function that names all its variables
  with constants and has no `eval`, `with` or nested function), or
  inline caches for names; each is to be measured on the corpus's
  heaviest SWFs and kept only for a gain that repeats.
- **Loading.** Flash's loading state between the call and the arrival
  (`_currentframe` 0: the corpus's `movieclip_state_values`); a load into
  level 0 keeps the first SWF's stage size and frame rate, where Flash
  and Ruffle take the new main movie's; the per-version prototypes and
  `_global`s a SWF of one version sees of another (`global_swf6_7_8`);
  ImportAssets; `onLoadProgress` while a SWF streams in, and
  "LoadNeverCompleted", which a fetch of all or nothing never gives;
  `System.useCodepage`'s guess of a file's encoding.
- **Classes and natives.** `System` has no `IME`, `setClipboard`,
  `showSettings` or `Product`, and `useCodepage` changes nothing; no
  `Video`, `NetStream`, `Camera`,
  `Microphone`, `ContextMenu` or `Accessibility`; ASnative's display,
  text, sound and I/O tables give functions that do nothing, and
  `ASconstructor` is left out. Button's prototype has only `enabled`,
  `useHandCursor`, `getDepth` and, from SWF 8, `filters`, `blendMode`
  and `cacheAsBitmap`.
- **Display.** `duplicateMovieClip` copies no drawing a script made and
  no text field's properties; Stage's scale mode, alignment, full screen
  and resize events are not there; `PrintJob` prints nothing.
- **Input and text.** Touches reach only an AS3 movie's pointer.
  `onScroller` from the user, `asfunction:` links, the HTML of SWF 6 and
  7 fields as Flash reads it, and layout metrics (`textWidth`,
  `maxscroll`) where AS3's fields part from Flash's too; TextSnapshot's
  selection, `hitTestTextNearPos` and `getTextRunInfo` do nothing.
- **The corpus.** `mixed_avm/` (12 tests, AS3 loading AS2 and the
  reverse) and `from_gnash/` (404, Gnash's test suite for each class at
  SWF 5 to 8, many of them Ruffle's known failures) are not run, and the
  16 tests with `[approximations]` compare exactly, their tolerance
  unread.
