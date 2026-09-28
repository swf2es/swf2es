// Date's, RegExp's and Array's prototypes are instances of their class,
// as avmplus makes them: a Date of no time, the empty RegExp, an empty
// Array, whose elements the prototype chain finds.
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

probe("is", function():* { return [Date.prototype is Date, RegExp.prototype is RegExp, Array.prototype is Array, Object.prototype is Object].join(","); });
probe("date", function():* { return Date.prototype.AS3::getTime() + " " + Date.prototype.AS3::toString(); });
probe("regexp", function():* { return RegExp.prototype.AS3::test("abc") + " " + RegExp.prototype.source; });
probe("array", function():* { return Array.prototype.length; });
probe("element on the prototype", function():* {
  Array.prototype[1] = "one";
  var a:Array = [0];
  var s:String = a[1] + " " + (1 in a) + " " + a.hasOwnProperty(1);
  delete Array.prototype[1];
  return s + " " + a[1];
});
probe("method moved to an object", function():* {
  var o:Object = { getTime: Date.prototype.getTime };
  return o.getTime();
});
