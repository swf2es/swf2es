// As op_add: beside a String or a Date, an object is converted with the
// hint String (toString before valueOf); otherwise without a hint, which is
// valueOf first. Array's join and its string are written with +=.
var o:Object = {
  toString: function():String { return "z"; },
  valueOf: function():Number { return 7; }
};
var any:* = o;
var s:String = "s";
s += o;
trace(s, "" + o, o + "", "a" + any, any + "b", o + 1, 1 + o, o + o, o + null);
trace(o + true, o + undefined, String(o), o, [o] + "");

var d:Date = new Date(0);
var dateOnly:Object = {toString: function():String { return "D"; }, valueOf: function():Number { return 1; }};
trace((d + 1).indexOf("1970") >= 0, typeof (d + dateOnly), (d + dateOnly).substr(-1));

var onlyValue:Object = {valueOf: function():Number { return 3; }};
trace("v" + onlyValue, onlyValue + 1, onlyValue + "v");

trace([1, 2, o].join(), [1, o].toString(), String([o, null, undefined, 2]));
var sorted:Array = [o, "b", "y"];
sorted.sort();
trace(sorted, sorted.length);

// A toString that shrinks the array while join walks it.
var a:Array = [1, 2];
a.push({toString: function():String { a.length = 1; return "z"; }, valueOf: function():Number { return 0; }});
trace(a.join(), a.length);

var log:Array = [];
var both:Object = {
  toString: function():String { log.push("toString"); return "t"; },
  valueOf: function():Number { log.push("valueOf"); return 2; }
};
var r1:* = "x" + both;
var r2:* = both + 1;
var r3:* = both + "x";
trace(r1, r2, r3, log);
