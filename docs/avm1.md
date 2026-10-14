# AVM1

The plan for ActionScript 1 and 2 in swf2es: what AVM1 bytecode is
compiled to, where each piece lives, and the pull requests that get it
there. Steps 1 to 3 are built: `format`'s list of action blocks, the
decoder and the emitter of the first actions; the rest is not. [architecture.md](architecture.md) describes what is, and this
document is folded into it as each piece lands.

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
and a record that runs past its tag stops the whole SWF as Flash reaches
the tag, every timeline of it, none of the place's records run. Such a tag
has no blocks and is in the list's `corrupt`, for the player to stop the
SWF there (step 11). A malformed button action keeps the records before
it; adl defines the button, and whether those run there is not checked
yet (step 12). The list has the blocks of an ActionScript 3 SWF too,
whose FileAttributes flag says it runs none of them.

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
  each). A region is the same for every `DefineFunction` of the same
  bytes, so a body that jumps back before its own `DefineFunction` defines
  itself again: regions form a graph, cycles included, and the emitter
  writes each once, not inlined into its parent. A target before the
  block's first byte is taken as the block's exit; adl, as Ruffle, runs
  the SWF's bytes before the block there, which a block compiled alone
  does not have. The constant pool is tracked along
  the flow: where one `ConstantPool` reaches a `Push` on every path, its
  strings are literals, and a constant past the pool's end `undefined`, as
  Ruffle pushes it; where none or several may, the push reads the
  activation's pool at run time, `cx.pool[i]`, which `V.constantPool`
  sets as the action runs. A region starts with the activation's pool,
  which for a frame's block is the movie's, the last any block set, and
  so does a `Try`'s catch or finally, which a throw reaches from anywhere
  in the try body (`flow/pool.ts`).

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
  blocks, where the emitter drops what is no longer held.
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
- **With**: the object goes on the activation's scope chain with the
  body's bounds, and comes off at the first block outside them, however
  control got there. A `with (undefined)` or `null` skips the body, in
  adl as in Ruffle (`action_with`): the action's length covers its body,
  so the code after it goes on past it.
- **Try**: a handler goes on the activation with the try and catch
  bodies' bounds, and comes off as a With's scope does; the dispatcher's
  loop runs in a JavaScript `try`/`catch`. `Throw` throws the runtime's
  `Avm1Throw` with the value; a throw in the try body with a catch sets
  its register or variable and goes on at the catch's bytes. A throw in
  the try body without a catch, or in the catch body, goes on at the
  finally's bytes and throws again as control leaves them, even by a jump
  (adl); without a finally it goes on to the handler outside. Leaving a
  try or catch body by a jump runs no finally. An error of the host's, a
  bug, passes through.
- **Return** returns from the function's region; in a frame's block it
  ends the block. Every region ends in `return`.

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
`Jump`, `If`, `Play`, `Stop` and `End`. Every other action Flash knows,
and a `Push` of a register, is `V.notYet("<name>")`, which throws, so
the steps after fill them in one at a time; an unknown opcode is
skipped, and an action Flash cannot read is `V.halt(cx)`. A block the flow finds too large is `V.tooLarge()`.

### Version-dependent semantics

