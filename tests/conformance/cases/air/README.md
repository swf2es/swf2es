These cases use scalar `float` bytecode from AIR 51 and above. The pinned
avmshell lacks this type, so they run against AIR's `adl` instead of the
normal conformance runner.

`node tests/conformance/air.ts` compiles `AirFloat.as` with the installed
`amxmlc`, compares its output with AIR, and runs the same SWF in swf2es with
eager and lazy compilation. Add `--update` to regenerate the redistributable
ABC fixture and reference trace. The ordinary player suite runs that fixture
as `air-float`, so CI needs no proprietary AIR SDK.

Strict compilation is disabled so the case can exercise AIR's numeric
conversion of typed objects whose `valueOf()` returns a float.
