// User namespaces: definitions, qualified access, use namespace, and the
// Namespace and QName values.
package {
  public namespace fruit = "http://example.com/fruit";
  public namespace veg = "http://example.com/veg";
  public class Basket {
    fruit var item:String = "apple";
    veg var item:String = "carrot";
    fruit function name():String { return "fruit " + fruit::item; }
    veg function name():String { return "veg " + veg::item; }
    public function both():String { return fruit::name() + ", " + veg::name(); }
  }
}
var b:Basket = new Basket();
trace(b.fruit::item, b.veg::item, b.fruit::name(), b.both());
var ns:Namespace = fruit;
trace(ns.uri, String(ns), b.ns::item);
use namespace veg;
trace(b.item, b.name());
var q:QName = new QName(fruit, "item");
trace(q.localName, q.uri, b[q]);
var any:QName = new QName("*");
trace(any.localName, any.uri, new QName(null, "x").uri, new QName("x").uri, String(new QName(fruit, "y")));
