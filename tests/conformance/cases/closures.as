// Closures, activations and scopes.
function counter():Function {
  var n:int = 0;
  return function():int { return ++n; };
}
var c1:Function = counter(), c2:Function = counter();
trace("counter", c1(), c1(), c2(), c1());
var fs:Array = [];
for (var i:int = 0; i < 3; i++) fs.push(function():int { return i; });
trace("shared", fs[0](), fs[2]());
function outer(x:int):Function {
  function inner(y:int):int { return x + y; }
  return inner;
}
trace("nested", outer(10)(5));
var obj:Object = {v: 1};
with (obj) { v = 2; trace("with", v); }
trace("after with", obj.v);
function self(n:int):int { return n <= 1 ? 1 : n * self(n - 1); }
trace("recursion", self(10));
var f:Function = function(a:int, b:int = 5, ...rest):String { return a + " " + b + " " + rest.length; };
trace("defaults", f(1), f(1, 2), f(1, 2, 3, 4), f.length);
trace("call", f.call(null, 7), f.apply(null, [8, 9, 10]));
var thisObj:Object = {name: "o", getName: function():String { return this.name; }};
trace("this", thisObj.getName());
