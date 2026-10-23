package {
  import flash.display.Sprite;
  import flash.display3D.Context3D;
  import flash.events.Event;
  public class ResourceLimits extends Sprite {
    public var complete:Boolean = false;
    private var held:Array = [];
    private var context:Context3D;
    public function ResourceLimits() {
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        context = stage.stage3Ds[0].context3D;
        context.enableErrorChecking = true;
        probe("vertex", function():* { return context.createVertexBuffer(1, 4); });
        probe("index", function():* { return context.createIndexBuffer(3); });
        probe("program", function():* { return context.createProgram(); });
        probe("texture", function():* { return context.createTexture(1, 1, "bgra", false); });
        probe("rectangle", function():* { return context.createRectangleTexture(1, 1, "bgra", false); });
        probe("cube", function():* { return context.createCubeTexture(8, "bgra", false); });
        context.dispose(false);
        complete = true;
        trace("resourcelimits complete");
      });
      stage.stage3Ds[0].requestContext3D("auto", "baseline");
    }
    private function probe(name:String, create:Function):void {
      var group:Array = [];
      held.push(group);
      try {
        for (var i:int = 0; i < 8193; i++) { group.push(create()); }
        trace("resourcelimits", name, group.length, "no-limit");
      } catch (e:Error) {
        trace("resourcelimits", name, group.length, e.name, e.errorID);
      }
      if (group.length == 4096) {
        group[0].dispose();
        group[0] = create();
        trace("resourcelimits", name, "reused", group.length);
      }
    }
  }
}
