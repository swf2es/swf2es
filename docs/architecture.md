# Architecture

swf2es plays SWF files in the browser and compiles their bytecode to
JavaScript. It has one compiler, which runs at two different times:

- **JIT**: the browser player runs `@swf2es/codegen` when a SWF loads. Each
  method is compiled on its first call, in a worker pool, off the main thread.
- **AOT**: node (or a server) runs the same compiler ahead of time and caches
  the result.

The compiler is written in AssemblyScript and ships as `codegen.wasm`, with
a thin TypeScript wrapper. The one wasm binary runs in browser workers, in
node, and in any server-side wasm runtime (for example wazero in a Go
server), so there is only one implementation to keep correct. It uses
AssemblyScript's minimal runtime, whose garbage the wrapper collects between
calls (see [benchmarks.md](benchmarks.md#the-assemblyscript-runtime)).

The wrapper's `Codegen` (`createCodegen` in `packages/codegen/src`) is the
compiler's whole API: `reset` starts a domain, `add` links an ABC into it
after those before, and the last one added compiles with `compile`, whole,
to its module, source map and the entry of each method, or with
`compileMethods`, a method at a time as the JIT compiles each on its first
call. Both go through `assembly/compile.ts`, which the test build
(`assembly/testing.ts`, with the reader, verifier and emitter exposed for
the node tests) exports too, so the tests exercise the code that ships, and
the determinism check compiles every chain through both builds.

## The JIT/AOT invariant

For the same input, both modes must produce byte-identical output. That
requires:

1. **Compilation is pure.** `format` and `codegen` use no DOM or node APIs, no
   clock and no randomness. Their tsconfigs load no DOM or node types, so the
   build rejects such code, and a unit test fails if `codegen.wasm` imports
   anything besides `env.abort`.
2. **The unit of translation is one method.** A method's output depends only on
   its ABC and the ABCs it is linked against, never on which other methods
   were compiled before it.
3. **Both modes use the same facts.** Optimizations use only what the ABC being
   compiled proves (final classes, sealed traits, typed slots). Anything that
   can change at runtime, such as a child SWF redefining a class, gets a
   runtime guard in both modes.
4. **Shared cache key.** Output is keyed by `COMPILER_VERSION`, the ABC's
   hash, and the hashes of the ABCs loaded before it, in order (`cacheKey()`
   in codegen), so the browser cache, AOT output served by a server, and JIT
   output are interchangeable. An ABC's layouts depend on those it links
   against, since its slot and dispatch ids follow its base classes', so a
   module also records their hashes and the runtime refuses it when the
   ABCs loaded before it differ.

CI checks both (`pnpm determinism`, `tests/conformance/determinism.ts`),
over the builtins, then each conformance case (also compiled with asc's
`-d`, for source maps) and as3pb:

- **Determinism:** each compiles to the same modules and source maps, byte
  for byte, in a compiler instance of its own, in one instance after the
  others, in the reverse order twice in a row, and in the build that checks
  every array access, so that nothing the compiler keeps between calls,
  such as its reused buffers, leaks into its output.
- **The JIT/AOT invariant:** each method compiled alone, as lazy JIT will
  compile it, is byte for byte its entry in its module: in order with a
  new emitter each, and in the reverse order with one emitter for all.
  Everything a method's code refers to is indexed by its ABC (multinames,
  namespaces, functions, descriptors), but for the classes and Vectors it
  refers to, which it has in a table of its own, numbered as it first
  refers to each (`((...T) => (scope, sup) => function ...)(rt.cls(...))`).

## Packages

| Package   | Responsibility                                                  | May depend on             |
|-----------|-----------------------------------------------------------------|---------------------------|
| `format`  | SWF container and tags, ABC, AVM1 action records                | —                         |
| `codegen` | bytecode → IR → ES modules, in AssemblyScript (`assembly/`)     | format                    |
| `runtime` | AS3/AS2 language semantics called by generated code             | format                    |
| `player`  | display list, timeline, playerglobal, AVM1 globals, renderers   | format, codegen, runtime  |
| `cli`     | ahead-of-time compiler command                                  | format, codegen           |

`runtime` contains only the language, with no display list, so it runs in node
next to avmshell. It uses `format` for what both need, such as compression
(zlib through pako, LZMA through lzma1): ByteArray's `compress` and a SWF's
body are the same code. `codegen` knows the runtime's function names and signatures
but never imports its implementation. pnpm only links the packages each
`package.json` lists, so the build rejects undeclared imports, and
`tests/unit/boundaries.test.ts` checks the declarations and the tsconfigs.

## Parsing, linking and verifying

avmplus checks an ABC in three places, and swf2es checks it in the same
three, with the same VerifyError numbers:

1. **Parsing** (`codegen/assembly/avm2/abc`): everything avmplus rejects while
   parsing that one ABC can decide on its own: counts, pool indices, trait
   kinds and names, class order, a method bound to two owners.
2. **Linking**, when classes are defined: anything that needs classes from
   other ABCs or playerglobal, such as base classes, interfaces, overrides
   and name clashes.
   The ABCs loaded together form a domain (`codegen/assembly/avm2/link`), which
   interns strings and namespaces across them and finds script definitions
   by qualified name. Builtin ABCs mark their namespace URIs with the API
   version that introduced a name; as in avmplus, user code sees the names
   of its own version and series (Flash Player's by default), so AIR-only
   and VM-internal names stay hidden. While an ABC loads, its classes link
   to base classes and interfaces defined by earlier ABCs' scripts or by
   its own earlier classes, as avmplus' `AbcParser` links them.
   Each class's, script's and activation's traits then lay out their
   members, binding names to slot and dispatch ids after their base's
   (`link/traits.ts`). Types resolve later, when a class is first used:
   slot types, method signatures, and the override and interface checks
   that compare them. A type is the id of a traits, including void and
   null, or `*`.
3. **Verifying a method**, when it is first compiled: its signature's types
   and its bytecode.

An ABC with errors in more than one stage may report a different first
error than avmshell. Well-formed ABCs are unaffected.

## Compiling a method

Each method goes through the same steps, in `codegen`:

1. **Decode** (`abc/code.ts`): the reachable instructions, as the avmplus
   verifier reads them.
2. **Verify and build the IR**, as avmplus' `Verifier` does its checks,
   with its VerifyError numbers. A first pass keeps a frame state per block
   (the locals, scope stack and operand stack, each value with its type,
   whether it is known not null, and whether it is a with scope), merges it
   where control flow joins, and walks a block again when its entry state
   changes, until none does. A second pass walks the blocks in code order
   with their final states; there `newclass` and `newfunction` capture the
   scope chains the methods they create run in, and the same pass will
   write the IR, so what is compiled is exactly what was verified. An ABC's
   methods are verified from its scripts outward, as each becomes
   creatable; methods nothing can create are never verified, as in avmplus.
   Where avmplus changed after the oracle's avmshell was built, swf2es
   follows the newer Flash Player: since PSIRT 3037, a method that can
   throw into a handler needs `max_stack` of at least 1, which the
   oracle's avmshell does not check.
3. **The IR** (`ir/ir.ts`) is register form with types, not SSA. A
   register is an index into the verifier's frame: locals `l_n`, then scope
   entries `sc_n`, then stack slots `s_d`, so `getlocal1; getlocal2; add;
   setlocal3` is `s0 = getlocal1 l1; s1 = getlocal2 l2; s0 = add s0 s1;
   l3 = setlocal3 s0`. An instruction reads consecutive registers and
   writes one, with the verifier's type there (`int`, `uint`, `Number`,
   `Boolean`, `String`, a class, `null`, `*`) and whether it is known not
   null. Each block keeps its entry state, so a lowering can follow every
   register's type: `add` then `convert_i` on two `int`s is `(a + b) | 0`.
   The instructions are what avmplus' verifier tells its code generator:
   the ABC instruction, or the verifier's decision made explicit, as a
   slot bound early (`getslot`), a method called by dispatch id
   (`callmethod`), where a name was found (`getscopeobject`,
   `getouterscope`, `finddef`, the global scope), and every coercion and
   null check. V8 does SSA-level optimization on the JavaScript anyway.
   The tables are flat, like the parser's, and reused across methods.
4. **Control flow.** First a per-method dispatcher
   (`for (;;) switch (block) { ... }`), which handles any control flow,
   irreducible or obfuscated included. Then structured JavaScript (loops, `if`,
   labelled `break`) from the dominator tree for the reducible code compilers
   emit, falling back to the dispatcher. Conformance tests check that both
   give the same results.
5. **Emission** writes JavaScript as UTF-8 into a growable byte buffer: no
   JavaScript strings, and names are copied straight from the ABC.

### Generated code

Each ABC compiles to one ES module. Every method becomes a JavaScript
function whose registers are `let` variables, and whose blocks are
structured JavaScript, as Norman Ramsey's "Beyond Relooper" translates a
reducible control-flow graph by its dominator tree:

- a loop header (the target of a back edge) is `L3: for (;;) { ... }`;
- a merge node (more than one forward edge in) is a labelled block,
  `L5: { ... }`, followed by its own code;
- a branch to a loop header is `continue L3`, to a merge node `break L5`,
  and to a block it is the only way into, that block's code in place;
- every path ends in a branch, return or throw, so nothing falls out of a
  loop or through a case.

A block starts only where something branches to, so a conditional branch
may be in the middle of one; it is then an `if` whose body branches, and
the block goes on after it.

An exception handler's block counts as entered from every block its
range covers, so it is a child of the block that dominates them all, and
is written as a merge node is, with a `try` inside the labelled block:
`L7: { try { ... } catch (e) { ...; break L7; } }`, then the handler's
code; how its `catch` finds the handler is below.

Where that translation does not apply, a dispatcher runs the blocks:
`for (;;) switch (b) { case 0: ...; b = 2; continue; }`. It handles any
control flow: an irreducible graph (a loop entered in more than one
place), or handlers whose `try`s cannot enclose the code they cover, in
the order avmplus looks for them. With handlers, the whole loop is in
`try`/`catch`; the catch picks the handler covering the throwing
instruction, matches the exception's type, and continues at its block
with the exception as the only stack value, or rethrows.

Stack registers that only copy a local are not written: a `getlocal`
leaves its stack register a copy, read as the local itself, until the local
changes or a branch needs the stack as it is. A value the next instruction
only moves to a local (a `setlocal`) goes to the local straight, and a
conversion that changes nothing writes no code.

Each module has a source map (version 3) from the ABC's `debugfile` and
`debugline`, where an ABC compiled with them has them (asc's `-d`): the
method emitter marks where the code for each AS3 line starts as it writes
it, and the map finds the marks' lines and columns in the module. A block
starts with the line the instructions before it in the ABC left, and code
after a block written in place inside another goes back to the other's.
With it, stacks name AS3 lines and a debugger steps through the AS3;
`node tests/conformance/debug.ts <case> --lines` compiles a case with `-d`
to try it.

The IR's types decide the JavaScript from the start where that is simple:
`int` arithmetic ends in `| 0`, `uint` in `>>> 0`, a slot bound early is a
field access, a method bound early a direct call, a coercion to a class
`rt.coerceTo` (no builtin for the runtime to look for), and a typed
Vector's element `rt.vectorGetInt` and the like, one for each kind of
element, so that each sees one kind of array. Anything typed `*` goes
through the runtime, which does what avmplus does at run time.

### The object model

An AS3 object is a JavaScript object made from its traits' prototype,
which `newclass` builds from the module's layout:

- **Slots** are fields named by slot id (`$0`, `$1`, ...), set to their
  initial values when the object is made, so an early bound slot is one
  property access and cannot collide with any dynamic name.
- **Methods, getters and setters** are on the prototype, named by dispatch
  id, so `callmethod` is a direct call and overriding is JavaScript's own
  inheritance.
- **Dynamic properties** of dynamic classes live in their own map, apart
  from slots and methods.
- **Names**: each traits has its own bindings by namespace and name, and
  a lookup goes on to its base's, as avmplus' does. The runtime's multiname
  lookup (getproperty, setproperty, callproperty with a name that did not
  bind early) searches as avmplus does: bindings, then dynamic properties,
  then the AS3 prototype chain, which each object reaches through `$p`.
- **A class object** is an instance of its static traits, whose base is
  Class's instance traits; it holds its instances' traits (`$it`) and its
  AS3 `prototype`. Class is dynamic, so class objects are, as the builtins
  need (`String.fromCharCode = function ...`).

Values are JavaScript's own: `undefined`, `null`, numbers for `Number`,
`int` and `uint`, booleans, strings. A namespace value is the runtime's
interned namespace, whose class is Namespace. Arrays and Vectors keep their
elements in a JavaScript array, `$a`. A script's global object is an instance of its traits like any
other. Errors thrown by the runtime are AS3 `Error` objects with avmplus'
error numbers. Their messages are the release player's, as avmshell's
are: `Error #1009`, and nothing more, since AS3 can read and print them.
With the runtime's `debugger` option they are the debugger player's,
`Error #1009: Cannot access a property or method of a null object
reference.`, and `System.isDebugger` is true.

### Modules and the bootstrap

The compiler computes every traits' layout, so a module states it and the
runtime never derives one. An ABC's module exports a function of the
runtime, `rt`, that returns:

- **names**: the ABC's namespaces and multinames as runtime objects,
  interned by the compiler's rules (kind and URI, API version, a private
  namespace per ABC entry);
- **methods**: a factory per method, `(scope, sup) => function (...) { ... }`,
  so that each `newclass` or `newfunction` binds the scope chain it
  captured, and a class's methods the base class their super instructions
  use;
- **traits**: for each class, its base class and interfaces by name,
  resolved when the class is created as avmplus resolves them, its own
  bindings by namespace and name, its slots' defaults, and its methods,
  getters and setters by dispatch id;
- **scripts**: each script's traits and initializer, run the first time
  something asks for a name it defines, as avmplus runs them.
- **hash** and **linked**: the hash of its ABC and of the ABCs loaded
  before it, in order, as the cache key names them. Its layouts depend on
  those ABCs, so the runtime refuses to load it after any others.

The runtime starts with builtin.abc, then the ABCs that follow it (for
avmshell's programs, shell_toplevel.abc):

1. make the traits of Object, Class and Function, empty, before any module
   loads: global objects and class objects are made with them as their
   bases before their classes exist;
2. load the builtin modules: their scripts' names become visible, and
   nothing runs;
3. run a script the first time a name it defines is looked up (`finddef`,
   `findpropstrict`, `getlex` of a global name, a coercion to a class) and
   the entry point, the last script, of each module that is not a builtin,
   as avmshell does.

The first lookup of any builtin name runs the builtin script that defines
Object, Class and Function. Its `newclass` of Object fills in Object's
traits; class objects made before Class exists already inherit from
Class's traits, so they see its bindings and prototype once it does. A
coercion to Object, Class or Function checks against their traits, so it
works while they are being made, as avmplus' does.

A native method is bound by its class's and its own qualified name, as
avmplus binds its C++ ones: `"Math.floor"` for a static method,
`"String#indexOf"` for an instance method, and the name alone for a
script's function; accessors as `"get:"` and `"set:"` names, and a name
outside the public namespace with its namespace's URI, `"uri::name"`. A
native the runtime lacks throws an error naming it when called, not when
loaded.

Generated methods follow one calling convention. A slot is the field `$n`,
by its slot id from 0, and a method, getter or setter is `$mn` on the
prototype, by its dispatch id; dynamic properties are kept apart from
both. A method of a primitive receiver is called through its class's
prototype, `rt.prototypeOf(int).$mn.call(x, ...)`. A method's own scope
registers and the chain it captured are passed to the runtime together
when it looks a name up or creates a function or class, with a bit per
scope for the with scopes.

In a method with exception handlers, the handlers' ranges split the code
into regions, and the variable `t` holds the region of the instruction
running, set only where it changes. Each handler's `try` encloses the code
its range covers, and maybe other code; its `catch` takes the exception
only if `t` is one of its regions and the exception's type matches, and
otherwise rethrows it to the next `try` out. The `try`s covering each
region are open innermost first in the order of the ABC's table, so the
handler that gets an exception is the first in the table that covers the
instruction and matches, as avmplus finds it. It gets the exception as its
only stack value; with no match, the exception goes on to the caller. The
emitter checks that order as it writes each block, and writes the method
with the dispatcher where it does not hold: one `try`/`catch` around the
loop, whose `catch` tries the handlers covering `t`'s region in the
table's order and goes on at the first match's block.

### The runtime and the standard library

Generated code calls `@swf2es/runtime` for the object model, multiname
lookup, coercions and exceptions (`packages/runtime/src/avm2`); it grows as
far as each step needs. The engine is at the top: `runtime.ts`, `names.ts`,
`numbers.ts`, `messages.ts`, and `amf.ts`, which ByteArray and later the
player's networking use. The builtins' natives are in `natives/`, a file per
family of classes (`object`, `array`, `string`, `regexp`, `number`,
`vector`, `bytearray`, `date`, `json`, `dictionary`...), registered in
`natives/index.ts`, with what makes some builtin classes differ from others:
Arrays' and Vectors' element storage, and what calling or constructing
`int`, `String`, `Object`, `Array` or a Vector does. avmshell's own classes,
which a player has not, are in `natives/shell.ts`. playerglobal is the
player's (`packages/player/src/playerglobal/flash/display/...`, a path per
package, so a class's file follows from its qualified name). The debugger player's error messages are avmplus'
own, generated from its `ErrorConstants.cpp` into `messages.ts`, which
stays MPL-2.0.

Where avmplus' behaviour is its own algorithm rather than a language rule,
the runtime translates it, so that its output is avmplus' byte for byte:
number formatting (`numbers.ts`), Array's sort (`sort.ts`), ByteArray with
its capacity and UTF-8 (`bytearray.ts`), AMF3 (`amf.ts`) and JSON
(`json.ts`). These are MPL-2.0 as their sources are. Domain memory is
avmshell's `avmplus.Domain`'s: 1024 bytes of scratch memory until a
ByteArray is set as it. Date is JavaScript's Date, with avmplus' string
formats.

avmplus' standard library (`Object`, `Array`, `String`, `Math`, `Date`,
`RegExp`, `JSON`, `Vector`, `ByteArray` and so on) is mostly AS3 compiled
into `builtin.abc`; only its `native` methods are C++. swf2es compiles
`builtin.abc` itself and implements the natives in TypeScript, matched by
class and method name as avmplus matches its C++ ones. The standard library
never changes for a compiler version, so it is compiled once at build time
and shipped precompiled next to the runtime, keyed by its hash like any ABC.
Its AS3 sources are MPL-2.0: the compiled library stays MPL, in its own
package, with its source available. `playerglobal` (`flash.*`) is declarations
only, so the player implements all of it.

## The player

The player keeps Flash's display list and timeline (`packages/player/src`:
`timeline.ts` reads a SWF's definitions and frames, `display.ts` is the
display list), and PixiJS only mirrors it (`pixi.ts`): a container per
display object, kept from frame to frame and updated where the display
object marks itself changed. A shape's fills are immutable
`GraphicsContext`s shared by its instances, built from Flash's edges
(`shapes.ts`: each edge goes to its right fill forward and its left fill
reversed, joined into contours) and filled even-odd through a containment
tree of the contours, holes cut. Its lines are drawn for each instance, in
the stage's axes, because Flash strokes a transformed line with one width
all along, not the local width stretched by the transform.

