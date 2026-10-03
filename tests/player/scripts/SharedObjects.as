// Local SharedObjects: one object for a name, its data as it starts, its
// size as values go in, flush and clear, the names getLocal refuses, a
// property set through setProperty, its client, and another local path.
package {
  import flash.display.Sprite;
  import flash.net.SharedObject;

  public class Main extends Sprite {
    public function Main() {
      var so:SharedObject = SharedObject.getLocal("swf2esTest");
      trace("same", so === SharedObject.getLocal("swf2esTest"));
      trace("other", so === SharedObject.getLocal("swf2esOther"));
      trace("data", so.data, count(so.data));
      trace("size empty", so.size);
      trace("encoding", so.objectEncoding, SharedObject.defaultObjectEncoding);
      so.data.n = 1;
      trace("size n", so.size);
      so.data.s = "text";
      trace("size s", so.size);
      so.data.a = [1, 2, 3];
      so.data.o = {x: 1};
      trace("size all", so.size);
      trace("flush", so.flush());
      trace("size after flush", so.size, count(so.data));
      so.clear();
      trace("cleared", count(so.data), so.size);
      so.setProperty("p", 5);
      trace("setProperty", so.data.p);
      trace("client", so.client === so);
      trace("root path", so === SharedObject.getLocal("swf2esTest", "/"));
      var names:Array = ["a b", "a~b", "a%b", "a&b", "a\\b", "a;b", "a:b", "a\"b", "a'b", "a,b",
        "a<b", "a>b", "a?b", "a#b", "", "a/b", "a.b", "a-b", "a_b", "a+b", "a@b", "a=b", "a$b"];
      for each (var name:String in names) {
        try {
          SharedObject.getLocal(name);
          trace("name", name, "ok");
        } catch (e:Error) {
          trace("name", name, e.errorID);
        }
      }

      try {
        SharedObject.getLocal(null);
        trace("name null ok");
      } catch (e:Error) {
        trace("name null", e.errorID);
      }
    }

    private static function count(o:Object):int {
      var n:int = 0;
      for (var k:String in o) {
        n++;
      }
      return n;
    }
  }
}
