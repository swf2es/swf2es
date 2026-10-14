// A new object's slots at their initial values: each type's default, the
// declared constants, a namespace, a string that needs escaping, and a
// base's slots, in a class of more slots than V8 keeps fast by key and in
// one of a few; then written and read back, on many objects.
package {
  public namespace extra = "urn:extra";

  public class Wide {
    public var a0:int;
    public var a1:uint;
    public var a2:Number;
    public var a3:Boolean;
    public var a4:String;
    public var a5:*;
    public var a6:Object;
    public var a7:Array;
    public var a8:int = -7;
    public var a9:uint = 4000000000;
    public var a10:Number = 0.5;
    public var a11:Boolean = true;
    public var a12:String = "quote \" backslash \\ line\n tab\t \u00e9 </script> end";
    public var a13:* = null;
    public var a14:Namespace = extra;
    public const a15:Number = Infinity;
    public var a16:Number = -0;
    public var a17:String = "";
    public var a18:int = 2147483647;
    public var a19:Object = undefined;
    public var a20:Wide;
  }

  public class Wider extends Wide {
    public var b0:Number;
    public var b1:String = "sub";
    public var b2:Namespace = extra;
  }

  public class Narrow {
    public var c0:int = 1;
    public var c1:String;
  }
}

function show(o:Wide):String {
  return [o.a0, o.a1, o.a2, o.a3, o.a4, o.a5, o.a6, o.a7, o.a8, o.a9, o.a10, o.a11,
    escape(o.a12), o.a13, o.a14, o.a15, 1 / o.a16, o.a17, o.a18, o.a19, o.a20].join("|");
}

trace(show(new Wide()));
var sub:Wider = new Wider();
trace(show(sub), sub.b0, sub.b1, sub.b2, sub.a14 == sub.b2);
var n:Narrow = new Narrow();
trace(n.c0, n.c1);

var made:Array = [];
for (var i:int = 0; i < 100; i++) {
  var w:Wider = new Wider();
  w.a0 = i;
  w.b0 = i / 2;
  made.push(w);
}

var sum:Number = 0;
for each (var m:Wider in made) {
  sum += m.a0 + m.b0 + m.a8;
}

trace(sum, made[99].a12 == sub.a12, made[42].b1);
