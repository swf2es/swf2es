# The runtime and the standard library

Generated code calls `@swf2es/runtime` for the object model, multiname
lookup, coercions and exceptions (`packages/runtime/src/avm2`); it grows as
far as each step needs. The engine is at the top. `runtime.ts` is the
`Runtime` class, whose methods are what compiled code calls as `rt`:
property access, calls and construction, coercions, for-in, exceptions and
domain memory, with the inline caches' hookup. Around it, each a model of
its own or a stage the hot paths do not run through: `descriptors.ts`, the
values and descriptors a compiled module is built against; `options.ts`,
what a host gives a runtime; `hooks.ts`, what a builtin or a player's class
plugs in to allocate, index, resolve names or be called; `traits.ts`, the
layout model (`Traits`, the binding kinds, the class and Vector references);
`domain.ts`, application domains and the lookup of a name along a domain's
chain; `modules.ts`, the modules loaded into them and which module's code
a stack is in; `definitions.ts`, definitions by qualified name, as a host
and `ApplicationDomain.getDefinition` look them up; `method-factories.ts`,
the natives and the methods with no generated body as a module binds them;
`classes.ts`, OP_newclass, which makes a class from its descriptor, and the
Vector.<T> classes; `enumeration.ts`, the names a for-in goes through;
`property-cache.ts`, the inline caches, and `cache-fill.ts`, what a full
lookup leaves in one; `array-conversion.ts`, Number(array) while Array's
conversion is the builtins'; `errors.ts`, error messages and the stack a
host shows for an AS3 error; `amf-classes.ts`, class aliases and the
classes AMF makes; `names.ts`, namespaces and multinames; `number-strings.ts`,
numbers to and from strings as ToNumber and ToString convert them; `numbers.ts`,
`messages.ts`, and `amf.ts`, which ByteArray and later the player's
networking use.

The builtins' natives are in `natives/`, a file per
family of classes (`object`, `array`, `string`, `regexp`, `number`,
`vector`, `bytearray`, `date`, `json`, `dictionary`...), registered in
`natives/index.ts`, with what makes some builtin classes differ from others:
Arrays' and Vectors' element storage, and what calling or constructing
`int`, `String`, `Object`, `Array` or a Vector does. A Dictionary keyed
weakly (`new Dictionary(true)`, `weak-keys.ts`) keeps no key alive, as
Flash's does not: its values in a `WeakMap`, its keys' order as `WeakRef`s,
and a for-in's names of its keys held weakly too, so that a for-in left off
keeps none. Kept strongly, an application's registry of display objects in
one held every room's clips, which played on as orphans. avmshell's own classes,
which a player has not, are in `natives/shell.ts`. playerglobal is the
player's (`packages/player/src/playerglobal/flash/display/...`, a path per
package, so a class's file follows from its qualified name).

The debugger player's error messages are avmplus' own, generated from its `ErrorConstants.cpp` into `messages.ts`, which
stays MPL-2.0, and Flash Player's own over them, 2000 and up, generated
into `player-messages.ts` from the table Flash itself prints as
`Error.getErrorMessage` of every number (Ruffle's corpus,
`error_geterrormessage`); the release player and avmshell print the
number alone.

Where avmplus' behaviour is its own algorithm rather than a language rule,
the runtime translates it, so that its output is avmplus' byte for byte:
number formatting (`numbers.ts`), Array's sort (`natives/sort.ts`),
ByteArray with its capacity and UTF-8 (`natives/bytearray.ts`), AMF3
(`amf.ts`), JSON (`natives/json.ts`), Date's formats (`natives/date.ts`),
XML (`natives/xml/`: `chars.ts` and `parser.ts` tokenize text, `node.ts`
is the tree, `build.ts` makes trees from text and values, `values.ts` the
XML and XMLList objects, `names.ts` their names, Namespaces and QNames,
`access.ts` E4X's internal methods, `strings.ts` toString and toXMLString,
`operators.ts` == and +, and `xml.ts` the classes' hooks and natives) and
describeType (`natives/describe.ts`).
Each of these files is MPL-2.0, as its source is, and says so at its top.
avmshell's `File` reads and writes `RuntimeOptions.files`, in memory by
default. Date is JavaScript's Date, with avmplus' string formats.
flash.concurrent's Mutex and Condition are avmplus', in a heap of int32
words every worker of a primordial's shares (`natives/concurrent.ts`,
`natives/sync.ts`): `RuntimeOptions.sync` names it and the worker a
runtime runs, by default memory of its own, or for avmshell's workers
their `ShellWorkersMemory`'s. A thread blocks with `Atomics.wait`, or
spins where it cannot, up to Flash's script timeout (Error 1502). ByteArray's atomic operations and `casi32` are
`Atomics` on a shareable ByteArray's memory once another worker shares it
(a growable SharedArrayBuffer, see [workers.md](../workers.md)). Crossbridge's code
uses them all as it starts. avmshell's Worker and WorkerDomain
(`natives/shell.ts`, `natives/shell-workers.ts`) keep each worker's state,
parent and shared properties in memory every thread sees, a
SharedArrayBuffer, so that one worker sees at once what another set, and
start each background worker on a thread of `RuntimeOptions.workers`, the
host's, which runs a runtime made with that worker's `RuntimeOptions.worker`
(see [workers.md](../workers.md)).

