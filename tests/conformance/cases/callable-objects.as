// A RegExp called as a function is its exec, of the argument's string;
// Function.prototype is a function that does nothing; a function is
// [object Function-id] to Object.prototype.toString, id its method's, a
// method closure's too.
package {
  public class Named {
    public function one():void {}
    public function two():void {}
    public static function three():void {}
  }
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

probe("regexp called", function():* { var r:* = /b(c)/; return r("abcd") + " " + r("x") + " " + /a/() + " " + /^$/(); });
probe("regexp of a number", function():* { var r:* = /\d+/; return r(1234); });
probe("function prototype", function():* {
  var f:* = Function.prototype;
  return (typeof f) + " " + f() + " " + (f is Function);
});
probe("function to string", function():* {
  var g:Function = function():void {};
  return Object.prototype.toString.call(g).indexOf("[object Function-") + " " + Object.prototype.toString.call(Function.prototype).indexOf("[object Function-");
});
probe("function ids", function():* {
  var n:Named = new Named();
  var f:Function = function():void {};
  return [Object.prototype.toString.call(f), Object.prototype.toString.call(n.one), Object.prototype.toString.call(n.two), Object.prototype.toString.call(Named.three)].join(" ");
});