Flash anti-aliases by supersampling on a grid: none at low quality, 2×2 at
medium, 4×4 at high and best. The test page draws the same way, at that
many times the resolution without multisampling, averaged down, and its
frames then match Flash's to the pixel for straight edges, and within a
quarter pixel's anti-aliasing for curved lines and lines under a skew.

### Scripts and the display list

An AS3 SWF's display objects are AS3 objects: a timeline child whose
symbol has a class (`SymbolClass`) is an instance of that class, the root
is one of the document class, and `new Sprite()` in a script is on the
display list once added. The player keeps one object with two faces, as
Ruffle and AwayFL do: the runtime allocates every instance of
`flash.display::DisplayObject` and its subclasses through a `create` hook
on that class (hooks' allocation is inherited through `Traits.create`),
which attaches a player `DisplayObject` as `$display`, and the player's
object points back with `object`. The natives of the display classes
(`packages/player/src/playerglobal/flash/display/...`) read and write
`$display`; an AVM1 movie's children, and a timeline child without a
class, have `object === null`, and nothing in `display.ts` or `pixi.ts`
depends on which VM drives them.

Construction follows Flash's order, which playerglobal's own constructors
fix: `Sprite()` calls its private native `constructChildren()` after
`constructsuper`, so a symbol's first frame is placed, and its children's
classes constructed, before the subclass's constructor body runs and can
reach them by name. The player constructs a timeline child whose symbol
has a class by making its player object, setting it as the one pending,
and calling `rt.construct(cls)`: the `create` hook takes the pending
object instead of making one, and `constructChildren` runs the clip's
first frame. A `new Sprite()` from a script finds nothing pending and gets
a fresh player object. `EventDispatcher()` calls its private native
`ctor`, and `InteractiveObject()` calls `addEventListener`, so event
dispatch is part of the first slice: listeners by type and phase on the
player object, `dispatchEvent` through the player's parent chain, and the
frame events the player broadcasts.

A frame runs in the order Flash runs one, which Ruffle documents and the
Flash oracle checks: input; the timelines advanced, which places and
removes children and queues the constructors of the new ones, run in tree
order after the timeline; `ENTER_FRAME`; `FRAME_CONSTRUCTED`; the frame
scripts `addFrameScript` registered, for each clip's current frame;
`EXIT_FRAME`; `RENDER` when the stage was invalidated; then the frame is
drawn. The `loops` and `rewinds` cases fixed what a goto keeps; the
scripts' order is fixed the same way, by cases whose traces adl records.

The player loads a SWF's code through `@swf2es/codegen`'s `Codegen`: each
`DoABC`, in tag order, is added to one domain after the builtins and
playerglobal's declarations, compiled whole for now (the JIT's per-method
path is `compileMethods`), loaded as a module, and run unless the tag's
lazy flag defers it to its first use, as Flash defers it. `SymbolClass`
then binds character ids to classes by qualified name through the
runtime's name resolution; id 0 is the document class, constructed on the
root clip before the first frame.

