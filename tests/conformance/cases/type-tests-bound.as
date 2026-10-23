// `is` and `as` against a class the compiler knows by its slot, as `c is
// Shape` names a script's class: values of each static type against the
// class itself, its base, its subclass, a sibling, builtins with natives
// and with value tests, and a class whose slot is still null while
// another class's static initializer runs.
package {
  interface IThing {}

  class Shape {}

  class Circle extends Shape implements IThing {}

  class Ring extends Circle {}

  class Square extends Shape {}

  class Early {
    // Late's slot is null here: its class is made after this one.
    public static var seen:String = probe(function():* {
      return new Shape() is Late;
    }) + " " + probe(function():* {
      return new Shape() as Late;
    }) + " " + probe(function():* {
      return null is Late;
    });
  }

  class Late {}

  function probe(f:Function):String {
    try {
      return String(f());
    } catch (e:Error) {
      return "threw " + e.errorID;
    }

    return "";
  }

  function untyped(v:*):String {
    return [v is Shape, v is Circle, v is Ring, v is Square, v is IThing, v is Object, v is Array,
      v is Date, v is Error, v is RangeError, v is Class, v is String, v is int].join(",") +
      " " + [v as Shape, v as Circle, v as Square, v as Array, v as Error].join(",");
  }

  function typed(s:Shape):String {
    var c:Circle = s as Circle;
    return [s is Shape, s is Circle, s is Ring, s is Square, s is IThing, c === s, s as Square].join(",");
  }

  function objects(o:Object):String {
    return [o is Shape, o is Circle, o is Array, o is Error, o is Object].join(",");
  }

  function loop(list:Array):int {
    var n:int = 0;
    for (var i:int = 0; i < list.length; i++) {
      var s:Shape = list[i] as Shape;
      if (s is Circle) {
        n += (s as Circle) is Ring ? 10 : 1;
      }
    }

    return n;
  }

  var shape:Shape = new Shape();
  var circle:Circle = new Circle();
  var ring:Ring = new Ring();
  var square:Square = new Square();
  var values:Array = [shape, circle, ring, square, null, undefined, 1, "s", true, {}, [], new Date(0),
    new Error(), new RangeError(), Shape, Date.prototype, Array.prototype];
  for (var i:int = 0; i < values.length; i++) {
    trace(i, untyped(values[i]));
  }

  trace(typed(shape), typed(circle), typed(ring), typed(square), typed(null));
  trace(objects(shape), objects(ring), objects([]), objects(new RangeError()), objects(null));
  trace(loop([shape, circle, ring, square, null, ring, circle]));
  trace("early", Early.seen);
  trace("late", new Late() is Late, shape is Late);
}
