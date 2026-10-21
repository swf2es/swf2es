package {
  import flash.display.DisplayObject;
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;

  public class MetadataChild extends Sprite {
    public function MetadataChild() {
      trace("constructor", name, metaData);
      metaData = {kwy: "constructor"};
      addEventListener(Event.ADDED, function(e:Event):void {
        if (e.target == e.currentTarget) {
          var child:DisplayObject = DisplayObject(e.currentTarget);
          trace("added", child.name, child.metaData && child.metaData.kwy);
        }
      });
    }
  }

  public class Main extends MovieClip {
    public var a:MetadataChild;
    public var b:MetadataChild;
    public var plain:MetadataChild;
    public var skip:MetadataChild;
    private var pass:int = 0;
    private var old:DisplayObject;

    public function Main() {
      addFrameScript(0, first, 1, second, 2, third, 3, rewind, 5, skipped);
    }

    private function report(label:String):void {
      for (var i:int = 0; i < numChildren; i++) {
        var c:DisplayObject = getChildAt(i);
        trace(label, c.name, c.metaData && c.metaData.kwy, c.metaData === c.metaData);
      }
    }

    private function first():void {
      if (++pass > 1) {
        report("rewind");
        gotoAndStop(6);
        return;
      }

      report("first");
      old = a;
      trace("shared", a.metaData === b.metaData);
      a.metaData.kwy = "mutated";
      report("mutated");
      b.metaData = {kwy: "script"};
    }

    private function second():void {
      report("move");
      trace("same", a === old);
    }

    private function third():void {
      report("replace");
    }

    private function rewind():void {
      gotoAndStop(1);
    }

    private function skipped():void {
      report("skipped");
      stop();
    }
  }
}
