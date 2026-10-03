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
after those before, into one of its application domains (`childDomain`
makes one, `found` records what one has found, see Linking), and the last
one added compiles with `compile`, whole,
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
   hash, and the hashes of the ABCs in its domain when it compiled, in load
   order, those loaded with it included, since a SWF's `DoABC`s are all
   added before any compiles (`cacheKey()` in codegen), so the browser
   cache, AOT output served by a server, and JIT output are
   interchangeable. An ABC's layouts depend on those it links
   against, since its slot and dispatch ids follow its base classes', so a
   module also records their hashes and the runtime refuses it when the
   ABCs loaded before it differ. In a child application domain, what the
   domain was recorded to find (`found`) binds names and types too, so the
   key names those findings, each by the hash of the ABC that defines it.

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
| `player-hosts` | optional host transports for the player: Node TCP, a WebSocket relay | player          |

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
   The domain's ABCs are loaded into application domains, a tree whose
   root is 0, as avmplus' DomainMgr keeps them: an ABC sees the names its
   own application domain and its ancestors define, the first from the
   root down, unless the runtime has reported that the domain finds
   another (`found`: what its caches hold, by name or as a type), and its
   module names as `linked` the ABCs it sees, in load order.
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
   with its VerifyError numbers (`abc/code.ts`, and for finding, getting,
   setting and calling properties `abc/properties.ts`). A first pass keeps a frame state per block
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
4. **Control flow** (`emit/structure.ts`). First a per-method dispatcher
   (`for (;;) switch (block) { ... }`), which handles any control flow,
   irreducible or obfuscated included. Then structured JavaScript (loops, `if`,
   labelled `break`) from the dominator tree for the reducible code compilers
   emit, falling back to the dispatcher. Conformance tests check that both
   give the same results.
5. **Emission** writes JavaScript as UTF-8 into a growable byte buffer: no
   JavaScript strings, and names are copied straight from the ABC. A
   method's instructions are `emit/method.ts`'s; arithmetic, comparisons
   and conversions `emit/values.ts`'s, domain memory `emit/memory.ts`'s,
   how types, namespaces and constants are named `emit/refs.ts`'s, and the
   module around the methods `emit/module.ts`'s.

### Generated code

Each ABC compiles to one ES module. Every method becomes a JavaScript
function whose registers are `var` variables, and whose blocks are
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
element, so that each sees one kind of array. A domain memory load or
store at an `int` or `uint` address is in place, on the runtime's view
of the memory after a range check, and calls the runtime (`rt.li32` and
the like) only for an address out of range, which it rejects as avmplus
does. Anything typed `*` goes through the runtime, which does what
avmplus does at run time.

Two ints or uints multiplied and the product made an int or uint by the
next instruction, in the same block, are `Math.imul`: avmplus' JIT
multiplies them as ints (`CodegenLIR::coerceNumberToInt`), which wraps,
where the double product loses the low bits past 2^53, and compiled C
such as Crossbridge's depends on it. Its interpreter multiplies doubles,
and it runs the static initializers, scripts' and classes', so those
stay double products. The JIT also wraps a product that reaches the
conversion later in the block or through a local, which swf2es does not
follow yet; `int-multiply.as` keeps to the forms it does.

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
stays MPL-2.0, and Flash Player's own over them, 2000 and up, generated
into `player-messages.ts` from the table Flash itself prints as
`Error.getErrorMessage` of every number (Ruffle's corpus,
`error_geterrormessage`); the release player and avmshell print the
number alone.

Where avmplus' behaviour is its own algorithm rather than a language rule,
the runtime translates it, so that its output is avmplus' byte for byte:
number formatting (`numbers.ts`), Array's sort (`sort.ts`), ByteArray with
its capacity and UTF-8 (`bytearray.ts`), AMF3 (`amf.ts`) and JSON
(`json.ts`) and describeType (`describe.ts`). These are MPL-2.0 as their sources are. Domain memory is
avmshell's `avmplus.Domain`'s: 1024 bytes of scratch memory until a
ByteArray is set as it. Each Domain is one of the runtime's application
domains (`Domain` in `runtime.ts`), as avmplus' DomainMgr keeps them: a
name a domain's chain defines already is not added again, and a lookup
takes what a domain of the chain has found before, from the name's own
domain up, else the first loaded, from the root down, and keeps it, so a
child that found its own class keeps it when its parent defines the name
later. A type, a coercion's or a base class's, is found the same way
through caches of its own, as avmplus finds traits, so a class a child
found by name is not the type it finds once its parent defines the name,
and a class extending it is rejected, as avmplus rejects it. Every name a module makes is looked up in the domain the module was
loaded into (`Runtime.loadInto`); everything else loads into the root. The
Domain's `loadBytes` compiles its ABC through `RuntimeOptions.compileAbc`,
which the host gives, as the runtime does not include the compiler, into
the compiler's application domain of the same number, after what the
domain sees then: its parent's ABCs, with those the parent loaded after
the child was made, and its own, in load order. With it go the domain's
findings that are not the first definition from the root down, what its
caches hold (`Runtime.compileUnit`), so the compiler binds the ABC's names
and types as the runtime will find them. It runs the ABC at once. The
compiler binds them as the domain finds them when it compiles; avmplus
binds each method's when it verifies it, on its first call, so a name
nothing has found yet that a parent defines in between binds differently.
`Domain.currentDomain` is the domain of the innermost code on the stack
that a module defines, as avmplus' code context, so a child's method
called by the parent's code sees the child's. The runtime finds a frame's
module by the script the stack names, recorded when the module loads, so
a host gives each module a script of its own, a `sourceURL` comment for
code it evaluates (`Runtime.codeDomain`).
avmshell's `File` reads and writes
`RuntimeOptions.files`, in memory by default. Date is JavaScript's Date, with avmplus' string
formats. flash.concurrent's Mutex and Condition and ByteArray's atomic
operations are avmplus' on its one thread: locks are counted, a wait ends
at once, as nothing else can notify it, and Worker.current is the
primordial worker, the one there is (`natives/concurrent.ts`); starting
another is not supported. Crossbridge's code uses them all as it starts.

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
`[API(CONFIG::VM_INTERNAL)]` members: VM_INTERNAL is the last mark of
the table an ABC was built with, 42 in the AIR 15 SDK's, which the
oracle's playerglobal has, 52 in `core/api-versions.h`, which the
submodule's builtin has, so the compiler reads a builtin ABC's highest
mark, from 42 up, as its internal one. For that the compiler emits what the
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

