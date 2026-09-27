# References

Where to look when implementing swf2es. **avmplus decides**: when a spec or
another implementation disagrees with what avmshell does, follow avmshell and
add a conformance case for the difference.

## Behaviour

- **avmplus** (Tamarin): Adobe's AVM2, as the submodule `oracle/avmplus`
  ([swf2es/avmplus](https://github.com/swf2es/avmplus)). The ABC parser is
  `core/AbcParser.cpp`, the verifier `core/Verifier.cpp`, and
  `utils/abcdump.as` is the disassembler our ABC tests diff against.
  `core/opcodes.tbl` lists the opcodes, and `AvmCore::readOperands` and
  `Verifier::verifyBlock` show how their operands are read.
  MPL-2.0: read it, run it, but do not copy its code into swf2es.

## Specifications

- **ABC format 46.16**, the version ASC 2.0 emits:
  `oracle/avmplus/doc/abcFormat-46-16.txt`, with more in
  `oracle/avmplus/doc/avmspec` and `oracle/avmplus/doc/bytecode`.
- **AVM2 Overview** (Adobe, 2007): the ABC file format, instruction set and
  verification rules.
  [Archived PDF](http://web.archive.org/web/20170829225622/http://www.adobe.com/content/dam/Adobe/en/devnet/actionscript/articles/avm2overview.pdf).
- **SWF File Format Specification, version 19**: the container, tags and
  `DoABC`, for the `format` package.
  [PDF](https://open-flash.github.io/mirrors/swf-spec-19.pdf).
- **ECMAScript 3**, which AS3 builds on:
  [PDF](https://open-flash.github.io/mirrors/ecma-262-3.pdf).

## Other implementations

Useful to compare structure and real-world edge cases, not as the source of
truth.

- **Ruffle**: [`swf/src/avm2/read.rs`](https://github.com/ruffle-rs/ruffle/blob/master/swf/src/avm2/read.rs)
  reads every ABC table as plain data, with years of fixes for malformed
  SWFs, and [`swf/src/avm2/opcode.rs`](https://github.com/ruffle-rs/ruffle/blob/master/swf/src/avm2/opcode.rs)
  lists the opcodes; it agrees with avmplus on all 167 legal in ABC 46.16.
  MIT or Apache-2.0.
- **AwayFL**: [`awayfl/avm2`](https://github.com/awayfl/avm2), `lib/abc`, a
  lazy ABC parser in TypeScript descended from Shumway. Apache-2.0.
- **Shumway** (archived): [`mozilla/shumway`](https://github.com/mozilla/shumway),
  the origin of AwayFL's AVM2, with its SWF tag parsers. Apache-2.0.
