// Classes: construction, inheritance, overrides and super, accessors,
// statics, interfaces, and the type tests.
package {
  public interface IShape { function area():Number; }
  public class Shape implements IShape {
    public static var count:int = 0;
    protected var name:String;
    public function Shape(name:String) { this.name = name; count++; }
    public function area():Number { return 0; }
    public function describe():String { return name + " " + area(); }
    public function toString():String { return "[Shape " + name + "]"; }
  }
  public class Rect extends Shape {
    private var w:Number, h:Number;
    public function Rect(w:Number, h:Number) { super("rect"); this.w = w; this.h = h; }
    override public function area():Number { return w * h; }
    public function get width():Number { return w; }
    public function set width(v:Number):void { w = v; }
  }
  public class Square extends Rect {
    public function Square(s:Number) { super(s, s); name = "square"; }
    override public function describe():String { return "sq: " + super.describe(); }
    public static function make(s:Number):Square { return new Square(s); }
  }
  public dynamic class Bag {}
}
import avmplus.getQualifiedClassName;
var r:Rect = new Rect(2, 3);
var s:Square = Square.make(4);
trace(r.describe(), s.describe(), Shape.count, String(r), "" + s);
r.width = 5;
trace(r.width, r.area());
var shape:IShape = s;
trace(shape.area(), s is Shape, s is IShape, r is Square, s as Rect != null, r as Square);
trace(s instanceof Square, r instanceof Shape, typeof s, typeof Square);
trace(getQualifiedClassName(s), getQualifiedClassName(Square), getQualifiedClassName(1), getQualifiedClassName("s"));
var bag:Bag = new Bag();
bag.x = 1;
bag["y"] = 2;
trace(bag.x + bag.y, "x" in bag, bag.z);
try { Object(r).nothing = 1; } catch (e:Error) { trace("sealed", e.errorID); }
try { Object(r).nothing(); } catch (e:Error) { trace("missing method", e.errorID); }
try { var n:Rect = Object(s) as Rect; trace("cast", n.area()); } catch (e:Error) { trace(e.errorID); }
try { Square(r); } catch (e:Error) { trace("coerce", e.errorID); }