The AS3 half of a player test is an `.as` file beside its case, compiled
in the oracle's container by ASC against `builtin.abc` and
`playerglobal.abc` (which stays in the image, not the repository: see
[Testing against oracles](#testing-against-oracles)), and placed in the
SWF the test builds as a `DoABC` with a `SymbolClass`. Flash's trace of
the SWF is recorded by `--update` beside its frames, and the player's
must match it line for line, as the conformance cases must match
avmshell's.

## Testing against oracles

- **avmshell** (avmplus/Tamarin shell) for AS3 semantics: the output of the
  compiled test must match avmshell's `trace()` output exactly. The Tamarin
  acceptance suite supplies thousands of cases.
  The oracle's avmshell is a 32-bit x86 build, whose C++ double arithmetic
  may run in the x87's extended precision. Where that shows, swf2es follows
  IEEE doubles and the cases avoid it: `Number.toString(radix)` of a value
  above 2^53 writes digits that are neither exact nor a double's, and in
  its JIT a multiplication past 2^53 comes out exact, as as3pb's wire
  checksum shows (`tests/programs` compares all but that line).
  for-in and for each visit an object's dynamic properties in the order
  they were added; avmplus visits them in its hashtable's, which for names
  that are not indexes follows their interned strings' addresses, so the
  cases do not depend on it.
- **Flash, as AIR's `adl` runs it**, for what the player draws and traces
  (`oracle/flash.ts`, `oracle/flash/Harness.as`). The harness is an AIR
  application that loads each SWF with a `Loader`, in a hidden window of
  the SWF's size, and sends back the frames asked for, drawn with
  `BitmapData.drawWithQuality` at the SWF's stage quality, and its traces.
  Frame 1 is the one its `INIT` follows and frame k the one after k - 1
  `EXIT_FRAME`s, a frame later for AVM1, whose movie in a `Loader` shows
  its frame 2 a frame late. adl is not in CI (here it runs the Windows AIR
  runtime under Wine), so what the player's tests compare against is drawn
  once and committed (`tests/player/references`, `node tests/player/run.ts
  --update`); CI needs only Chrome.
  [Ruffle's test corpus](https://github.com/ruffle-rs/ruffle/tree/master/tests/tests/swfs)
  supplies thousands of SWFs with Flash Player's traces, and some with its
  frames (`tests/player/corpus/fetch-ruffle.ts` fetches it, uncommitted). Flash
  under adl traces what their `output.txt` holds (`timeline/`: all 15 that
  finish; `visual/`: 104 of 107). The expected frames are not all Flash's,
  some are Ruffle's own, and Flash under adl draws 42 of the 101 in
  `visual/` within their tolerance or a pixel's anti-aliasing of it, so
  the oracle decides, not the corpus's PNGs (`tests/player/corpus/check-references.ts`).

## Milestone 1

The as3pb protobuf benchmark (`tests/programs`), compiled by swf2es and run in node:

- its trace output matches avmshell byte for byte;
- it is faster than the AwayFL JIT on the same benchmark (headless, its
  first run: ByteArray 525 ms, domain memory 689 ms; PepperFlash 188 ms /
  83 ms). Met since #23, at 207 ms / 251 ms
  ([benchmarks.md](benchmarks.md#generated-code-as3pb));
- the Tamarin `ecma3/` and `as3/Types/` suites run through the conformance
  runner, with their pass rate tracked.

Out of scope for milestone 1: E4X, `Proxy`, `with`, playerglobal, SWF
timelines.