A few of avmplus' corners the corpus met, each fixed by avmshell's word
(`class-calls`, `enumerability`, `function-prototype`, `proxy`): an
interface cannot be constructed, a VerifyError 1001 naming its
constructor as a method nothing implements; `Object()` makes an object
for nothing, null or undefined and returns its first argument otherwise,
however many; `Vector.<T>(x)` is `x` for a Vector of that class, reads any
other object as an array-like by `length` and index, a ByteArray's bytes
included, and refuses a primitive or null (1034); a Vector's elements are
not enumerable to `propertyIsEnumerable` though `hasOwnProperty` has them
in range; a name set not enumerable stays so when set again but is
enumerable anew once deleted and set; a class's static initializer may
name its own class as a type, which avmplus resolves from traits, so the
runtime keeps the classes being defined by name until their script slot
holds them. `arguments.callee` is the method's own Function object, the
one `newfunction` made where there is one, so `arguments.callee === f`,
else one made for the method once, as avmplus' MethodClosure: the
compiler hands `rt.arguments` the function itself. `flash.utils.Proxy`
is a property hook on its traits (`natives/proxy.ts`), as XML's is, with
the difference that a method the traits bind stays the method where XML
hides the methods of its names behind its children (`hidesMethods`):
every unbound name goes to the `flash_proxy` methods as ProxyObject
sends it, a written name as a QName in its namespace, the empty URI for
a set of several, an index as its string, `in` with the string, and an
unbound call, `hasOwnProperty` or `toString` included, to
`callProperty`; for-in walks `nextNameIndex`, `nextName` and `nextValue`.

