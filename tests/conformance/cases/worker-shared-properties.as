// A worker's shared properties, as avmplus' ChannelItem keeps them: an
// object by its AMF3 bytes, read back as a new copy each time and its inner
// objects as AMF makes them; a ByteArray, a Mutex and a Condition as
// themselves on the worker that set them; undefined deletes.
import flash.system.Worker;
import flash.utils.ByteArray;
import flash.concurrent.Mutex;
import flash.concurrent.Condition;
var w:Worker = Worker.current;
var o:Object = {a: 1, b: [2, "three"]};
w.setSharedProperty("o", o);
o.a = 5;
var c:Object = w.getSharedProperty("o");
print("copy " + (c == o) + " " + c.a + " " + (c == w.getSharedProperty("o")));
var b:ByteArray = new ByteArray();
b.writeUTFBytes("bytes");
w.setSharedProperty("b", b);
var bc:ByteArray = w.getSharedProperty("b");
print("bytes " + (bc == b) + " " + bc.position);
w.setSharedProperty("u", 1);
w.setSharedProperty("u", undefined);
print("undefined " + w.getSharedProperty("u"));
print("missing " + w.getSharedProperty("missing"));
w.setSharedProperty("n", null);
print("null " + w.getSharedProperty("n"));
print("state " + w.state + " " + w.isPrimordial);
var m:Mutex = new Mutex();
w.setSharedProperty("m", m);
print("mutex " + (w.getSharedProperty("m") == m));
var cond:Condition = new Condition(m);
w.setSharedProperty("c", cond);
print("condition " + (w.getSharedProperty("c") == cond));
var v:Vector.<int> = new <int>[1, 2];
w.setSharedProperty("v", v);
print("vector " + (w.getSharedProperty("v") == v) + " " + w.getSharedProperty("v"));
w.setSharedProperty("x", <a b="1"/>);
print("xml " + w.getSharedProperty("x").@b);
w.setSharedProperty("s", "text");
w.setSharedProperty("i", -3);
w.setSharedProperty("t", true);
print("primitives " + w.getSharedProperty("s") + " " + w.getSharedProperty("i") + " " + w.getSharedProperty("t"));
w.setSharedProperty("o2", {inner: m});
print("inner " + (w.getSharedProperty("o2").inner == m) + " " + w.getSharedProperty("o2").inner);
