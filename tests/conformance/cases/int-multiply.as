// Two ints or uints multiplied and the product made an int or uint at
// once: avmplus' JIT multiplies them as ints, which wraps, where its
// interpreter, which runs initializers, multiplies doubles. Compiled C, as
// Crossbridge's xxHash, depends on the wrap. Products that reach the
// conversion otherwise (through a Number variable, or after a branch)
// avmshell may wrap too, and swf2es does not: they are left out.
package {
  public class Products {
    public static var A:int = 0x7fffffff;
    public static var B:int = -1640531535;
    // A static initializer: the interpreter's doubles.
    public static var initialized:int = A * B;
    public static function local(a:int, b:int):int { var c:int = a * b; return c; }
    public static function returned(a:int, b:int):int { return a * b; }
    public static function argument(a:int, b:int):String { return String(take(a * b)); }
    public static function take(x:int):int { return x; }
    public static function unsigned(a:uint, b:uint):uint { return a * b; }
    public static function mixed(a:int, b:uint):int { return a * b; }
    public static function toUint(a:int, b:int):uint { return a * b; }
    public static function intConstant(a:int):int { return a * 1640531535; }
    // 2654435761 is no int: a double, as the JIT keeps it.
    public static function numberConstant(a:int):int { return a * 2654435761; }
    public static function number(a:int, b:Number):int { return a * b; }
    public static function unconverted(a:int, b:int):Number { return a * b; }
    public static function inLoop(a:int, b:int, n:int):int {
      var h:int = a;
      for (var i:int = 0; i < n; i++) {
        h = h * b;
      }
      return h;
    }
  }
}
var a:int = Products.A;
var b:int = Products.B;
trace("initializer", Products.initialized, a * b);
trace("local", Products.local(a, b), Products.local(123456789, 987654321), Products.local(-7, 3));
trace("returned", Products.returned(a, b), Products.returned(0x10000, 0x10000), Products.returned(-1, int.MIN_VALUE));
trace("argument", Products.argument(a, b));
trace("unsigned", Products.unsigned(0xfedcba98, 0x9e3779b1), Products.unsigned(0xffffffff, 0xffffffff));
trace("mixed", Products.mixed(a, 0x9e3779b1), Products.toUint(a, b));
trace("constants", Products.intConstant(a), Products.numberConstant(a));
trace("number", Products.number(a, -1640531535), Products.unconverted(a, b));
trace("loop", Products.inLoop(0x12345678, b, 1), Products.inLoop(0x12345678, b, 1000));
