// The methods of String, Number, int, uint and Boolean called on values
// typed as them. In the AS3 namespace they are the classes' own, which a
// call binds to and keeps from its first call on, and a String's charAt
// and charCodeAt by a number are the string's: by indices in and out of
// range, negative, fractional, NaN and infinite, by none, by values of
// other types, which convert, on null, and in loops and from several
// methods. By their public names they are the prototypes' functions, which
// a script may replace; a call in the AS3 namespace does not see that.
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, e); }
}

var word:String = "swf2es";
var none:String = null;
var n:Number = 255.5;
var i:int = -42;
var k:uint = 4000000000;
var b:Boolean = true;

function builtin():void {
  use namespace AS3;
  var at:int = 2;
  var far:uint = 4000000000;
  var x:Number = 1.9;
  trace(word.charAt(0), word.charAt(at), word.charAt(5), word.charAt(6) == "", word.charAt(far) == "");
  trace(word.charAt(-1) == "", word.charAt(x), word.charAt(-0.5), word.charAt(NaN), word.charAt());
  trace(word.charAt(Infinity) == "", word.charAt(-Infinity) == "", word.charAt(5.999), word.charAt(1e20) == "");
  trace(word.charCodeAt(0), word.charCodeAt(at), word.charCodeAt(5), word.charCodeAt(6), word.charCodeAt(far));
  trace(word.charCodeAt(-1), word.charCodeAt(x), word.charCodeAt(-0.5), word.charCodeAt(NaN), word.charCodeAt());
  trace(word.charCodeAt(Infinity), word.charCodeAt(-Infinity), word.charCodeAt(5.999), word.charCodeAt(1e20));
  trace(typeof word.charCodeAt(0), word.charCodeAt(0) is int, word.charCodeAt(9) is int, typeof word.charAt(0));
  trace("".charAt(0) == "", "".charCodeAt(0), "aä€".charCodeAt(2), "aä€".charAt(1) == "ä");

  // Arguments of other types convert to Number first.
  var s:String = "3";
  var o:Object = { valueOf: function ():Number { return 4; } };
  var u:* = 1;
  var flag:Boolean = true;
  trace(word.charAt(s), word.charAt(o), word.charAt(u), word.charAt(flag), word.charAt(null), word.charAt(undefined));
  trace(word.charCodeAt(s), word.charCodeAt(o), word.charCodeAt(u), word.charCodeAt(flag), word.charCodeAt(null));
  trace(word.charCodeAt(undefined), word.charCodeAt("x"), word.charAt("x"), word.charAt(""), word.charCodeAt(" 2 "));
  probe("charAt of null", function ():* { return none.charAt(0); });
  probe("charCodeAt of null", function ():* { return none.charCodeAt(0); });
  probe("charAt of null by none", function ():* { return none.charAt(); });
  probe("indexOf of null", function ():* { return none.indexOf("a"); });
  probe("charAt by a thrower", function ():* {
    return word.charAt({ valueOf: function ():Number { throw new Error("thrown"); } });
  });
  probe("too many", function ():* { var f:Function = word.charAt; return f.call(word, 1, 2); });

  // The other methods, and each from its second call on.
  var sum:int = 0;
  var text:String = "";
  for (var j:int = 0; j < word.length; j++) {
    sum += word.charCodeAt(j) + word.indexOf(word.charAt(j)) + word.lastIndexOf("s", j);
    text += word.charAt(j).toUpperCase() + word.substr(j, 1) + word.substring(j, j + 1) + word.slice(-1);
    text += j.toString(2) + (j + 0.5).toFixed(1) + (j > 2).toString() + uint(j).toString(16);
  }

  trace(sum, text);
  trace(n.toString(), n.toString(16), n.toFixed(2), n.toPrecision(2), n.toExponential(1), n.valueOf());
  trace(i.toString(), i.toString(2), i.toFixed(1), i.valueOf(), k.toString(), k.toString(36), k.valueOf());
  trace(b.toString(), b.valueOf(), (!b).toString(), word.toUpperCase(), word.concat("!", 1), word.split("2"));
  trace(word.localeCompare("swf"), word.search("2"), word.replace("2", "-"), word.match("f"), word.valueOf());
  probe("radix", function ():* { return n.toString(99); });
  probe("digits", function ():* { return i.toFixed(-1); });
  probe("precision", function ():* { return k.toPrecision(0); });
}

function builtinAgain():String {
  use namespace AS3;
  return word.charAt(1) + word.charCodeAt(1) + word.substr(1, 2) + n.toString(2) + i.toString(8) + b.toString();
}

function byPrototype():String {
  return word.charAt(1) + "," + word.charCodeAt(1) + "," + word.substr(1, 2) + "," + n.toString(2) + "," +
    i.toString(8) + "," + b.toString() + "," + k.toFixed(0);
}

builtin();
trace(builtinAgain());
trace(byPrototype());

// The prototypes' functions replaced: the public names find the new ones,
// the AS3 names the classes' own, before and after a first call.
String.prototype.charAt = function (at:Number = 0):String { return "<" + at + ">"; };
String.prototype.charCodeAt = function (at:Number = 0):Number { return -at; };
String.prototype.substr = function (...rest):String { return "substr:" + rest; };
Number.prototype.toString = function (radix:* = 10):String { return "number:" + radix; };
int.prototype.toString = function (radix:* = 10):String { return "int:" + radix; };
Boolean.prototype.toString = function ():String { return "boolean"; };
Number.prototype.toFixed = function (digits:* = 0):String { return "fixed:" + digits; };
trace(byPrototype());
trace(builtinAgain());
builtin();
var untyped:* = word;
var object:Object = n;
trace(untyped.charAt(2), untyped.charCodeAt(2), object.toString(2), untyped.AS3::charAt(2), object.AS3::toString(2));
probe("charAt of null by prototype", function ():* { return none.charAt(0); });
delete String.prototype.charAt;
probe("deleted", function ():* { return word.charAt(1); });
probe("deleted untyped", function ():* { return untyped.charAt(1); });
trace(builtinAgain());