## Application domains

Domain memory is avmshell's `avmplus.Domain`'s: 1024 bytes of scratch
memory until a ByteArray is set as it. Each Domain is one of the runtime's application
domains (`Domain` in `domain.ts`), as avmplus' DomainMgr keeps them: a
name a domain's chain defines already is not added again, and a lookup
takes what a domain of the chain has found before, from the name's own
domain up, else the first loaded, from the root down, and keeps it, so a
child that found its own class keeps it when its parent defines the name
later. A type, a coercion's or a base class's, is found the same way
through caches of its own, as avmplus finds traits, so a class a child
found by name is not the type it finds once its parent defines the name,
and a class extending it is rejected, as avmplus rejects it. What a
name finds being kept, `Runtime.classNamed`, the player's lookup of a
class by its qualified name, keeps the class in the domain
(`Domain.named`) once its script has made it: the player names a class
for each object and event it makes.

Every name a module makes is looked up in the domain the module was
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
code it evaluates (`Runtime.codeDomain`). A frame that names no script,
as JavaScriptCore's of a Function's code, is no module's: the module a
load's stack does not name is left out, not taken for the host's code
the next frame is.

JavaScriptCore also makes a strict `return f(...)` a
proper tail call, dropping the caller's frame, so the runtime calls a
function value, a bound method or a getter for a SWF's code, and calls
on to its own functions that do (`call` to `callValue`, `callProperty`
to `callBound`, Function's `call` and `apply`, a Proxy's methods), in no
tail position: its frames stay between the callee and the code that
called the runtime, as anything reading the stack expects. It is written
`let r; r = f(...); return r;`, not `const r = f(...); return r;`, which
minifiers (terser's and esbuild's) fold back into `return f(...)`; this
form they keep, as `return r = f(...), r`. Measured in JavaScriptCore's
shell, as3pb's run and the untyped benchmark took the same within their
spread either way.

## describeType

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

## Corners of avmplus

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

## The standard library

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
cannot judge; Flash's traces in Ruffle's corpus do. A host gives the
libraries' bytes, and the player compiles them as any ABC, or takes their
modules from a module cache, as the swf2es command writes them with
`--emit-libraries`. builtin.abc's AS3 sources are MPL-2.0, and so are its
compiled modules.

The playerglobal (`flash.*`) the player loads is its own,
`playerglobalLibrary`, compiled from `as3/playerglobal/src` by ASC 1 in
the oracle's image as avmplus compiles its libraries (`tools/playerglobal.ts`,
`pnpm as3:playerglobal`), into `playerglobal/playerglobal-library.ts`. Each
public definition of Flash Player's playerglobal has a file there: Ruffle's
AS3 where both are plain AS3 (MIT OR Apache-2.0, as each file says), else
Flash Player's API with bodies of swf2es's own over the player's natives.
A method native in Flash Player's playerglobal is native in ours, which the
player's TypeScript implements; private natives are declared with the
signatures it binds. `--check` holds the compiled API to Flash Player's
(names, version marks, types, defaults, flags), and a unit test holds the
committed file to its sources; `SWF2ES_PLAYERGLOBAL=adobe` runs the tests on
Flash Player's own instead. No version mark goes past the reference's 41:
a builtin's highest mark from 42 up is the VM's internal one
(`API_FirstInternalMark`), which a higher mark would make public.

## Running ABCs as avmshell does

`swf2es run file.abc [more.abc ...]` (`packages/cli`, `commands/run.ts`)
is avmshell in node: avmshell's libraries, builtin.abc and
shell_toplevel.abc (from `oracle/avmplus/generated/`, or `--lib`), each
compiled by `codegen.wasm` and loaded into one runtime, their scripts run
on first use; then each ABC in the order given, added to the root domain,
compiled and its entry point run, as avmshell runs each file once the one
before has. What they trace and print goes to stdout. An ABC rejected
with a VerifyError, or an exception nothing catches, is printed there as
avmshell prints it (`VerifyError: Error #1107`, `TypeError: Error
#1009`), and ends the run with avmshell's exit status, 1. avmshell's `File`
reads and writes the working directory. A SWF is refused: its code needs
the player's playerglobal, which the command does not depend on. avmshell's
background workers run on node's threads (`threads.ts`, each thread
`shell-thread.ts`): each compiles its libraries and its code, the ABCs
given or those of `createWorkerFromByteArray`, with codegen.wasm's module
posted to it, and writes what it prints to stdout itself. They stop when
the ABCs given end, as avmshell interrupts its workers then.

The command and the tests that run ABCs share one host, `runShell` in
`shell.ts`: one compiler domain for the runtime, each ABC compiled into the
application domain the runtime loads it into, so that an ABC
`Domain.loadBytes` loads compiles against what its domain sees, with the
findings the runtime reports (`RuntimeOptions.compileAbc`). The
conformance runner and the Tamarin runner give it the test build of
codegen (`tests/conformance/abc-compiler.ts`), which `pnpm test:checked`
checks every array access of, a loader that keeps source maps, and for
Tamarin the builtins' modules compiled once for every test. Their
background workers' threads compile with the release build, and post
what they print back to the runner's lines.
