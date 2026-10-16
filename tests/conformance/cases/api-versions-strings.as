// API versioning of names made from strings: `in`, hasOwnProperty, a
// late-bound name and JSON see public members at the code's version, as
// avmplus' findPublicNamespace does from the call stack, so avmshell
// (Flash Player's series) does not find an AIR-only member through them.
import avmshell.*;
const o:public_class = new public_class();
for each (var name:String in ["public_var", "public_var_AIR_1_0", "public_var_FP_10_0",
    "public_function_AIR_1_0", "public_function_FP_10_0", "public_getset_AIR_1_0",
    "public_getset_FP_10_0"]) {
  trace(name, name in o, o.hasOwnProperty(name), o.propertyIsEnumerable(name));
  try { trace("  get", o[name]); } catch (e:Error) { trace("  get", e.errorID); }
  try { o[name] = false; trace("  set ok"); } catch (e:Error) { trace("  set", e.errorID); }
}

trace(JSON.stringify(o).length > 2);
const keys:Array = [];
for (var k:String in JSON.parse(JSON.stringify(o))) {
  keys.push(k);
}
keys.sort();
trace(keys);
