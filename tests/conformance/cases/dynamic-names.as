// Dynamic properties and the names that reach them: `in` with its name
// first, only the public namespace with an empty URI naming a dynamic
// property, `arguments` holding every argument, declared or not, and
// missing arguments to an untyped function.
namespace custom = "swf2es.custom";
var o:Object = {x: 42};
trace("in", "x" in o, "y" in o, "length" in [1, 2]);
try { trace("custom", o.custom::x); } catch (e:Error) { trace("custom", e.errorID); }
trace("public", o.x, o["x"]);
function f(a, b) {
  return arguments.length + " " + arguments.join(",");
}
trace("arguments", f(10, 20, 30), f(1, 2));
// An untyped function takes fewer arguments than it declares; the missing
// ones are undefined.
function g(a, b) {
  return a + " " + b;
}
trace("missing", g(1), g());
