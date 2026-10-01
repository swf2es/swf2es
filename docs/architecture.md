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
loaded. The natives reach a runtime as a record by name, or as a provider
`(rt) => natives` that the runtime calls on itself once it is made, so
that a module of natives can close over the runtime it serves, as a class
of natives written with `registerNativeClass` does.

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
(`json.ts`) and describeType (`describe.ts`). These are MPL-2.0 as their sources are. Domain memory is
avmshell's `avmplus.Domain`'s: 1024 bytes of scratch memory until a
ByteArray is set as it. Date is JavaScript's Date, with avmplus' string
formats.

`avmplus.describeTypeJSON`, which `describeType` and playerglobal's
`flash.utils.describeType` build their XML from, is avmplus' TypeDescriber
translated (`natives/describe.ts`): the value's traits, or its class's
instance traits with `USE_ITRAITS`, named as `getQualifiedClassName`
names them (`*` for none, `void` and `null` for those values), its
bases up the chain, every interface it implements, its constructor's
parameters when it has any, and for each name bound in a public
namespace, the base's first and a derived class's binding over it, the
variable's type and access, the accessor's type, access and declaring
class, the method's return type, parameters and declaring class, with
the namespace's URI when it has one and the metadata when asked.
`HIDE_NSURI_METHODS` drops the names in a namespace with a URI that a
base class uses, by the namespace's identity, which in avmplus carries
its API version: so Object's AS3 methods hide under a class, a script's
own AS3 methods show until a class derives from it, and the player keys
the hidden set by URI and version alike. `HIDE_OBJECT` drops Object's
own; the bindings a class gets in its interfaces' namespaces are not
members and do not show; a binding above the caller's API version is
left out, the caller taken to be the latest player's, as avmshell runs
(a SWF's own version is not yet consulted), which hides the builtins'
`[API(CONFIG::VM_INTERNAL)]` members: the oracle's SDK compiled them
with the table of AIR 15's time, whose VM_INTERNAL mark is 42 where
`core/api-versions.h` here has 52, so the compiler reads a builtin's
mark from 42 up as internal. For that the compiler emits what the
runtime needed nothing of before: each method's signature beside its
factory (return type, parameter types, how many are required), the
constructor's in the class descriptor, and a class's and its traits'
metadata whole, name and key-value pairs (the ABC lists all the keys,
then all the values, as avmplus reads them, not the pairs the
specification shows), from which the runtime derives the `[Transient]`
flags AMF and JSON use; a builtin's `Version`, `native` and `API`
metadata stay out, as avmplus leaves them. avmplus iterates its bindings
in a hashtable keyed by interned string addresses, so the order of the
arrays is not one the player can reproduce, and the conformance case
sorts them, as Ruffle's tests do. `getQualifiedClassName` names a number
`int` only within avmplus' 29-bit int atom, and the builtin Vector
classes `Vector.<int>`, `Vector.<uint>`, `Vector.<Number>` and
`Vector.<*>`, as avmplus renames them.

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
`$display`. They are written as a class of getters, setters and methods,
whose members `registerNativeClass` (the runtime's `natives/define.ts`,
beside `plain`) registers under the names the compiler binds, `Class#get:x`, `Class#set:x`,
`Class#method` and `Class.method` for a static, each through `plain()`,
so it runs with the AS3 object as `this`; the class is only how they are
written, and a private native is registered by name beside it. The class
lives in the factory that makes the natives, so it closes over its
`Scripting`; an AVM1 movie's children, and a timeline child without a
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

A frame runs in the order Flash runs one, which the Flash oracle fixed
case by case: the timelines advanced, which places children and
constructs their classes as it goes; `ENTER_FRAME`; `FRAME_CONSTRUCTED`;
the frame scripts `addFrameScript` registered, once for each frame a clip
enters and again for what a script's goto changes; `EXIT_FRAME`; `RENDER`
when a script invalidated the stage; then the frame is drawn. The first
frame, after the document class is constructed, has no `ENTER_FRAME`
(`events`). The frame events are broadcasts: each display object that
listens hears its own, on the display list or not, in the order the
objects first listened, with no capture or bubble phase. And `SymbolClass`
binds its classes after an eager `DoABC` has run its initializer, so an
instance that initializer makes of a bound class has no timeline children,
and one the constructor makes has (`init`). A goto a frame script asks for
waits until the script returns: `currentFrame` and the children read as
before it through the rest of the script, then the jump happens and the
frame it lands on has its script run in the same phase (`gotos`), before
the script of any child the jump placed, which is constructed with its
parent already on the landing frame (`gotoChild`); a goto from anywhere
else happens at once. All the timelines advance before any frame script
runs, parents' scripts before their children's (`nested`); the clips
whose scripts are to run are fixed as the phase begins, so one a script
removes still runs its own (`loads`, `orphans`).

A `PlaceObject` with the move flag that names another character at an
occupied depth makes no new object in Flash: the child stays, the same
AS3 object with its matrix, sign and angle, and only a `Shape` no script
has touched takes the new shape's graphic. A clip, a touched `Shape`,
and a `Shape` a sprite is placed over all stay as they were. What
touches, by the `replaces` case's 26 depths: the transform properties
(`x = x` counts), `alpha`, `filters`, `blendMode`, `scrollRect`,
`opaqueBackground` and `scale9Grid`, each set to what it was, the
`transform` setters, and `cacheAsBitmap` set true; what does not:
`visible`, `mask` and `cacheAsBitmap` set to what they were (the player
takes a change of those as a touch), `metaData`,
`accessibilityProperties`, and `name`, which Flash refuses for a
timeline-placed object with error #2078. The player keeps a `scripted`
flag on the display object for that. A goto
forward does the same, whatever the frames between named at the depth;
a rewind keeps the child only if the character the frames finally name
is its own, and makes a new one for another (Ruffle's
`place_object_replace_2`: the same object through two forward jumps, a
new one on the rewind that ends on the other shape). Flash's matrix is
exact at the quarter turns, 0 and not the doubles' cosine of 90°, so the
player's is.

A clip a script takes off the display list plays on in Flash, an
orphan, and so does one a script makes with `new` and never adds: its
timeline advances and its frame scripts run each frame, with `parent`
and `stage` null, until it is put back, where it carries on from the
frame it reached, or until it is collected (the `orphans` case; Ruffle
keeps them by weak reference, and so does the player, with `WeakRef`, so
an orphan nothing refers to stops as Flash's does, and a test that wants
one to play on holds it). What refers to it includes the frame events it
listens for: an `ENTER_FRAME` listener keeps a clip alive in Flash, the
well-known leak, and the player's broadcast sets hold their listeners as
strongly. A clip a script makes with `new`, added or not, runs its first
frame's script at the end of that frame's script phase, after the
display list's, in the order made, and sits out the next frame's
advance: made in frame 1, it is on its frame 1 through frame 2 and on
frame 2 in frame 3. The order Flash runs the orphans' scripts in, among
themselves and against the display list's, shifts with the case's layout
(three recordings gave three orders), so the player has an order of its
own, the orphans before the display list, the most recently created clip
first, each subtree in tree order, and the case reports what the clips
logged rather than tracing from them.
The timeline's removal is different: the clip advances and runs the
script of the frame that removed it and then stops for good; and the
property the parent had under the clip's instance name is set to null,
where a script's `removeChild` leaves it. `unloadAndStop` stops a
`Loader`'s content before letting it go, so it does not become an orphan;
`unload` lets it play on, as Flash does.

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

### Loading SWFs

A `Loader` is a container whose one child is the root of the SWF it
loaded, and a `LoaderInfo` is made for each `Loader` and one for the main
SWF: a root display object carries its SWF's, and `loaderInfo` and `root`
on a display object are the nearest root's up from it, null off the
display list, as Flash has it (Ruffle's `loaderinfo_root` trace; a
loaded SWF's root is its own root from its constructor on). Its values
are the loaded SWF's: `bytesLoaded` and `bytesTotal`, `content`, `url`
and `loaderURL`, `contentType`, the header's version, frame rate, width
and height, `loader`, `applicationDomain`, `bytes`.

The order is Flash's, traced by adl (the `loads` case; the Flash Player
traces in Ruffle's corpus agree where they overlap). `loadBytes` tells
the whole of the progress in the call, `PROGRESS` with nothing loaded and
again with all of it, `bytes` set and `url` still null, and has no
`OPEN`; a `load` of a URL has `OPEN` once the bytes come. The content
comes in a later frame, after `ENTER_FRAME` and before `FRAME_CONSTRUCTED`:
its SWF's code runs, its document class is constructed with `parent` and
`stage` null and its timeline's first frame in place, it gets `ADDED`
while it still has no parent, then `url` and `content` are set and it is
made the `Loader`'s child, `ADDED` again and `ADDED_TO_STAGE` if the
loader is on the stage. Its first frame's script runs in the frame's
script phase, after its parents', and `INIT` and `COMPLETE` follow
`EXIT_FRAME`, before `RENDER`. The content's timeline advances from the
next frame on, with the stage's frame rate. `unload` takes the content
out at once and keeps the `Loader`; a frame script the content had queued
still runs. The URL of content loaded from bytes is the loading SWF's
with `/[[DYNAMIC]]/n` appended, and `ApplicationDomain.currentDomain` is
a new object at each ask, as in Flash, so two are never `==`.

The loaded SWF's code goes through `Codegen` and the runtime as the main
SWF's does. Linking is asynchronous (the module is imported), so a load
asked for is compiled and linked between frames, in the order asked, and
each takes its place in the first frame after its code is linked; a host
that steps frames by hand awaits `Scripting.settled()` between them, as
the tests do, to see Flash's frame. `SymbolClass` bindings are the
library's, since character ids collide across SWFs. The player package
has no I/O: `load` of a URL asks the host for the bytes through a
function the `Scripting` is given, with the URL resolved and an
`AbortSignal`, and a fetch that fails, or bytes that are not an AS3 SWF,
end in `IO_ERROR` on the `LoaderInfo` in the frame. `close` drops a
pending load and aborts its fetch; `unload`, and a new load on the same
`Loader`, do that and take the content out at the call, the `LoaderInfo`
knowing nothing again (Ruffle's `loader_reuse` trace), so a `Loader`
never holds two; the content let go of has `UNLOAD` dispatched on the
`LoaderInfo`, its `content` and byte counts already cleared and the child
still attached, before `REMOVED` (the `loads-init` case). A load closed
or replaced from one of its own events, `OPEN`, `PROGRESS`, the content's
constructor or `INIT` among them, ends there: an unload from `INIT` has
no `COMPLETE`, as Flash has none. An `unload` asked for from `REMOVED`
finds the content already let go of, and a load asked for there is the
one that counts. What a `LoaderInfo` knows of its SWF's header
(`swfVersion`, `frameRate`, `width`, `applicationDomain`...) is refused
before the SWF is loaded, Error #2099, as Flash refuses it. The SWF a `Loader` belongs to, which its content's
`loaderURL` reports and its relative URLs resolve against, is in Flash
the one whose code made it; the runtime does not track callers, so it is
the SWF the `Loader` is on the display list of when it loads, else the
main one (Ruffle's `loader_loaderurl` adds the loader first, as SWFs
usually do).
The Flash cases use `loadBytes`, the inner SWF carried in the outer's
script as base64; the oracle runs under AIR, which refuses code from
bytes unless the `LoaderContext` has `allowCodeImport`, which Flash
Player does not need.

Flash loads into a child `ApplicationDomain` by default: the parent
cannot see the loaded SWF's classes by name, a class the loaded SWF
defines again shadows the parent's for its own code, and
`LoaderInfo.applicationDomain.getDefinition` finds it
(`loader_duplicate_class`). That needs two things: the compiler's domain
forked, a new domain sharing the ABCs loaded so far, and the runtime
resolving names by the domain of the module asking. The first slice has
neither: it loads into the current domain, as a `LoaderContext` with
`ApplicationDomain.currentDomain` asks. There, as in Flash, a class the
loaded SWF defines again is ignored for the one the domain has, so a SWF
loaded twice makes instances of its first load's classes (the node
test). Child domains are the slice after.

A SWF the player loads is in the position the oracle's harness puts
every SWF in, so what the harness could not judge for a main movie, the
document class's `stage` in its constructor among it, compares exactly
once the case loads its SWF.

### Drawing with Graphics

A `Shape` or `Sprite` draws with its `Graphics`, which records into a
drawing the display object keeps: the same layers of fills and strokes,
with their paths in pixels, that `shapes.ts` makes of a SWF shape, so
the renderer draws both alike. A fill begins at `beginFill` (or a
gradient or bitmap fill) and ends at `endFill`, at the next begin, or at
`lineStyle`'s change; what is drawn between is the fill's contours, each
`moveTo` starting one and each closed back to its start, filled even-odd
across them, as Flash fills. A stroke begins at `lineStyle` with a
thickness and ends at one without, keeping the line's width, color,
caps, joints, miter and scale mode. `drawRect`, `drawRoundRect` and
`drawRoundRectComplex` are moves and lines with quadratic quarter
circles, as Flash's; `drawCircle` and `drawEllipse` are playerglobal's
own, over `curveTo`. `cubicCurveTo` adds a cubic command to the path
model; `drawPath` takes commands and data with a winding, which is that
path's: even-odd fills by the parity of the contours around a point,
non-zero by the sum of their orientations, so a square drawn inside
another the same way round is filled under non-zero and a hole under
even-odd, and one fill drawn with both rules in turn keeps each path's,
as Flash does (the `draws` case). The renderer decides a region by its
nesting in the contours' containment, so two contours of one fill that
overlap without nesting fill as their union, where Flash's even-odd
would leave their overlap out: a limit of the triangulation, noted.
`clear` takes everything and the styles away; `copyFrom` clears first
and then copies, so a drawing copied from itself ends empty, as Flash's
does (the `draws` case). The drawn order is the calls' order,
fills under strokes within a layer as in a SWF shape, and a sprite's
drawing under its children.

The renderer keeps a drawing's fills and strokes as it keeps a shape's,
per display object rather than per character, since a drawing changes,
rebuilt when the object's content changes; strokes go through the same
re-stroking as a shape's for their width under a transform. The drawing's
points, and its lines' half widths, give the object its bounds, for
`width`, `height`, `getBounds` and the hit tests to come. Gradient and
bitmap fills are recorded as a shape's are, and drawn as far as a shape's
are (the first stop); shader fills, `drawTriangles`, `readGraphicsData`
and `drawGraphicsData` wait. An adl case draws in a `Shape` and in a
`Sprite` with a child, compared by pixels; the corpus's `graphics_*`
tests, which trace nothing, check that nothing throws.

### Bounds and hit tests

A display object's bounds are what it draws and what its children draw,
in its own space: for a shape from the SWF the rectangle DefineShape
recorded, with the lines' widths for `getBounds`, `width` and `height`
and without them (`edgeBounds`, where the shape has one) for `getRect`,
as Flash reports the recorded rectangles even where the shape's edges
disagree with them (the corpus's `displayobject_getrect`); for a
drawing, the extent of its paths, curves at their true extremes, with
the lines' half widths and square caps for the bounds with lines; for a
container, the union of its children's bounds, each through the child's
matrix, with its own drawing's. `width` and `height` are the bounds
through the object's own matrix, in its parent's space, or what that
would be for one with no parent, so a turned square is wider than its
side and a scaled shape never added is as wide as its scale makes it
(the `draws` case); setting one scales the
object so that the bounds come to the value, and leaves it when the
bounds have no extent to scale, as Flash. `getBounds(target)` and
`getRect(target)` take the bounds through the matrices up to the stage
and back down into the target's, or stay in the object's own for null.

What is reported is in twips, as Flash keeps positions: a turned square
of side 50 is 61.25 wide, not 61.237 (the `draws` case). Flash's bounds
of a line come out about half a pixel wider than its geometry with its
half width, by a rule not known yet, so the case reports its drawing's
`getRect`, which has the lines' paths without their widths. Flash keeps
`scaleX`, `scaleY` and `rotation` apart from the matrix, so that a
negative width gives a negative `scaleX`; the player derives them from
the matrix and loses the sign, which is where the corpus's
`displayobject_width` and `_height` part from it.

`hitTestPoint(x, y)` takes its point in the space of the main root, as
Flash does (the corpus's `displayobject_hittestpoint_root`: moving the
root moves nothing under the point, moving a loaded SWF's root does):
against the bounds, or, asked for the shape, against what is drawn, a
fill where the point is inside by the fill's winding rule, the parity
of its contours around the point or the sum of their orientations, as
the renderer fills it (the `draws` case hits the inner square of the
non-zero pair and not the even-odd one's), and a line where it is within
half the width of a path, children included. Flash finds nothing on an
object not yet drawn and off the stage, as the oracle's harness has a
document class in its constructor; the player does not model that.
The shape test samples half a pixel to the left of the point, on its
row, which is how Flash's answers on a shape's edges come out: a point
on its right edge hits, one on its left, top or bottom edge does not
(`displayobject_hittestpoint_boundary`, both ways round). The shape test
asks for a SWF's root above the object, the bounds test does not. `hitTestObject`
asks whether two objects' bounds in the stage's space overlap. The
corpus's `displayobject_getrect`, `_hittestpoint`, `_hittestpoint_root`
and `_hittestobject` are the reference, with the `draws` case.

### Time

The player keeps a clock of its own, in milliseconds, apart from the
frame count: `getTimer` reads it, and `Timer` fires by it. A frame
stepped by `Player.tick()` moves the clock by one frame's duration at
the stage's frame rate, the first frame's included, so a test that steps
frames gets the same clock every time; a host playing in real time calls
`Player.advance(dt)` with the time passed, which accumulates it and runs
as many frames as it is worth, five at most after a long pause and the
rest let go, as Ruffle paces, so a stall does not become a spiral of
catch-up. Frame pacing and the clock are related but not one counter:
the clock may run on within a frame later, where the frame count cannot.

`flash.utils.Timer` is playerglobal's own in all but three natives: the
counting, `delay`'s range (RangeError #2066), `reset` and the events are
AS3; the player keeps the timers started, each with its delay and the
closure to call, fires the ones due as a frame begins, before its
timeline advances, each firing the earliest due so that two timers
interleave as their times do, two due at once in the order scheduled,
and tells `running`. The timers are a heap by due time, as asyncio keeps
its callbacks: a scan of all of them per firing costs 2.5 ms a frame at a
thousand timers where the heap costs 0.3, and nothing either way below a
hundred.
Flash fires timers between frames at their own times, so while a
timer's closure runs the time is the one it fell due at, which a timer
started from it counts from and `getTimer` tells: three timers set one
from another at 100 ms each land at 400, 500 and 600 ms, as in Flash,
not a frame later each (the corpus's `timer_finished`).
`setTimeout` and `setInterval` are AS3 over `Timer`. The corpus's
`timer*` tests, Flash's traces of timers against frames, are the
reference, with a node test of the clock and `advance`.

### Scale and rotation

Flash keeps a display object's `scaleX`, `scaleY` and `rotation` apart
from its matrix, and the player does the same: the four are the object's
own, the matrix is made from them, and a matrix set whole, by a
`PlaceObject` or `transform.matrix`, is taken apart into them, the
scales by the lengths of its columns and the rotation by the angle of
the first, a skew by the second's. So `scaleX = -0.5` reads back as
-0.5 and halves the width, where a matrix taken apart would read 0.5 at
a half turn; and `width` sets `scaleX` to the value over the object's
untransformed width, positive, from a scale of 0 as well as from any
other, and a negative width changes nothing, as Flash has it (the
corpus's `displayobject_width` and `_height`, 4852 and 6052 lines of
ramps, in twips: a drawing thinner than one is no width, so `nan_scale`'s
`Number.MIN_VALUE` square is as good as none). A scale set stretches its
column of the matrix in proportion, so the other column stays exactly as
it was, and a scale set to NaN reads back NaN and zeroes its column; a
NaN rotation reads back NaN and leaves the matrix; a NaN position is 0
(`displayobject_invalid_floats`). Rotation is reported in Flash's
range, -180 to 180, both ends as given. The ramps
add to what the getters return, so each step's value rests on the one
before, and they part from the player where Flash's arithmetic does from
IEEE's: Flash Player's `-0.9981818181818182 + 1/550` is not the nearest
double to the sum, which the 32-bit player's x87 extended precision
explains, as it does the avmshell's (above); swf2es follows IEEE
doubles there too, so those two tests cannot be matched to the end.

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
  its frame 2 a frame late. A frame's load completions (`INIT`,
  `COMPLETE`) follow its `EXIT_FRAME`, so what their listeners change
  shows in the next frame's capture (the `loads-init` case captures frame
  3 for its unload at frame 2's `INIT`). A SWF's clips taken off the
  display list play on in Flash until collected, so a case that leaves
  one is recorded last, or its traces would reach the next case's. A SWF the harness runs is loaded content, and
  Flash constructs that before it is the `Loader`'s child: its document
  class finds `stage` null in its constructor, where a main movie's finds
  the stage, as the player's does. A case whose trace depends on that
  waits for the player's own `Loader`, to run as loaded content too. adl is not in CI (here it runs the Windows AIR
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
- **Ruffle's corpus, as a baseline for the player** (`pnpm corpus`,
  `tests/player/corpus/run.ts`): the player plays each `avm2/` and
  `timeline/` test that has Flash's `output.txt` for the frames its
  `test.toml` names, in Chrome as the player's tests run, and its trace is
  compared to Flash's line by line. `baseline.json` records each test's
  standing, as `tests/tamarin/swf2es-baseline.json` records swf2es's on
  Tamarin: the lines matched before the first difference, of how many,
  and what stopped the player, if anything. A change may not lower a
  standing, and one that raises it updates the baseline with
  `--update-baseline`; a test whose standing varies from run to run is
  set to null and not compared. Only the traces are compared: the frames
  Flash drew are the oracle's matter (above), and a test needing input,
  audio, video or a default font is ignored, as the collector marks it.
  A test that does not finish in its time is a timeout, a standing of its
  own. The corpus is fetched, not committed, so the baseline runs where
  the corpus is, like adl, not in CI; it is what says, in order of what
  real SWFs hit first, what the player lacks.

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
