# The compiler

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
   of its own version and series, so AIR-only and VM-internal names stay
   hidden. The version a domain is reset with picks the series: Flash
   Player's 50 by default, AIR's 51 for an AIR host (the player's `air`).
   Every namespace's version moves into that series as it is interned, as
   `AvmCore::newNamespace` moves it, so a lookup and the binding it finds
   compare versions of one series; in AIR's, a Flash Player version
   becomes the next AIR one. While an ABC loads, its classes link
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
   An application domain the runtime has let go of is dropped with its
   descendants (`dropDomain`), and one the host has no use for now, as
   once its ABCs are compiled, is evicted with them (`evictDomain`): no
   other sees their ABCs, which compile no more and keep their indices.
   `compact` rebuilds the domain only when that keeps codegen's memory
   from growing: when the tables, by an estimate from their rows, with
   what a compile's garbage and the rebuild itself take, come near
   memory's size, and those ABCs weigh 4 MB and enough to bring them
   back below. Before that a rebuild would reclaim nothing that matters,
   as wasm memory never shrinks. `usage` tells the estimate, and
   `compact` asks the same before it collects and rebuilds; a host calls
   it when it has time, as the player does when idle. A rebuild
   links the live ABCs again, in their places, and does again, where it
   happened, what the domain has logged: each finding recorded, and the
   first answer to what resolves lazily, a traits' types, a method's
   signature, an ABC's first verification and the scopes it finds. Those
   see the ABCs there were when first asked; an ancestor may define the
   same name since, which a lookup would find now. So a live ABC links,
   resolves and compiles as it did, since no ABC let go of was ever seen
   by it, and the collector frees all the others took, the names only
   they spelled included: wasm memory never shrinks, but what was freed
   is used again. A rebuild of a large application's domain takes tens of
   milliseconds, its first verifications most. An evicted domain is
   revived (`reviveDomain`) with its evicted ancestors, the first a child
   of a live domain, given their ABCs again if a rebuild let go of them:
   one rebuild links them in their places, their log done again with
   them. `reset` counts an epoch, which `dropDomain` checks, so that a
   drop meant for a domain of before a reset does nothing.
3. **Verifying a method**, when it is first compiled: its signature's types
   and its bytecode.

An ABC with errors in more than one stage may report a different first
error than avmshell. Well-formed ABCs are unaffected.

## Compiling a method

Each method goes through the same steps, in `codegen`:

1. **Decode** (`abc/code.ts`): the reachable instructions, as the avmplus
   verifier reads them.
2. **Verify and build the IR**, as avmplus' `Verifier` does its checks,
   with its VerifyError numbers (`abc/code.ts`; each instruction's checks
   `abc/verify.ts`, its types `abc/typing.ts`, and for finding, getting,
   setting and calling properties `abc/properties.ts`; branch and handler
   targets and their entry states `abc/targets.ts`). A first pass keeps a frame state per block
   (the locals, scope stack and operand stack, each value with its type,
   whether it is known not null, and whether it is a with scope), merges it
   where control flow joins, and walks a block again when its entry state
   changes, until none does. avmplus knows a value not null after a null
   check of it, but not the local it copies, so a frame state also keeps
   which locals are neither null nor undefined at run time: checked since
   they were last set, as a copy of them on the stack was, or compared with
   a `pushnull` or `pushundefined` (`==`, not `===`; a value only typed
   void, as a native's result, may be anything) or tested true where a
   branch goes on, on every path in; a handler gets the locals as they were where its range threw.
   That takes away only checks that cannot fail, and changes no type the
   verifier sees. A second pass walks the blocks in code order
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
   method's frame, its entry checks and how it reads and writes registers
   are `emit/method.ts`'s; its blocks, written an instruction at a time,
   `emit/blocks.ts`'s, and its handler regions and catch
   `emit/handlers.ts`'s. Its instructions are `emit/instructions.ts`'s,
   those of the object model (scopes, properties, calls, construction)
   `emit/objects.ts`'s; arithmetic, comparisons and conversions
   `emit/values.ts`'s, domain memory `emit/memory.ts`'s, how types,
   namespaces and constants are named `emit/refs.ts`'s, and the module
   around the methods `emit/module.ts`'s.

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

Scope and stack registers that only copy another register or a constant
are not written: a `getlocal`, `dup`, `getscopeobject`, `getglobalscope`,
the IR's nip, or a `pushscope` of a local leaves its register a copy, read
as what it copies, until that changes. A forward dataflow over the blocks
(`emit/copies.ts`) finds the copies each block is entered with on every
way in, a loop's back edges included, so a branch writes only the copies
its target does not know; locals are always written, so a handler, which
starts with none, finds them as they are wherever its range threw. A value
the next instruction only moves to a local or a scope (a `setlocal` or
`pushscope`, after conversions that change nothing) goes there straight;
one it duplicates to set a local (`dup; setlocal`) goes to the local, and
the stack register is its copy. A conversion that changes nothing writes
no code.

The code is written short where that costs nothing at run time:
`undefined` is `void 0`, and a return of it a bare `return;`, each of
which V8 compiles to the same bytecode as `undefined`; and registers a
run of `kill`s or `popscope`s leaves undefined are one statement,
`sc2 = sc1 = l3 = void 0;`. A method's code is not indented: it was
not nested by its blocks either, only shifted, a tenth of a module's
bytes; each statement keeps a line of its own, for stacks, the source
map and a debugger's steps.

A null check is `r ?? nn(r)`, where `nn`, the module's, throws the
runtime's TypeError for the value, 1009 for null and 1010 for undefined.
It is made where the instruction it checks for reads the register, when
that instruction reads it before doing anything that can throw or be
seen, as a property's get, set or call does: `s0 = (s1 ?? nn(s1)).$2`,
`rt.getProperty(l1 ?? nn(l1), M[3])`. Otherwise, as when a conversion
of an argument comes between, it is a statement of its own, `s1 ??
nn(s1);`. A method's count of arguments is checked first, as avmplus'
`argcOk` does, and its ArgumentError 1063 thrown by the module's `ac`:
`if (arguments.length - 1 >>> 0 > 2) ac(1, arguments.length);` for one
to three. Neither `nn`'s frame nor `ac`'s is named with a `$`, so the
stack a host is shown starts at the method, as before.

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
  property access and cannot collide with any dynamic name. They are set by
  name, by a function the module has for each traits (`fill`, see below):
  V8 makes an object a dictionary once stores by a computed key give it a
  seventeenth property, and every access to it a lookup. The function sets
  the slots highest first, the base's included, so a class's objects keep
  one shape, and as each class has its own, its stores see that shape
  alone and stay inline. It is code in the module, not made from text at
  run time, so a page without 'unsafe-eval' runs it too. Objects of a class
  of 24 slots were made nine times as fast so, and read four times as
  fast; of 5 slots, made a third faster.
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
- **Inline caches**: each multiname a module makes keeps what its lookups
  found on the traits of the objects they were made on, for up to eight
  traits (`property-cache.ts`): the binding, as the slot's field and type, the
  getter, setter or method, or that it is a dynamic property's. The next
  get, set or call of the name on an object with those traits does that
  directly, which is what the lookup would decide, since that depends only
  on the traits and the name, whose namespaces and versions are fixed. A
  dynamic property's entry still looks for it on the object, and leaves
  the prototypes to the full lookup. Describing traits, and setting up a
  class's or script's methods and hooks, bumps an epoch that empties every
  cache, and so does a Loader's unload. An entry holds its traits and
  their code, so emptying drops those references at once, not as the name
  is next filled: otherwise a name the main SWF used on a loaded SWF's
  objects would keep that SWF alive after its unload. A name that has
  replaced 16 entries keeps the ones it has until the epoch moves, as a
  name seen on more traits than it keeps would otherwise replace one on
  every miss. A primitive's bindings are cached by its class's traits, not
  its prototype's properties. Not cached: a name made at run time, a name
  a hook resolves (a Proxy's, XML's), an element's index and a
  Dictionary's key.
- **A class object** is an instance of its static traits, whose base is
  Class's instance traits; it holds its instances' traits (`$it`) and its
  AS3 `prototype`. Class is dynamic, so class objects are, as the builtins
  need (`String.fromCharCode = function ...`).

Values are JavaScript's own: `undefined`, `null`, numbers for `Number`,
`int` and `uint`, booleans, strings. AIR's scalar `float` uses `FloatValue`
with a binary32 payload, rounded by `Math.fround` when produced. The tag
preserves its identity through `*`, calls, properties and arrays: AIR treats
`float(1) === Number(1)` as false. Two float operands produce a rounded float;
a mixed float/Number operation produces Number. Known Number arithmetic
keeps its direct JavaScript operators. Float values crossing method and
object/array storage boundaries use small tags; zero, negative zero and NaN
are shared. Locals known to hold floats at every use, and float temporaries
within a basic block, keep their payloads as JS numbers, with `Math.fround`
at float operations. Live temporaries crossing control-flow edges are boxed;
locals with mixed or unknown types keep the general tagged representation.
Typed float-vector accesses also read and write unboxed payloads.

AIR ABC 47.16 and above insert one scalar float pool after the doubles;
current AIR omits the experimental Tamarin float4 pool. The scalar
`pushfloat`, `convert_f` and `unplus` instructions are version-gated, and
`float4` instructions remain rejected. The separate builtin `floatLibrary`,
generated from `as3/builtin/src/float.as`, declares the primitive beside the
Flash builtins without replacing them. The player and CLI load it once on demand
when AIR float bytecode is encountered, before adding any ABC of that SWF;
direct compiler/runtime users can supply
`avm2.floatLibrary` as a builtin after `builtin.abc`. AIR's AMF3 float and
float-vector markers are preserved, including signed zero and NaN. The
`air-float` player case holds AIR's reference traces; its source is under
`tests/conformance/cases/air`, outside the avmshell-only runner.

A namespace value is the runtime's
interned namespace, whose class is Namespace. Arrays and most Vectors keep
their elements in a JavaScript array, `$a`. For `Vector.<float>`, `$a` holds
a `FloatVector`: a `Float32Array` buffer, a logical length and spare capacity
grown by about 1.5x. Explicit-length construction allocates exactly that
length; setting length to zero releases the buffer. Dynamic reads and
callbacks box their float values, while enumeration, JSON and AMF respect
the logical length and float identity without storing a tag per element.
A script's global object is an instance of its traits like any other.
Errors thrown by the runtime are AS3 `Error` objects with avmplus'
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
  use; a factory names only the parameters its method uses, `() =>` for
  one that uses neither;
- **traits**: for each class, its base class and interfaces by name,
  resolved when the class is created as avmplus resolves them, its own
  bindings by namespace and name, its slots' defaults, and its methods,
  getters and setters by dispatch id; and, for traits of up to 128 slots,
  `fill: (o, v) => { o.$n = ...; ... o.$0 = ...; }`, which sets a new
  object's slots, its base's too. A value is a literal where it is one
  however the module is compiled, a type's default or a constant of the
  module's own ABC; a namespace, or a base's constant from another ABC, it
  takes from `v`, the runtime's initial values by slot. Traits without one,
  a catch scope's or past 128 slots where V8 keeps no object fast, are set
  by key;
- **scripts**: each script's traits and initializer, run the first time
  something asks for a name it defines, as avmplus runs them.
- **hash** and **linked**: the hash of its ABC and of the ABCs loaded
  before it that its application domain sees, in order (`domainLinked`). Its layouts depend on
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

### Optional lazy compilation

The default player compiles each ABC whole when it loads (see [A SWF's
code](player.md#a-swfs-code)). `new Scripting(codegen, { lazyCompilation: true })`
opts into compiling uncached AVM2 bodies on first factory use. The web
embedder exposes the same option through `configure({ lazyCompilation:
true })`. It remains experimental and off by default.

The module's names, layouts, scripts and verification are prepared before
execution, so their scopes resolve against the same domain as eager code.
A lazy factory compiles its entry once, replaces its slot in F and returns
the entry's original function. Later calls run that function directly;
creating another closure may revisit the cached factory. Native methods,
missing bodies and verification errors retain their eager factories. AOT
still emits whole modules. Existing whole modules in the module cache are
consumed normally; partial lazy modules are never written to that cache.
The compiler must belong to this player for its lifetime: resetting it
rejects a later deferred compile rather than using another movie's ABC.

Entries transfer from Wasm as UTF-8. The wrapper collects after a lazy
skeleton, after memory growth, every 64 calls, or 256 KiB of method source
since the last collection.
It does not collect after every method, which costs substantially more.
Verification results are kept per lazy ABC, cleared when its domain is
dropped or evicted, and regenerated after a compiler-domain rebuild.
Lazy mode retains compiler domains until runtime-domain collection instead
of evicting them immediately after linking: deferred bodies still need their
ABCs. Normal domain dropping and idle compaction still apply. Destroying
a player clears shared property caches so their last getter or method
cannot keep the destroyed player alive.

The first method request is not the first verification: verification runs
when the module's skeleton is built. It still verifies the ABC as a whole,
so lazy mode does not eliminate this startup cost. Dynamic Function entries
need identifiable stack frames; unsupported engines and policies fall back
to whole-module compilation. Per-method sourceURLs have the form
`swf2es-26.js/$f63.js`; frame parsing maps them to their module for both domain
lookup and caller security checks. Class-reference tables are built under
the original module's domain, even when another SWF is loading.

Each entry is built with a strict `Function` whose parameters are the
module's tables and helpers (`rt`, `nn`, `ac`, `ns`, `cls`, `N`, `S`, `M`,
`V`, `F`, `A`). This keeps their lookups lexical, as in the eager module;
direct `eval` would instead introduce dynamic scope lookups. Strictness
matches the original ES module. The entry itself is byte for byte its
factory in the whole module, the same JIT/AOT invariant the compiler's
method-at-a-time tests enforce.

See [the AVM2 benchmark](../benchmarks.md#avm2-eager-and-lazy-compilation) for
startup, first-use and warmed measurements. The potential saving depends
on which factories the application binds: methods bind when a class or
script is initialized, and a nested function when `newfunction` runs, not
on each ActionScript call. A class whose every method is bound immediately
may gain little while paying additional per-entry compilation costs.
