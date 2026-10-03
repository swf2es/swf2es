// Definitions looked up by name, Vectors of them above all, as Flash's
// ApplicationDomain and getDefinitionByName find them: a Vector's parameter
// is any definition, one that is not a class making the Vector corrupt
// (#1107) though hasDefinition finds it, one not defined, * among them,
// making it not defined (#1065).
package {
  import flash.display.Sprite;
  import flash.system.ApplicationDomain;
  import flash.utils.getDefinitionByName;

  public class Main extends Sprite {
    public function Main() {
      var names:Array = [
        "integerValue", "Vector.<integerValue>", "Vector.<integerValueX>", "Vector.<foo>", "Vector.<Foo>",
        "Vector.<abc>", "Vector.<x>", "Vector.<Vector>", "Vector.<vector>", "Vector.<void>", "Vector.<null>",
        "Vector.<undefined>", "Vector.<>", "Vector.< >", "Vector.<*>", "Vector.<int>", "Vector.<String>",
        "Vector.<string>", "Vector.<Object>", "Vector.<Sprite>", "Vector.<flash.display.Sprite>",
        "Vector.<flash.display::Sprite>", "Vector.<pkg.Missing>", "Vector.<pkg::Missing>",
        "Vector.<__AS3__.vec::Vector>", "Vector.<__AS3__.vec.Vector>", "Vector.<Vector.<int>>",
        "Vector.<Vector.<integerValue>>", "Vector.<trace>", "Vector.<flash.utils.getTimer>",
        "Vector.<Math>", "Vector.<JSON>", "Vector.<Main>", "Vector.<1>", "Vector.<a b>", "Vector.<a.b>",
        "Vector.<counter>", "counter", "::Math", ".Math", "::JSON", ".JSON", "JSON"
      ];
      var d:ApplicationDomain = ApplicationDomain.currentDomain;
      for each (var n:String in names) {
        var has:String, get:String, byName:String;
        try { has = String(d.hasDefinition(n)); } catch (e:Error) { has = "error " + e.errorID; }
        try { get = String(d.getDefinition(n)); } catch (e:Error) { get = "error " + e.errorID; }
        try { byName = String(getDefinitionByName(n)); } catch (e:Error) { byName = "error " + e.errorID; }
        trace(n + " | has " + has + " | get " + get + " | byName " + byName);
      }
    }
  }

  public var counter:int = 7;
}