avmplus' standard library (`Object`, `Array`, `String`, `Math`, `Date`,
`RegExp`, `JSON`, `Vector`, `ByteArray` and so on) is mostly AS3 compiled
into `builtin.abc`; only its `native` methods are C++. swf2es compiles
`builtin.abc` itself and implements the natives in TypeScript, matched by
class and method name as avmplus matches its C++ ones. The `builtin.abc`
and `shell_toplevel.abc` the runtime, the player and the tests load are
the avmplus submodule's own, `oracle/avmplus/generated/`, built by its
`core/builtin.py` from its sources; the oracle's SDK ships older ones,
of AIR 15's time, without `Array.removeAt` and `insertAt` and their
Vector counterparts (SWF 30's), and its avmshell keeps its own copy
inside the binary, so what avmshell runs is the older library whatever
file is beside it. The two differ in those ten natives alone, and where
the submodule's library is newer than the oracle's avmshell, the oracle
cannot judge; Flash's traces in Ruffle's corpus do. The standard library
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
tree of the contours, holes cut. Its lines are drawn in the stage's axes,
because Flash strokes a transformed line with one width all along, not the
local width stretched by the transform: so a line's context depends on the
linear part of its transform on the stage, and is kept by layer and that
transform, exactly, shared by every instance that sees the layer alike
(a crowd of one creature in step) and found again when one comes back to
it (a loop's next turn). Contexts are counted as instances take and give
them back, and an object that leaves the list gives back its own and its
descendants', drawn again if it returns; one no one holds stays idle
5 s, by the clock, not renders, which a host may make many of between
frames, at most 4096 of them, before it is destroyed. A drawing's lines
are its own, as it changes. No line is thinner than a pixel of the
screen, which is how wide Flash draws a hairline however far its stage is
zoomed: `PixiView.screenScale` screen pixels to a stage pixel, the
renderer's resolution unless the host says otherwise, as the test page,
drawing finer to average down, does. A host showing the stage at three
times its size so draws thin outlines a screen pixel wide, as Flash
does, not three.
Shapes are shared across SWFs too: a DefineShape tag whose bytes another
SWF defined alike gives that SWF's shape, held weakly, so a crowd whose
members each load the same SWF draws with one set of fills and lines, not
one per load, whose lines alone overran the idle limit and were
tessellated again on every turn of their loop. A shape filled with a
bitmap keeps to its own SWF, whose bitmap it is.
Tessellating lines, round joins most of all, was the largest part of a
frame of a dozen animated instances; `bench.ts --rig N` measures it.
Fills and lines are drawn unbatched, each Graphics a draw of its own
geometry under its transform. Pixi batches small Graphics by packing their
vertices, already transformed, into one buffer, which it packs and uploads
again whenever its render group changes structure: on most frames of an
animation, whose timelines add and remove children. Larger ones it draws
alone anyway, so batches and those alternate, switching programs at each.
Unbatched, a shape's geometry is uploaded once: more draw calls, but far
fewer program switches and uploads, and `bench.ts --rig 32` draws in half
the time on a GPU and a quarter of it under software GL.

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

`MouseEvent` keeps its local coordinates and flags on the event. Its stage
coordinates are read through the target's current display matrix, so moving
the target after dispatch changes them without changing `localX` or `localY`.
Without a target a finite local coordinate gives stage coordinate zero, and
an unset one stays NaN (`mouseevent_constr` and `mouseevent_stagexy` in the
corpus). AIR's `playerglobal.abc` adds `commandKey`, `controlKey` and
`clickCount` to `MouseEvent.toString`; the Flash Player trace in
`mouseevent_valueof_tostring` has none of them, so that one output still
differs though its native values match.

`PixiView.bindPointer(player)` takes Pixi's normalized pointer positions,
scaled to the SWF's stage, and passes them to the player's own hit test.
The display list decides the target, so masks, scroll rectangles, depth,
visibility, `mouseEnabled` and `mouseChildren` use the same objects that
scripts see; Pixi's render tree does not choose a Flash target. The first
input slice sends `mouseOver`, `mouseOut`, `mouseMove`, `mouseDown`,
`mouseUp` and `click` through EventDispatcher's capture and bubble phases.
`DisplayObject.mouseX` and `mouseY` follow the last pointer position.
Roll events, wheel, right and middle buttons, and Flash's drag and focus
rules still need their own cases.

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

In a SWF of version 9 or earlier, a clip a script sends to a frame, by a
goto from a frame script, a listener or anyone, sits the next frame out
with everything in it: none of them advances, and from the frame after
they go on as before. From version 10 a goto leaves the frames that
follow as they were (`goto-children`, recorded as version 9). A clip's own
SWF decides, so a version 9 SWF loaded into a later one keeps the rule.

A root's scenes and labels come from its DefineSceneAndFrameLabelData;
a timeline without one, or whose data names no scene, a sprite's always,
is one scene named "" whose labels are its FrameLabel tags (`scenes`,
`frame-labels`). The first scene starts at frame 1 whatever its data says,
and a goto finds the FrameLabel tags' labels where the data lists none,
though scripts read none there (the corpus's `movieclip_currentlabels_dupes2`
and `movieclip_goto_scene_last_frame_label`). To a script,
`currentFrame` counts from its scene's first frame, while `totalFrames`
is the whole timeline's. `currentScene.labels`, which `currentLabels`
reads, are the scene's labels counted from its first frame;
`currentLabel` is the last label at or before the frame in any scene;
and `currentFrameLabel` reads FrameLabel tags alone, scene data or not.
`scenes` and `currentScene` make new objects at each read. A goto's
frame number counts from the scene it names, or the clip's, and a label
is found in that scene only: an unknown scene throws #2108, and an
unknown label #2109 where the timeline has named scenes, while in an
unnamed one it is the number 0, frame 1. `prevScene` and `nextScene` go
to the first frame of the scene before or after, or of their own past
either end, and play.

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
playerglobal's declarations, all of a SWF's before any of them compiles,
since avmplus has a frame's ABCs loaded before it verifies a method, so a
class in the first tag may extend or name one in the last (the corpus's
`property_priority`, five tags by mxmlc); each is then compiled whole for
now (the JIT's per-method path is `compileMethods`, both by the ABC's
index in the domain), loaded as a module, and run unless the tag's
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

### ExternalInterface

`ExternalInterface` is available only when the embedding page gives
`Scripting` an `externalInterface` host. Its public methods stay in
`playerglobal.abc`; the player supplies their private native bridge:
initialization, enumerable property names, callbacks, and the synchronous
JavaScript and XML call paths. The host receives the JavaScript source or
XML invocation and decides what to execute; the player does not evaluate
script text. Without a host, `available` is false, `objectID` is null,
and calls and callback registration throw Error #2067 as Flash does in a
container without a bridge.

### Screen capabilities

`flash.system.Capabilities` reads screen resolution, pixel aspect ratio and
DPI from the `Scripting` instance. A host may supply any of the four values
through `screenCapabilities`; omitted values fall back separately. Values are
copied when the player is made, so another player can report a different
screen. By default, resolution comes from the browser's `screen` (zero in a
non-browser host), pixel aspect ratio is 1 and DPI is 72. The corpus harness
supplies the screen on which its Flash traces were recorded.

### Loading SWFs

A `Loader` is a container whose one child is the root of the SWF it
loaded, and a `LoaderInfo` is made for each `Loader` and one for the main
SWF: a root display object carries its SWF's, and `loaderInfo` and `root`
on a display object are the nearest root's up from it, null off the
display list, as Flash has it (Ruffle's `loaderinfo_root` trace; a
loaded SWF's root is its own root from its constructor on). Its values
are the loaded SWF's: `bytesLoaded` and `bytesTotal`, `content`, `url`
and `loaderURL`, `contentType`, the header's version, frame rate, width
and height, `loader`, `applicationDomain`, `bytes`. The main SWF's
dispatches `init` and then `complete` at the end of its first frame,
after `exitFrame` and before the second (Ruffle's `loaderinfo_events` and
`delayed_symbolclass` traces), as a loaded SWF's does.

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
function the `Scripting` is given, with a resolved URL, method, headers,
copied body and `AbortSignal`. A fetch that fails, or bytes that are not an AS3 SWF,
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
the one whose code made it, even before the first load; the runtime does not
track callers, so it is the SWF the `Loader` is on the display list of when
it loads, else the main one (Ruffle's `loader_loaderurl` adds the loader first, as SWFs
usually do).

`URLStream` uses the same host fetch, which gives bytes (or a failure), HTTP
status and headers. A `URLRequest`'s GET string or URLVariables data is appended to the query;
GET ByteArray data is currently left out and has not been checked against Flash;
other methods send its string, URLVariables or ByteArray data as the body.
Only POST forwards custom headers in the browser player, as Flash Player does;
the host's fetch decides which requests its environment permits. The result
arrives on the player thread in a later frame.
A successful stream reports `OPEN`, `PROGRESS`, `HTTP_STATUS`, `COMPLETE`;
a failed one reports `HTTP_STATUS` before `IO_ERROR`. A URL load through
`Loader` reports status on its `LoaderInfo` between `INIT` and `COMPLETE`,
or before `IO_ERROR` on failure. A local file reports status 0 and no
response headers. The host's response URL and headers are not surfaced by
the Flash Player path; AIR-only `HTTP_RESPONSE_STATUS` is not sent.
Stream fetches are independent of Loader's ordered preparation, so a
stalled stream cannot hold up a later Loader; `settled()` waits for both
when a host explicitly asks it to. A new load or `close` aborts the old
request, and `close` without one throws IOError #2029 as Flash does; reads use the
runtime's ByteArray DataInput implementation. Relative
URLs resolve against the main SWF until the runtime tracks the creator of
each stream.

`Socket` uses an optional host transport supplied to `Scripting`. The host
opens the TCP connection and reports open, bytes, close and failure; the
player delivers those reports on its next frame. ActionScript's reads and
buffered writes use ByteArray's DataInput/DataOutput implementation; `flush`
sends the pending bytes. A local close invalidates late host reports and
does not dispatch `CLOSE`, while a remote close does. Without a socket host,
connect fails on a later frame; reads, writes and close on an invalid socket
throw IOError #2002. The browser player has no default raw TCP transport:
an embedding page must provide one through its own permitted bridge.
`@swf2es/player-hosts/node` supplies a direct Node TCP transport;
`@swf2es/player-hosts/websocket` sends binary frames through a WebSocket
relay whose URL the embedder chooses. They live outside `player` so its
browser entrypoint has no Node I/O dependency. WebSocket message boundaries
are only transport chunks; ActionScript reads the resulting byte stream.

The Flash cases use `loadBytes`, the inner SWF carried in the outer's
script as base64; the oracle runs under AIR, which refuses code from
bytes unless the `LoaderContext` has `allowCodeImport`, which Flash
Player does not need.

The player's application domains are the runtime's and the compiler's
(see the runtime's builtins and Linking). The root is Flash's system
domain, the player's own classes; the main SWF loads into a child of it
(`Scripting.mainDomain`), so `new ApplicationDomain(null)` sees none of
the main SWF's classes, and the main SWF's `parentDomain` is null, as
Flash hides the system domain. A Loader loads into its `LoaderContext`'s
`applicationDomain`, or by default into a new child of the domain of the
code that asked: the parent cannot see the loaded SWF's classes by name,
a class it defines again is ignored for the one its domain's chain has,
and `LoaderInfo.applicationDomain.getDefinition` finds its own
(`loader_duplicate_class`). The domain of the code that asks, for
`ApplicationDomain.currentDomain`, `getDefinitionByName` and a load's
default, is `Runtime.codeDomain`'s, so each module is imported under a
`sourceURL` of its own, and the player's own modules load as builtin,
whose frames do not count, as avmplus skips builtin code. SymbolClass
binds a character to the class its name finds in the SWF's domain, by
the module that defines it, so the same name in another domain is
another class; a class keeps the symbol first bound to it, so another
SWF binding a parent's class makes its own timeline's instances of the
class, but `new` makes the first's. `ApplicationDomain.getDefinition`
lets the error of a lazy script's initializer through, running it again
at each call, where `hasDefinition` says false and a lookup by code keeps
the script as run, as avmplus does (`Runtime.definitionNamed`, the
`definitions` case).

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

### Sound state

`SoundTransform` keeps its volume and four channel coefficients on each
AVM2 object. The `pan` getter and setter remain playerglobal's AS3 code,
which derives them from those coefficients. This stores the values scripts
read and write; applying them to decoded audio belongs with sound playback.

### Time

The player keeps a clock of its own, in milliseconds, apart from the
frame count: `getTimer` reads it, and `Timer` fires by it. A frame
stepped by `Player.tick()` moves the clock by one frame's duration at
the stage's frame rate, the first frame's included, so a test that steps
frames gets the same clock every time; a host playing in real time calls
`Player.advance(dt)` with the time passed, which accumulates it and runs
as many frames as it is worth, five at most after a long pause and the
rest let go, as Ruffle paces, so a stall does not become a spiral of
catch-up. It returns how many it ran, and `Player.changes` counts what
may change the picture: each frame, each pointer event, each call from
the page into an ExternalInterface callback, the only scripts that run
between frames, as loads and socket data are delivered in one. A host
draws when it moved, not on every animation frame: at 60 Hz a 24 fps SWF
drew each picture two or three times over, and drawing it once took a
quarter to a third of Chrome's CPU off 32 animated characters, the
pictures alike. Frame pacing and the clock are related but not one counter:
the clock may run on within a frame later, where the frame count cannot.
`getTimer` tells real time, as Flash's does: the whole milliseconds,
truncated, since the `Scripting` was made, by `performance.now` or the
`realTime` clock a host gives, running on while a script does, so that
code timing itself within a frame, as benchmarks and Crossbridge's C
do, sees the time pass, and a game's motion follows the time between
frames. `realTime: null` makes it tell the frame clock instead, rounded
as it was, the same on every run: the player's cases and the corpus
(`tests/player/page.ts`) and the node tests that trace it ask for that.
Timers fire by the frame clock either way; a host playing in real time
drives it through `advance(dt)`, so it never runs ahead of the real one,
and a timer's `getTimer() - start >= delay` still holds.

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

`flash.geom.Matrix3D` keeps its 16 components in a `Float32Array`, in
`rawData`'s column-major order. Its constructor accepts a vector of exactly
16 values; otherwise it starts as the identity. The getter returns a new
`Vector.<Number>` each time, and the setter and copy methods round writes to
float32. `copyRawDataTo` pads a growable vector with zeros out to its index,
as adl does however far, but refuses an index from 2^28 on, a negative one
too, with ArgumentError 2004 before writing anything. This data model and the copy operations stand apart from the display
list's 2D matrices; assigning `Transform.matrix3D` and drawing in 3D still
need their own implementation.

### Bitmaps

`BitmapData` is a pixel store: a `Uint32Array` of ARGB pixels,
premultiplied by alpha as Flash keeps them, so `setPixel32` premultiplies
and `getPixel32` divides back, with the rounding Flash's does (Ruffle's
`bitmapdata_accuracy` tabulates every alpha and value; adl is the judge of
the rule); a bitmap made opaque keeps every alpha at 255, and `getPixel`
answers without the alpha. The constructor refuses a side under 1 with
ArgumentError 2015 and no more: Flash's old limits, 8191 a side and
16,777,215 pixels, are gone (16384 by 1 and 4097 by 4096 both pass in
adl); `dispose` empties the store, after which every read, the size
included, throws 2015, and a second `dispose` is nothing. `copyPixels`
into an opaque bitmap composites source over destination whether or not
`mergeAlpha` asks, as Flash does. `fillRect`, `copyPixels`, `getPixels` and
`setPixels` (ByteArrays of big-endian ARGB), `getVector` and `setVector`,
`clone` and `rect` work on that store, clipped to it, a Rectangle's or
Point's coordinates rounded to the nearest pixel and a half to the even
one, as Flash rounds them (`bitmapdata_rectangle_rounding`). `copyPixels`
copies in place in Flash's order, which within one store reads what it
already wrote in one direction (rows bottom-up only when the copy moves
down without moving left, columns right to left when it moves right;
`bitmapdata_copypixels_self`); an alpha bitmap scales each premultiplied
channel by its alpha, 256 for 255, shifted down 8, and leaves the
destination as it was where it does not reach; compositing is
s + ((d * (256 - sa)) >> 8) a channel (`bitmapdata_copypixels_alpha_*`).
A Bitmap watches its store, held weakly by it, so a pixel set marks it for the renderer
without keeping a Bitmap taken off the display list alive,
which uploads the same texture again; `lock` and `unlock`
do nothing, as a store drawn from each frame needs no batching. A
`Bitmap` is a display object of its own kind (`BitmapObject`): its bounds
are its data's size, and the renderer draws it as a sprite whose texture
is uploaded from the pixels and again when they change, which the store
counts in a version the node compares. Slice one is the store and the
`Bitmap` on the display list. Slice two is the pixel operations that read
and write the store alone, in `bitmap.ts` beside the rest: `noise` and
`pixelDissolve`, whose pseudo-random sequences are Flash's own and fitted
to the values Ruffle's corpus recorded of it; `copyChannel`,
`colorTransform`, `merge`, `scroll`; `threshold`, `hitTest`,
`getColorBoundsRect`, `floodFill` and `histogram`. Each works on the
pixels as Flash does, premultiplied or not as its results show, and each
is checked by the corpus's traces and a case's trace under adl (the
`bitmap-ops` case). The rules fitted: `noise` is Park-Miller's minimal
standard generator (x · 16807 mod 2^31 − 1, a seed of 0 taken as 1 and
one below as −seed + 1), one draw per channel, R, G, B and then alpha on
a transparent bitmap alone, a value `low + r % (high − low + 1)`;
`colorTransform` reads a channel back as p · 255 / a floored, applies
(c · ⌊m · 256⌋ >> 8) + ⌊offset⌋, alpha alike, and writes it premultiplied
as c · (a + 1) >> 8, leaving a pixel of alpha 0 alone; `merge` is
((s · m + d · (256 − m)) >> 8) & 0xFF with the multiplier a uint and
nothing clamped; `copyChannel` from more than one channel copies 0;
`getColorBoundsRect` gives an empty rect where the one pixel found is the
origin; a point or rect `hitTest` never hits alpha 0; `pixelDissolve`
visits the rect, clipped to both bitmaps, in Flash's own order, a Galois
LFSR over ⌈log2 w⌉ + ⌈log2 h⌉ bits whose taps for every width from 2 to
26 bits were read off adl, a state standing for (s & (2^bw − 1), s >> bw)
and skipped outside the rect; each call writes numPixels and returns the
next state; every call writes the origin too, a seed past the states is
taken modulo 2^bits − 1 and 0 starts at the tap, and a count past the
w · h − 1 states a round visits is one round and the remainder, which
gives Flash's seed without its loop (Flash itself takes seconds over
2^31 − 1).
Slice three is `draw` and `drawWithQuality`, in two paths. A
BitmapData or a Bitmap drawn is composited on the CPU, in `bitmap.ts`'s
arithmetic: through the matrix by the inverse of each destination
pixel's centre, nearest or bilinear as `smoothing` asks, the colour
transform as `colorTransform` applies it, then the blend mode (normal,
`alpha`, `erase`, `multiply`, `screen`, `lighten`, `darken`,
`difference`, `add`, `subtract`, `invert`), all clipped to `clipRect` and
the bitmap. Any other display object is drawn by the renderer: the
Scripting has a `drawer` the host sets once its renderer exists, before
the document class is constructed, which renders the object's subtree
through the matrix into a texture of the bitmap's size and reads it back
synchronously, as WebGL's readPixels allows, to composite as a bitmap
source is; without a renderer, as in node, drawing a display object is
not supported. The snapshot renders only the object's bounds through
the matrix, a pixel wider, within the clip and the bitmap, so its cost is
the object's size, not the bitmap's; at 4 × 4 samples a pixel averaged
down, as Flash covers edges at its high quality (`drawWithQuality` takes
1, 2 or 4 for low, medium and high), in a fresh view
that leaves the objects' dirty flags to the stage's. The view borrows
from the stage's what is still current: an object's fills while its
content is unchanged, its lines while its transform on the stage is the
draw's too, and a Bitmap's texture while its pixels are, so a draw of
the stage builds no geometry; it builds lines at the draw's own scale and
renders the whole n times larger, so curves are no finer than on the
stage. The samples are averaged on the GPU, halved by linear filtering
at the corner four texels share, and only the final pixels are read
back; a snapshot is composited unscaled at a whole pixel, which copies
each pixel straight. A 1920 × 1080 stage of 1,500 outlined shapes draws
in about 110 ms on a desktop GPU against Flash's 44 (from 810 before),
most of it the wait for the GPU before the read.
Slice five keeps a bitmap's pixels where they were last written, as
Ruffle does (its `DirtyState`). With a renderer, a store has a GPU
texture in it, one a renderer, made when a Bitmap first shows it or a
draw first renders into it, holding the store's premultiplied ARGB exactly, uploaded and read
back as they are, never premultiplied or divided on the way; every
Bitmap showing the store samples that one texture, nearest, and a
smoothed one a second, linearly sampled copy made on the GPU as the
first changes, since a texture's sampling is its source's in Pixi. A store is newer on
the CPU or on the GPU: a CPU operation that changes it uploads the whole
store before the next render that needs it, as now, while `draw` of a
display object in the `normal` blend mode with no colour transform
renders straight into the texture, the samples averaged as above and
the last halving composited source over at the reach, and leaves the
store newer on the GPU. Reading `pixels`, which every CPU operation does,
first reads the texture back if the GPU's copy is newer, once, so a
script that draws the stage into a bitmap and shows it never waits on
the GPU, and one that then calls `getPixel` waits as before. Any other
draw (another blend mode, a colour transform, a bitmap source) stays
the CPU's, after that read. A store a draw left newer on one renderer's
GPU is read back through that renderer before another uploads it.
Without a renderer, as in node, a store is the CPU's alone. GPU compositing rounds source over in floating point
where the CPU's is Flash's 8-bit arithmetic, which parts by at most 1 a
channel. A texture lives as long as its store: `dispose` frees it, and a
store collected frees it through a FinalizationRegistry; Pixi's texture
collector never unloads it, as a texture newer than its store cannot be
uploaded again. A store larger than the GPU's texture limit stays the
CPU's. A texture starts with no bytes, and a store whose pixels are all
one colour, as a new bitmap's are, is cleared to it on the GPU rather
than uploaded; the scan that tells stops at the first pixel that
differs. The stage of 1,500 outlined shapes above draws into a new
1920 × 1080 bitmap in about 38 ms against Flash's 44, and with a
`getPixel` after it in about 65.
`encode` writes a PNG as Flash does: IHDR, one IDAT and IEND, RGBA for a
transparent bitmap and RGB for an opaque one, each colour divided out of
alpha as floor(c · 256 / a) up to 255, Flash's encoder's own rule, which
adl showed for every alpha and value and which is not `getPixel32`'s.
Only what the file decodes to is Flash's: `fastCompression` filters no
row and deflates at level 1, as Flash does; otherwise each row takes the
filter whose output sums smallest, libpng's heuristic, deflated at level
6 where Flash uses 9. A 1080p frame encodes in about 135 ms fast (Flash
about 120) and 520 ms otherwise (Flash 2.7 s), at 1% more bytes than
level 9. The rect is rounded and clipped as other methods' are, and an
empty one is ArgumentError 2006; a null rect or compressor is TypeError
2007, a compressor not an encoder's options ArgumentError 2004; the file
goes into the ByteArray given, from its position, or a new one. JPEG and
JPEG XR, which Flash also writes, are not supported yet. The
`bitmap-encode` case traces the file and each refusal under adl; fast
compression's file is Flash's byte for byte, as pako and zlib deflate
alike. `getPixels` and
`copyPixelsToByteArray` write their bytes in one pass, about 13 ms for
1080p as in Flash.
Slice six is bitmap fills: a shape's fill of type 0x40 to 0x43 and
`Graphics.beginBitmapFill`. Each maps the bitmap's pixels into the shape
by its matrix (a SWF's in twips, so divided by 20; `beginBitmapFill`'s in
pixels, the identity by default, repeating and not smoothed), and
`bitmap-fills` shows what Flash draws: a repeating fill tiles the bitmap,
a clipped one carries its edge pixels on beyond it, smoothed is bilinear
and not smoothed nearest, and a fill whose bitmap the SWF does not
define is solid red. A SWF's bitmap fill is resolved to its bitmap
character as the shape is read, the bitmaps being defined first, and is
drawn from one store made of the character's pixels; `beginBitmapFill`
keeps the BitmapData's store itself, so the fill shows its later changes,
the shape a view of the store as a Bitmap is. The renderer draws a fill
as a Pixi texture fill in global texture space, the matrix as it is,
sampling a copy of the store's texture kept for the fill's repeat and
smoothing: a texture's sampling is its source's in Pixi, which also
switches any fill's texture from clamping to repeating by its
`addressMode`, so a clipped fill's copy reads as clamping there while
WebGL, which reads each axis's mode, clamps it. Without scripts, a SWF's
images are decoded at `start` too, for its bitmap fills. A bitmap line
(`lineBitmapStyle`, a LINESTYLE2 bitmap fill) still draws its first
colour.

Gradient fills, a shape's linear, radial and focal ones and
`beginGradientFill`'s, are drawn from Flash's own ramp, which adl gives
pixel for pixel (the `gradients` case and `gradients.ts`'s tests): 256
colours, each channel interpolated straight between the stops and
truncated, alpha too, then premultiplied as c · (a + 1) >> 8; in linear
RGB, interpolated in sRGB's linear light, the ends through it too, which
takes 255 to 254. The stops fill the ramp in order, a span that goes
back skipped and the last colour on to the end; no stops are black. A
pixel takes entry floor(256 · t), t read at its top left corner, not its
centre; pad clamps, repeat wraps and reflect mirrors t, as a texture's
clamp, repeat and mirrored repeat do with a ramp of 256 texels. So a
linear gradient is its ramp as a texture of 256 by 1, sampled nearest,
through the gradient's matrix (a SWF's square is in twips as its shape
is, so only the translation goes to pixels) moved half a pixel for the
corner. A radial one is not affine: its texture is computed over the
bounds of what it fills, a texel a pixel up to 512 a side, each texel
the ramp's entry at its corner, so an unscaled shape's pixels are
Flash's and any spread reaches past the gradient's circle; at a focal
point off the centre Flash draws the last stop, at a centred one's
centre the first. `beginGradientFill` refuses a type but `linear` and
`radial` (ArgumentError 2008) and null colours (TypeError 2007), takes
null alphas as opaque and null ratios as even, floor(255 · k / (n − 1));
arrays of different lengths or a ratio outside 0 to 255 draw nothing,
and stops past 16 are left out. The stage's supersampling softens a hard jump
inside a fill, such as a repeating gradient's seam, which Flash leaves
hard. Gradient lines still draw their first colour. Each rule is Flash's
as the `draw-bitmaps` and `draw-objects` cases trace and draw it under
adl: a destination pixel takes the source pixel under its centre,
clamped to the source's edges; the translation is snapped down to
quarter pixels before rasterising, which the 4 × 4 coverage reads exactly
(a move of 0.49 covers three quarters of the left edge pixels); `normal`
is the store's source-over; a Bitmap draws as its data, its own transform
ignored, as any source's is; a BitmapData drawn into itself goes a row
at a time, top down, every pixel of the row read before one is written,
so a move right keeps the pixels and a move down smears rows, while
through a Bitmap of itself it goes in plain scan order and smears both
ways; `alpha` and `erase` do nothing to a bitmap
drawn, which has no layer; `invert` ignores the source's colour; a fill's
alpha is a byte floored, 0.5 being 127, on the stage as in a draw. The
other blend modes follow the W3C's compositing and are judged by the
frame, within 2 a channel.
Slice four is the SWF's bitmap characters: `DefineBits` with
`JPEGTables`, `DefineBitsJPEG2`, 3 and 4, and `DefineBitsLossless` and 2.
`format` reads a tag into either pixels or an image to decode. The
lossless formats are pixels, inflated with the zlib `format` already has:
format 3 a palette of RGB, or RGBA with the 2 tag, and rows of indices
padded to 4 bytes; format 4 15-bit RGB, each 5-bit channel v widened
to v · 8 + 7 and 0 kept at 0; format 5 xRGB, or with the 2 tag ARGB
already premultiplied, which the store takes as it is. The JPEG tags are
an image: the JPEG, PNG or GIF bytes, with a JPEG's stray `FF D9 FF D8`
before its start dropped and a `DefineBits` tag's tables spliced in from
`JPEGTables`. `DefineBitsJPEG3` adds zlib'd alpha, one byte a pixel,
which goes beside the JPEG's colours as though they were premultiplied
already, so a colour above its alpha reads back as 255 (swf2es clamps it
to the alpha, which reads the same and keeps the store valid); a PNG or
GIF in it keeps its own alpha and the tag's is ignored, as Flash ignores
`DefineBitsJPEG4`'s and shows it opaque, though reported transparent. A
PNG's or GIF's alpha is premultiplied with the product floored, and the
bitmap is transparent. The player decodes the images when the SWF is
linked, beside its code, before its scripts run, through a decoder its
host may give and otherwise the browser's: WebCodecs' `ImageDecoder` for
a PNG or GIF, whose frame is copied as it is, straight alpha (its RGBA
conversion goes through premultiplied values and loses low alphas'
colours), and `createImageBitmap` through a canvas for a JPEG, which is
opaque; no JPEG library comes along. Flash's JPEG decoding matches
Chrome's to within 2 a channel at 4:4:4, but at 4:2:0 Flash's chroma is
neither repeated nor interpolated as libjpeg-turbo's is: it is smoother
than both, as IJG libjpeg 7's scaled inverse DCT upsamples it, which a
decoder that gives only pixels or planes cannot reproduce; such a JPEG
differs by some 6 a channel on average and up to 40 at sharp colour
edges, and `DefineBitsJPEG4`'s deblocking is not applied. A decoder of
swf2es's own would close both.
What Flash cannot decode is a bitmap of
0 × 0, not transparent, whose size and `rect` read and which `dispose`
takes, while every other method throws ArgumentError 2015: a corrupt
image, a `DefineBits` without `JPEGTables`, and a lossless tag written
with the short tag header, which Flash refuses whatever its data (the
long header, as Flash Pro writes, takes the same bytes). A class
SymbolClass binds to a bitmap and that extends `BitmapData` is
constructed with a copy of the pixels, the size its constructor passes
ignored (0 by 0 and −5 by 100000 alike); one that extends `Bitmap` gets
a new plain `BitmapData` of them each time. Placed on a timeline with
PlaceObject3's `HasImage`, as Flash Pro places one, a bitmap is a
`Bitmap` of its own copy, smoothing off and pixel snapping `auto`, its
data an instance of the bound class constructed with (1, 1), else a plain
`BitmapData`; without `HasImage` Flash takes the bound class for a
display object's and throws TypeError 2022, which swf2es does too.
A class SymbolClass binds to a `DefineBinaryData` and that extends
`ByteArray` starts with its bytes, at position 0; its instances share
them, each seeing what another writes until one is resized, as under adl
(the `crossbridge-runtime` case). Crossbridge keeps a C program's data
so. That case also has what Crossbridge's start asks of the player: the
domain memory on `ApplicationDomain`, the runtime's one, as avmshell's
`Domain` has it; `Worker.current`, the primordial (`isSupported` is
false, where AIR's is true, as no other worker can start); `Telemetry`,
never connected; and `System.disposeXML`, left to the collector.
Bitmap fills, in a shape's records and through `beginBitmapFill`, and
the filters follow, each by what Flash traces and draws under adl.

### Text

A `TextField` is a display object of its own kind (`TextObject`), placed
by a timeline's DefineEditText or made by a script, 100 by 100 pixels and
empty, as adl makes one. Its text is a `TextModel` (`text.ts`): the
characters, `\r` between lines as Flash keeps them (`\n` is made one),
each with its own format, and a default format, Flash's Times New Roman
12 for a new field and the tag's for a timeline's (its font's name from
the DefineFont2 or 3 it names, its height, colour, alignment, margins,
indent and leading). `text` and `htmlText` set the text in the default
format; `appendText` and `replaceText` put theirs in the format of the
character before; `getTextFormat` of a range gives null for what its
characters differ in, and `setTextFormat` sets what a TextFormat sets.
`htmlText` is written as adl writes it: a `P` for each paragraph (an
`LI` alone for a bullet's), in a `TEXTFORMAT` for its margins, indent,
leading or tab stops, with a `FONT` of all five font attributes and,
for each later run, a `FONT` inside it of what changed; `A`, `B`, `I`
and `U` about a run's text, in that order out to in. It is read as adl
reads it, a paragraph's end and a `BR` a line only in a multiline field.
A TextFormat keeps each value as Flash converts it, null for one it does
not set: whole numbers rounded, a half away from zero, `align` one of
Flash's or ArgumentError 2008, an unknown `display` null. The `text-fields`
case traces all of this, defaults, HTML and refusals, against adl.

Setting a TextField's `width` or `height` resizes its field, as Flash
does, not its scale. The renderer draws the background, the border over
the pixels at both edges, then the text as its layout (below) places it,
from the line scrolled to and no line that fits only part of the way,
clipped inside the gutter: a character of an embedded font as its glyph's
fill, a shape made once for the glyph and shared by every character
drawn in it, scaled to its size, tinted its colour, and moved by its
pair's kerning (its boundaries stay); a run of a device font in one
format as one Pixi Text on the line's baseline. A device font
(`_sans`, `_serif`, `_typewriter`) is the browser's of that kind, any
other by its name. Bullets, underlines, input and selection are still
to come.

A field's text is laid out by swf2es, as Flash lays it out, never by the
browser: lines, and each character's place on them, are what
`textWidth`, `textHeight`, the line and character queries and
`autoSize` report, and what the renderer draws. A font embedded with
`embedFonts` is a DefineFont2 or DefineFont3, found by name, its own
size and its advances, kerning, ascent and descent from the tag, so its
layout is Flash's to the twip. adl, with fonts of rectangles built by
the tests' SWF writer, sets the rules. A character's advance is its
glyph's at the format's size, which is a whole number, truncated to
twips, plus `letterSpacing`. A kerning pair, with `kerning` on, shortens
the second character's advance. A character the font lacks takes no
room and has no boundaries; a font's characters are found by a binary
search of its code table. A line is as tall as its tallest run's ascent
and descent, each truncated to twips, plus the format's `leading` (not
the font's); its width counts its trailing spaces. Lines break at a
newline, and with `wordWrap` before a word that does not fit without
its trailing space (one ending at the room's edge fits), or between
characters for a word longer than the line. A line starts 2 pixels in,
the gutter, then the margin, block indent and, on a paragraph's first
line, its indent, and a bullet's 36 pixels; centred, it is placed in
the room left, right-aligned one twip further left, and justified, a
wrapped line but the paragraph's last has its inner spaces share the
room. `textHeight` is the lines' heights, leading and all, less the
last one's leading where there are two lines or more; a last line left
empty by a newline does not count. adl's `numLines` can lag a
relayout until the next one, which swf2es's does not; tab stops, and
the boundaries adl leaves out for lines beyond the field's height, are
still to come.
`autoSize` makes the field the text's size and 4 pixels, keeping its
left, centre or right edge. A device font's metrics are the browser's
font's, measured by the host, which Flash's own system fonts differ
from.

### Colour transforms

A colour transform acts on what each shape, bitmap and text field draws
under it, not on a sprite's children composited first, as adl draws it:
each fill's colour, straight rather than premultiplied, is multiplied and
offset channel by channel, alpha too, and clamped to 0–255. An alpha
offset so shows a fill of alpha 0, while a bitmap's fully transparent
pixels stay transparent. A gradient's stops are transformed and its ramp
made from them. Nested transforms apply the child's first, then the
parent's: (c · m₁ + a₁) · m₂ + a₂. The renderer keeps Pixi's tint and
alpha for a transform that only multiplies, by 0 to 1, as most do. Any
other, with an offset or a multiplier beyond 0–1, sends what is drawn
under it to a batcher of swf2es's own, whose shader takes each vertex's
whole transform, concatenated from the stage down, and applies it to the
straight colour; such objects still batch together. A gradient there is
transformed pixel by pixel, which clamps after the ramp where Flash clamps
its stops, so the two part only where a transformed stop is clamped.

### Blend modes

adl composites an object with a blend mode as a layer, its children
together in the normal way, and blends that with what is below, the
stage's colour included, where Pixi would blend each child on its own.
The renderer gives such an object a filter (`pixi-blend.ts`): `layer`
one that only makes it a layer, any other one that reads the back buffer
and computes the mode in premultiplied colour, its result replacing what
is there. Multiply, screen, lighten, darken, difference, overlay and
hardlight are the separable blends of the straight colours, composited
source over; `add` adds and `subtract` takes the object from what is
below, each clamped; `invert` inverts what is below as far as the
object covers it; `alpha` and `erase` scale the layer below by the
object's alpha, or by what it leaves, only where the object has any.
The `blend-modes` case draws each over two grounds against adl. Pixi
reads the back buffer only from a renderer made with `useBackBuffer:
true`, which a host passes (the README's embedding example does);
without it the modes draw as normal, and the view warns once. The back
buffer is a full-screen copy a frame: on the bench (`--back-buffer`, an
RTX 4060) it adds some 0.05 ms to the draw.

### Filters

A filter object keeps its values as adl converts them, in a record of its
kind's (`filters.ts`): blurs clamped to 0–255, NaN kept; quality and a
convolution's size whole and clamped, to 15; alphas in 255ths; colours 24
bits; strength in 256ths, to 255; an angle within a turn either way,
through radians and back; a convolution's divisor, bias and matrix, a
colour matrix and a displacement's scale as floats, the colour matrix 20
values and a hole in it 0; a gradient's stops at most 16, its colours
setting their count, its alphas filling to it with 1, its ratios making it
fewer; a number past an int's range, as x87 converts it, 0. A display
object holds records too, from its `filters` or a PlaceObject3's list (a
bevel's highlight before its shadow, as adl reads it), and gives copies
back, so `filters === filters` is false and a filter changed after it was
set changes nothing. BitmapFilter is abstract, and restricted: a script's
class extending it is refused, while one extending a filter of
playerglobal's is made.

BitmapData's `applyFilter` filters on the CPU, as adl computes
(`bitmap-filters.ts`): the source's premultiplied channels, past the
source rect too as far as the bitmap goes, filtered, and the filter's
rect of them written whole into the destination, moved to its point and
clipped; an opaque destination keeps its alpha, and refuses a glow, a
shadow, a bevel and the gradient filters with IllegalOperationError
#2077. `generateFilterRect` grows a rect each way by the passes' spread
times the blur, a blur below 1 counting as 1: Ruffle's per-quality
spreads (1.0, 2.1, 2.7, 3.1 … 7.0) as floats, halved, rounded up from a
quarter for a blur and half to even from a half for the others, as x87
rounds, which the `rect` lines of `apply-filter` pin; a shadow's, inner
too, by its offset in whole pixels (to the nearest 256th, then down) on
the side it moves to, less it on the other, never inward; a bevel's by
the offset's size both ways. At high qualities the rect is less than the
passes' reach, and cuts what they spread. A blur is a box of fractional width, its end pixels weighted by their
part, run along x and then y `quality` times, each value truncated to
8 bits. A glow's alpha is that blur of the source's alpha (of 255 less
it, for an inner one), truncated, times strength to 255 and alpha, over
or under the source as the display's are; a shadow samples it from its
offset between pixels, linearly with weights in 256ths. A colour matrix
maps straight colour, rounded, the pixels about what the source has
premultiplied truncated and the rest of the rect the map of a
transparent pixel. A bevel is the source's alpha so blurred, read from
its offset on and back between pixels, as a shadow reads; their
difference times strength, to 255, times the colour's alpha, rounded, in
the highlight colour where on is more and the shadow colour where it is
less. Inner, it lies atop the source, which keeps its alpha; outer,
behind it; full, over it; knocked out, alone, masked to where the source
is (inner) or is not (outer); each over another as the store draws it,
s + d × (256 − sa) / 256 truncated. Off the axes adl reads the offset
about a 256th further out, which swf2es does not find a rule for: there
a channel may be 2 off, so the `bevel` case, to the bit, keeps to the
axes, and `bevel-draw` has the angles between. A gradient glow is a
glow's alpha (from its offset back, as a shadow's) times strength, to
255, picking its colour and alpha from a 256-entry table of its stops,
built as a gradient fill's ramp; a gradient bevel's difference, times
strength, picks entry (d + 256) / 2, so where on and back agree, outside
the source too, it takes the middle. With no stops either draws nothing
but the source. Both place their layer as the bevel does, masked by
rounding, (c × m + 127) / 255; a gradient glow's rect is a shadow's, a
gradient bevel's a bevel's, and as the table may have colour at 0 they
fill it. A displacement map moves each pixel of the source rect by the
map's channels there, read unmultiplied, the map placed at the rect's
corner and its point, the one named channel less 128 times scale, in
256ths toward 0 (none named, or several, moves nothing); it reads the
source between pixels, the four corners' weights in 256ths each
truncated; past the rect as the mode says: wrapped, clamped, its own
place where the whole pixel it lands on is past it (ignore), or the
filter's colour; where the map is not, or there is none, it keeps its
own. Its rect grows by a quarter of each scale, whole, and none with no
map; `generateFilterRect` takes any filter's rect within the bitmap first,
and a displacement's result within it too. applyFilter writes the rect
alone: adl, displacing a rect moved elsewhere, fills its grown rect from
the rect's corner, shifted, and into an opaque destination leaves alpha,
quirks swf2es does not take on. The map is read as it is when applied.
The `apply-filter` case matches adl's numbers to the bit.

A convolution grows the rect by half its matrix, rounded down, each way.
Its taps read the source's straight colour, unmultiplied as getPixel32
does, past the source rect too: only past the bitmap's edge does a tap
take the nearest edge pixel, or with `clamp` false the filter's colour.
The kernel is not flipped: tap (i, j) of a matrix x by y reads the pixel
(i − ⌊x/2⌋, j − ⌊y/2⌋) from the one it makes. The sum is divided (a
divisor of 0 counts as 1), the bias added, each channel clamped and
truncated; `preserveAlpha` keeps the source pixel's alpha, else alpha is
summed as the colours are; the colour is then premultiplied by that
alpha as setPixel32 does, or kept straight in an opaque destination.
adl takes another way for a 3 × 3 kernel of whole weights whose positive
and negative sums each stay within 127, with a divisor from 1.1 (all
weights positive) or past 2.0001 (any negative), at pixels whose taps
all lie in the bitmap: in fixed point, the integer sum times 65536 ÷
divisor, truncated, plus one, wrapped to a short, shifted down 16 bits,
the colour premultiplied truncating. The wrap makes a divisor of 1.1 to
2 turn and shrink the weights (by 2 they negate), and that way's last
tap reads the centre pixel, not the one right and down of it. Both ways
are in `bitmap-filters.ts`, and the `convolution` case matches adl's
numbers for each, to the bit. A matrix with no taps (0 by anything, the
default filter's) copies instead: as much of the source as the grown rect
is big, from the source rect's corner, to the grown rect's corner, over
an opaque destination's pixels; what lies past the source stays as it
was.

The renderer draws a display object's blur, glow, drop shadow, colour
matrix, bevel and convolution as adl does (`pixi-filters.ts`), before its blend mode: a blur is
a box blurX by blurY pixels wide, the pixels at its ends weighted by how
much of them it covers, run `quality` times each way and truncated to 8
bits each time, so that blur 2.5 weighs 0.3, 0.4 and 0.3, and the filter
reaches quality × blur / 2 pixels out. A glow is the object's alpha so
blurred, times strength (clamped to 1) and alpha, in its colour, drawn
behind the object, or, inner, one less that inside it over the object;
knocked out, the object is left out. A drop shadow is a glow from
distance × (cos, sin) of its angle back, and with `hideObject` drawn
alone. A bevel is the object's alpha so blurred, read at its offset on
and back, as applyFilter has it, each pixel evaluated once at its centre;
a gradient glow and a gradient bevel pick from their table, a texture
256 wide, and draw only within the filter's rect of adl's bitmap of the
object, its pixels and one more right and down. A displacement map
reads the object's pixels as applyFilter reads the source, with the map
as it was when the object's filters were set, as Flash copies it then
(reading them back gives the live map, and setting them again takes it
anew); one with no map makes no pass. In colour mode it fills half the
scale round the object with the colour, as adl draws it.
A colour matrix maps each pixel's straight colour, offsets in
255ths, transparent pixels within the object's bounds too. A convolution
filters, as applyFilter does, a bitmap of the object's pixels and one
more right and down, its edge pixels clamped or coloured past that, and
draws the rect so grown; each pixel's texels read its centre alike. One
with no taps moves the object up and left by half the other size, a
single tap there. (adl's copy then reads a row past its bitmap and draws
what memory lies there; swf2es leaves that row transparent.) The
passes
are Pixi filters at the target's resolution, for WebGL: under WebGPU,
where Pixi would skip an object's whole chain for one it cannot run,
they are left out and a blend mode is kept. A view made for one draw
destroys the filters it made with it.

### Masks and scroll rectangles

A mask clips what it masks to where its fills are, as adl draws it: the
fills alone, whole, whatever their alpha, the object's alpha and colour,
or `visible`; lines draw nothing, and a Bitmap clips to its rectangle,
transparent pixels and all. Masks nest, each clipping inside the other.
A timeline's mask is a child placed with a clip depth: it is not drawn,
and it clips the children after it in render order until one placed at a
depth beyond its clip depth. A child a script puts among them, or after
them where nothing deeper ends the range, is clipped with them. Removing
the mask ends the range. `mask` set on an object makes the
other object its mask: not drawn, wherever it is. On the display list it
clips through its own place there. Off the list it clips through its own
matrix, taken in the stage's space. One mask clips one object, so
setting it on a second takes it off the first, whose `mask` is then
null. Neither kind changes bounds or `width`, and a shape hit test
follows `mask` but not a timeline's masks; a mask itself is never hit,
and a Bitmap, masking or not, is hit over its whole rectangle. The renderer gives each
mask to Pixi as a stencil: a timeline's range goes in a container whose
mask is the clip-depth child, and a mask's lines are hidden while it
masks. When both objects are cached as bitmaps Flash clips by the
mask's alpha; that, and a text field as a mask, are still to come.

`scrollRect` is kept as set, its edges rounded to whole pixels half to
even, so its width and height are the rounded right and bottom less the
rounded left and top. It takes effect at the next render, as Flash's
does. From then on the object is drawn shifted by the rectangle's left
and top and clipped to it, and its bounds in its own space are the
rectangle's size at (0, 0). Its points go through the shift, in its own
`localToGlobal` and below, but its `concatenatedMatrix` leaves its own
shift out, as Flash's does, while its children's take it in. A hit
test misses outside it.

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
  `tests/programs` also builds C, LZ4's from the com-lz4-as3 submodule
  with a driver of its own (`tests/programs/lz4`), with the image's
  Crossbridge, and runs it as avmshell's projector and its ABC in
  swf2es. That avmshell has Crossbridge's ShellPosix, which swf2es's
  shell has not, so its start, which then goes as in a player, is left
  out of the comparison.
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
  compared to Flash's line by line. The page runs the runtime as the
  debugger player, since Ruffle recorded its traces with one and adl is
  one: an uncaught error's line carries its text, "Error #1010: A term is
  undefined and has no properties.", where the release player's and
  avmshell's has the number alone. `baseline.json` records each test's
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

### Fuzzing the compiler

The JIT compiles whatever bytes a SWF holds, so codegen must reject any
malformed ABC with a VerifyError, never trap. `tests/fuzz/abc.ts` mutates
seed ABCs (the unit tests' hand-built ones and the conformance cases) a
few bytes at a time, mostly toward the end, where the method bodies are,
and checks that the compiler does not trap, that a module it accepts
imports as an ES module, and that each of its methods compiled alone is its
entry in the module. A seeded generator makes a run repeat; a failing case
is written to `tests/fuzz/out/failures/`. `pnpm test` runs a short round,
`pnpm test:checked` the same in the build that checks every array access,
which catches a read past a table's end the release build lets through.

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
