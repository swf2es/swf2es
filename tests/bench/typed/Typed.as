package
{
	// Typed code as the compiler binds it: `new` of classes it resolves,
	// shallow and deep in a hierarchy, and calls of methods it knows,
	// with parameters typed as classes, interfaces and numbers, given
	// instances of the class itself, of a subclass, and null; calls through
	// an interface, of one class and of several; calls of a base's method
	// through super; and constructors with class-typed parameters.
	public class Vec
	{
		public var x:Number;
		public var y:Number;
		public function Vec(x:Number, y:Number)
		{
			this.x = x;
			this.y = y;
		}
		public function add(v:Vec):Vec
		{
			return new Vec(x + v.x, y + v.y);
		}
		public function dot(v:Vec):Number
		{
			return x * v.x + y * v.y;
		}
		public function scaled(k:Number):Number
		{
			return x * k + y * k;
		}
		public function mix(a:int, b:uint, c:Number, d:Boolean, s:String):Number
		{
			return d ? a + b + c + s.length : c;
		}
	}
}
interface Shape
{
	function area():Number;
}
class Base implements Shape
{
	public var id:int;
	public function Base(id:int)
	{
		this.id = id;
	}
	public function area():Number
	{
		return id;
	}
}
class Middle extends Base
{
	public var name:String;
	public function Middle(id:int, name:String)
	{
		super(id);
		this.name = name;
	}
}
class Leaf extends Middle
{
	public var size:Number;
	public function Leaf(id:int, name:String, size:Number)
	{
		super(id, name);
		this.size = size;
	}
	override public function area():Number
	{
		return size * size;
	}
}
class Vec3 extends Vec
{
	public var z:Number = 0;
	public function Vec3(x:Number, y:Number)
	{
		super(x, y);
	}
}
// Shape's area at another dispatch id than Base's, and a class that has
// it from its base.
class Square implements Shape
{
	public var side:Number;
	public function Square(side:Number)
	{
		this.side = side;
	}
	public function perimeter():Number
	{
		return 4 * side;
	}
	public function area():Number
	{
		return side * side;
	}
}
class Tile extends Square
{
	public function Tile()
	{
		super(2);
	}
}
class Pair
{
	public var a:Vec;
	public var b:Vec;
	public function Pair(a:Vec, b:Vec)
	{
		this.a = a;
		this.b = b;
	}
}
class Weighted extends Vec
{
	public function Weighted(x:Number, y:Number)
	{
		super(x, y);
	}
	override public function dot(v:Vec):Number
	{
		return super.dot(v) * 2;
	}
}
final class Counter
{
	private var _n:int = 0;
	public function bump(by:int):int
	{
		return _n += by;
	}
	public function take(v:Vec):int
	{
		return v == null ? _n : _n += int(v.x);
	}
	public function shape(s:Shape):int
	{
		return s == null ? _n : ++_n;
	}
	public function area(s:Shape):Number
	{
		return s.area();
	}
}

function time(name:String, f:Function):void
{
	var start:int = getTimer();
	var r:* = f();
	trace("time: " + name + " " + (getTimer() - start));
	trace(name + " " + r);
}

const N:int = 3000000;

time("newSmall", function():*
	{
		var s:Number = 0;
		for (var i:int = 0; i < N; i++)
		{
			var v:Vec = new Vec(i, 1);
			s += v.y;
		}
		return s;
	});

time("newDeep", function():*
	{
		var s:Number = 0;
		for (var i:int = 0; i < N; i++)
		{
			var l:Leaf = new Leaf(i, "leaf", 2);
			s += l.size + l.id;
		}
		return s;
	});

time("newChained", function():*
	{
		var v:Vec = new Vec(0, 0);
		var d:Vec = new Vec(1, 2);
		for (var i:int = 0; i < N; i++)
		{
			v = v.add(d);
		}
		return v.x + v.y;
	});

time("callClass", function():*
	{
		var a:Vec = new Vec(1, 2);
		var b:Vec = new Vec(3, 4);
		var s:Number = 0;
		for (var i:int = 0; i < N * 3; i++)
		{
			s += a.dot(b);
		}
		return s;
	});

time("callSubclass", function():*
	{
		var a:Vec = new Vec(1, 2);
		var b:Vec3 = new Vec3(3, 4);
		var s:Number = 0;
		for (var i:int = 0; i < N * 3; i++)
		{
			s += a.dot(b);
		}
		return s;
	});

time("callInterface", function():*
	{
		var c:Counter = new Counter();
		var l:Leaf = new Leaf(1, "x", 3);
		var s:Number = 0;
		for (var i:int = 0; i < N * 3; i++)
		{
			s += c.shape(l);
		}
		return s;
	});

time("interfaceCall", function():*
	{
		var c:Counter = new Counter();
		var l:Leaf = new Leaf(1, "x", 3);
		var s:Number = 0;
		for (var i:int = 0; i < N; i++)
		{
			s += c.area(l);
		}
		return s;
	});

time("interfacePoly", function():*
	{
		var shapes:Vector.<Shape> = new <Shape>[new Base(2), new Leaf(1, "x", 3), new Square(4), new Tile()];
		var s:Number = 0;
		for (var i:int = 0; i < N; i++)
		{
			var shape:Shape = shapes[i & 3];
			s += shape.area();
		}
		return s;
	});

time("superCall", function():*
	{
		var a:Weighted = new Weighted(1, 2);
		var b:Vec = new Vec(3, 4);
		var s:Number = 0;
		for (var i:int = 0; i < N; i++)
		{
			s += a.dot(b);
		}
		return s;
	});

time("newArgs", function():*
	{
		var a:Vec3 = new Vec3(1, 2);
		var b:Vec3 = new Vec3(3, 4);
		var s:Number = 0;
		for (var i:int = 0; i < N; i++)
		{
			var p:Pair = new Pair(a, b);
			s += p.b.y;
		}
		return s;
	});

time("callNull", function():*
	{
		var c:Counter = new Counter();
		var s:int = 0;
		for (var i:int = 0; i < N * 3; i++)
		{
			s += c.take(null);
		}
		return s;
	});

time("callNumbers", function():*
	{
		var a:Vec = new Vec(1, 2);
		var s:Number = 0;
		for (var i:int = 0; i < N * 3; i++)
		{
			s += a.mix(i, 3, 0.5, true, "abc") + a.scaled(i);
		}
		return s;
	});

time("callFinal", function():*
	{
		var c:Counter = new Counter();
		var s:int = 0;
		for (var i:int = 0; i < N * 3; i++)
		{
			s = c.bump(i & 7);
		}
		return s;
	});
