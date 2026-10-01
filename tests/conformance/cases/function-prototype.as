// A function's prototype as avmplus has it (FunctionObject's prototype
// setter): undefined and null clear it, and it reads back undefined, with
// no new object made; a primitive is refused with TypeError 1049 and
// changes nothing; any object, an array or a function is taken. An object
// made by new from a function whose prototype is cleared is a plain
// Object. A class's prototype cannot be set (1074).
function show(label:String, f:Function):void {
  try { trace(label, typeof f.prototype, f.prototype); } catch (e:Error) { trace(label, "error", e.errorID); }
}
function set(label:String, f:Function, v:*):void {
  try { f.prototype = v; trace(label, "set ok"); } catch (e:Error) { trace(label, "set error", e.errorID); }
  show(label, f);
}
var fn:Function = function():void {};
show("fresh", fn);
set("undefined", fn, undefined);
set("null", fn, null);
set("5", fn, 5);
set("s", fn, "s");
set("true", fn, true);
var o:Object = { marker: 1 };
set("object", fn, o);
trace("same", fn.prototype === o);
set("array", fn, []);
set("function", fn, function():void {});
fn.prototype = undefined;
var made:Object = new fn();
trace("made", made is Object, made.constructor === fn, typeof made.constructor, made.hasOwnProperty("constructor"));
fn.prototype = o;
made = new fn();
trace("made2", made.marker, made.constructor === fn);
var g:Function = function():void {};
g.prototype = null;
var made3:Object = new g();
trace("made3", made3 is Object, made3.constructor);
class C {}
try { C.prototype = null; } catch (e:Error) { trace("class set", e.errorID); }
trace("class", typeof C.prototype);
