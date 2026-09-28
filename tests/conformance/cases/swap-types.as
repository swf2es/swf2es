// A setter that sets another property of its class: the compiler pushes
// the value, finds the class or instance, and swaps them, so the property
// is set on what the swap put below the value, bound by its type.
package {
  public class Setters {
    private static var _a:Number = 0;
    private static var _b:int = 0;
    public static function get a():Number { return _a; }
    public static function set a(n:Number):void { _a = n; }
    public static function get b():int { return _b; }
    public static function set b(i:int):void { a = i * 2; _b = i; }
    private var _c:String = "";
    private var _d:uint = 0;
    public function get c():String { return _c; }
    public function set c(s:String):void { _c = s; }
    public function set d(u:uint):void { c = "d" + u; _d = u; }
    public function get d():uint { c = "read"; return _d; }
  }
}
Setters.b = 21;
trace(Setters.a, Setters.b);
var s:Setters = new Setters();
s.d = 7;
trace(s.c, s.d, s.c);