What an action does depends on the version of the SWF whose code runs it,
not the version of the objects it touches: `Add2` of `undefined` is `0` up
to SWF 6 and `NaN` from 7, `ToString(undefined)` is `""` up to 6 and
`"undefined"` from 7, names are case-insensitive up to 6, a string is
true by its number up to 6 and by its length from 7, SWF 4's `Equals` and
`Less` push 1 and 0 where SWF 5's push booleans. A module is compiled for
its SWF's version, so the emitter picks the operations then: `rt.version(v)`
gives a table of the operations for versions like `v`, `V.add2`,
`V.equals2`, `V.toString`, `V.getVariable`, made once per version and
shared, so a call site sees one function, never a version test. The
corpus's version-specific quirks, each in Ruffle with a test, come with it:
SWF 4's `Divide` by zero pushes `"#ERROR#"`, `-0x10` is `NaN` while `0x10`
reads as hex from SWF 6, `NaN == NaN` holds in `Equals2` (Flash Player 7's behaviour, which the
corpus records, whatever the SWF's version), `>>>` is signed in
SWF 8 and 9, `SetTarget2(undefined)` resets the target differently up to
SWF 6, and `this` is case-insensitive up to SWF 5. Where an
action's behaviour does not depend on the version, the emitter writes it
inline (`ActionNot` of a boolean, `StringLength` of a literal).

### Functions and registers

`DefineFunction` and `DefineFunction2` make a function object whose code
is a region compiled as an entry of its own in the module, `F[k]`,
`function (cx, self, args) { ... }`, not a JavaScript closure: an AVM1
closure captures the scope chain, which the function object keeps, so
the entry needs nothing of the JavaScript frame it was defined in, and
each entry is written alone, as the JIT/AOT invariant asks of AVM2's
methods. The function object also keeps the constant pool of the
activation that defined it.

A DefineFunction2's registers below its register count are JavaScript
`let`s, `r1` to `rN`, since their indices are in the code: its preloads
(`this`, `arguments`, `super`, `_root`, `_parent`, `_global`, in that order
from `r1`, each skipped where its flag is clear and the suppress flags
leave the name out of the activation) and its parameters with a register
are set on entry, the rest of its parameters are local variables. A
register at or past the count, and every register of a frame's block or
a DefineFunction's, which have none of their own, is one of the four the
movie's top activation holds, `cx.g[i]`, as Ruffle has it.

Local variables (`DefineLocal`, a parameter without a register) live on
the activation's scope object, since `eval` and `GetVariable` of a computed
name can reach them; a later step can make them `let`s in a function that
names all its variables with constants and has no `eval`, `with` or nested
function.

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
which `numbers.ts` writes, apart from AS3's avmplus-derived one.

### Objects

An `Avm1Object` keeps its properties in a property map of its own, in the
order they were added: each property with its value or its getter and
setter (`addProperty`), its attributes (`ASSetPropFlags`: don't enum,
don't delete, read only, and the version flags that hide a builtin from
SWFs before the version that introduced it) and its watcher (`watch`).
Lookups take the caller's case sensitivity, so a SWF 6 and a SWF 7 that
share an object each find names as their version does; the map keeps a
lower-case index besides the exact names, as Ruffle's `PropertyMap` does.
`__proto__` is the prototype, `__resolve` is asked for a name the chain
lacks, and `for..in` (`Enumerate`, `Enumerate2`) visits names in Flash's
order, which the map's order of insertion gives, as in Ruffle.

A function is an `Avm1Function`, an object with its compiled entry, the
scope chain and constant pool it captured, and its `prototype`. From SWF 6
a function closes over the scope it was defined in; a SWF 5 function does
not, and runs in a scope made from its `this`'s clip, as Flash 5 did; a native
function is one whose entry is TypeScript. `new` makes an object whose
`__proto__` is the constructor's `prototype`, then calls it; AS2's
classes, which the AS2 compiler turns into prototypes, `Extends`,
`ImplementsOp` and `CastOp`, need nothing more.

### Scopes, targets and names

An activation's scope chain is a list, searched from the top: a frame's
or an event's block has the clip it belongs to above `_global`; a
function has its own activation object above the chain it captured; a
`With` puts its object above either. The activation also has a
**target**, the clip that timeline actions (`Play`, `GotoFrame`,
`GetProperty` with an empty path) act on and names without a path
resolve in. It starts as the clip the code belongs to, `SetTarget` and
`SetTarget2` (`tellTarget`) change it, and a `SetTarget` of `""` gives
back the original, which the activation keeps for that.

`GetVariable`, `SetVariable`, `GetProperty`, `SetProperty`, `CallFunction`
and `eval` take names that may be paths: `/a/b:x` (slash syntax, SWF 4),
`_root.a.b.x`, `_level1.a`, `../x`, `_parent._parent.x`, or `this.x`. The
runtime splits a name into its path and its last part once, kept in a
cache by string, since the same names come again and again, and asks the
host to resolve the path from the target to a display object (the player
walks its children by name, case-insensitively up to SWF 6). A name
without a path walks the scope chain, top down. A clip's properties
`_x` to `_ymouse` are also reachable by index (`GetProperty` and
`SetProperty`'s 0 to 21), from a table shared with `globals/MovieClip.ts`.

### Builtins

The language's classes are the runtime's, written in TypeScript as
AVM2's natives are: `Object` (but `registerClass`, which binds a symbol
and is the player's), `Function`, `Array`,
`String`, `Number`, `Boolean`, `Math`, `Date`, `Error`, `AsBroadcaster`,
and the global functions (`parseInt`, `parseFloat`, `isNaN`, `escape`,
`ASSetPropFlags`, `setInterval` through the host's clock). Each is
installed on `_global` with the version flags Flash gives it, so a SWF 5
does not see what SWF 6 added.

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
timeout (a block that loops forever hangs the page), and structured output and stack registers in the compiler.

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
  first baseline records them all failing. `mixed_avm/` (12 tests, AS3
  loading AS2 and the reverse) and `from_gnash/` (404) join later. The tests with `[approximations]` (16) compare numbers within
  their tolerance once the runner reads it.
- **adl**: the harness loads a SWF with a `Loader`, so an AVM1 SWF runs
  as an `AVM1Movie`, and adl prints its AVM1 traces with AS3's: the
  corpus's `looping_real_1_declared_1`, `undefined_to_string_swf6` and
  `call_method_empty_name` trace their `output.txt` exactly under adl,
  given a frame more than their `num_frames`, as the AVM1 movie runs its
  frames one late in a `Loader`. A player
  case of its own (`tests/player/cases.ts`) is an AVM1 SWF the test
  assembles from actions, through a small assembler in the tests
  (`tests/avm1-assembler.ts`), traced and drawn by adl with `--update`.
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

- **Writing AVM1 test cases.** Nothing in the repository compiles AS1 or
  AS2. The tests assemble actions (`tests/avm1-assembler.ts`);
  an AS2 compiler in the oracle's image (MTASC, or Ruffle's test
  compiler) would let cases be written as source instead.
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
   `check-references.ts` gives an AVM1 SWF its frame more. Passes the
   corpus's `looping_real_1_declared_*`, a constant traced from a frame
   script. Verified: the corpus, and an adl case of a trace in each of two
   frames and a `stop`, assembled by `tests/avm1-assembler.ts`.
5. **Arithmetic, comparison and strings, by version.** `Add`, `Add2`,
   `Equals`, `Equals2`, `StrictEquals`, `Less`, `Less2`, `Greater`, the
   bitwise and string actions, `ToNumber`, `ToString`, `TypeOf`;
   `numbers.ts`'s number formatting and string-to-number, each per
   version. Passes `add`, `add2`, `add_swf4`, `add_swf5`, `swf4_bool`,
   `swf4_actions_bool`, `equals*`, `lessthan*` and `undefined_to_string_swf6`;
   unit tests per version from their traces, `f64_to_string`'s cases among
   them.
6. **Variables, objects and the global object.** `Avm1Object` and its
   property map with case sensitivity by version, `GetVariable`,
   `SetVariable`, `DefineLocal`, `GetMember`, `SetMember`, `Delete`,
   `InitObject`, `InitArray`, `Enumerate`, `_global`, `Object`,
   `ASSetPropFlags`, `addProperty`, `watch` and `__resolve`. Passes
   `new_object_wrap`, `init_array_invalid`, `watch*`, `prototype*`.
7. **Functions.** `DefineFunction`, `DefineFunction2` with registers and
   preloads, `CallFunction`, `CallMethod`, `NewObject`, `NewMethod`,
   `Return`, `arguments`, `super`, `Function.call` and `apply`, recursion's
   limit, SWF 5's functions without closures. Passes `call_method_empty_name`,
   `define_function_case_sensitive`, `define_function2*`, `define_local*`,
   `register_underflow`, `register_globals_across_frames`, `this_swf5` to
   `this_swf7`; determinism of function entries compiled alone.
8. **`With`, `Try` and `Throw`.** Regions entered and left as Flash runs
   them, `Error`. Passes `with`, `with_return`, `with_variable_scopes`,
   `try_catch_finally`, `try_catch_stack`, `try_finally_simple`; an adl
   case for a jump out of a `with` body and back before its start.
9. **The language's classes.** `Array`, `String`, `Number`, `Boolean`,
   `Math`, `Date`, `AsBroadcaster`, `Extends`, `InstanceOf`, `CastOp`,
   `ImplementsOp`, the global functions. Corpus tests of each; the
   largest step, and may split by class.
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
