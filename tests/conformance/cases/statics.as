// Static initialization: order, static methods and constants, and a class
// referring to another's statics.
package {
  public class A {
    public static var log:Array = [];
    public static const K:int = 10;
    public static var derived:int = K * 2;
    public static function add(s:String):void { log.push(s); }
    { add("A static block"); }
  }
  public class B {
    public static var fromA:int = A.K + 1;
    public static var instances:int;
    public function B() { instances++; A.add("B " + instances); }
  }
}
trace(A.K, A.derived, B.fromA, B.instances);
new B();
new B();
trace(A.log, B.instances);
A.derived = 5;
trace(A.derived, A["K"]);
