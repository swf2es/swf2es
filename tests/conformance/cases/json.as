// JSON as avmplus parses and writes it: values, escapes, numbers in its
// format, toJSON, replacers, gaps, arrays and Vectors, and errors. Objects
// with several keys are compared by length: avmplus orders their keys by
// its hashtable.
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID); }
}
trace(JSON.stringify(1.5), JSON.stringify(0.1 + 0.2), JSON.stringify(1e21), JSON.stringify(-0), JSON.stringify(NaN));
trace(JSON.stringify("a\"b\\c\n\t\u0001é"), JSON.stringify(null), JSON.stringify(true), JSON.stringify(undefined));
trace(JSON.stringify([1, "x", null, undefined, function():void {}, [2]]), JSON.stringify(new <int>[1, 2]));
trace(JSON.stringify({a: 1}), JSON.stringify({a: [1, {b: 2}]}), JSON.stringify({a: 1, b: 2, c: 3}).length);
trace(JSON.stringify([1, [2]], null, 2), JSON.stringify({a: [1]}, null, "--"));
trace(JSON.stringify({a: 1, b: 2}, ["b"]), JSON.stringify([1, 2], function(k:String, v:*):* { return v is Number ? v * 10 : v; }));
var withJSON:Object = {toJSON: function(k:String):* { return "key:" + k; }};
trace(JSON.stringify(withJSON), JSON.stringify([withJSON]), JSON.stringify({x: withJSON}));
var p:Object = JSON.parse('{"a": [1, 2.5, -3e2, "s\\u0041\\n"], "b": {"c": null, "d": true}}');
trace(p.a, p.a[2], p.a[3], p.b.c, p.b.d, typeof p.a[1]);
trace(JSON.parse("123"), JSON.parse('"x"'), JSON.parse(" [ ] ").length, JSON.parse('{"1": "one"}')[1]);
trace(JSON.parse('[1, 2, 3]', function(k:String, v:*):* { return v is Number ? v * 2 : v; }));
probe("bad", function():* { return JSON.parse("{a: 1}"); });
probe("trailing", function():* { return JSON.parse("[1,]"); });
probe("empty", function():* { return JSON.parse(""); });
probe("cycle", function():* { var o:Object = {}; o.self = o; return JSON.stringify(o); });
probe("replacer", function():* { return JSON.stringify(1, 5); });
