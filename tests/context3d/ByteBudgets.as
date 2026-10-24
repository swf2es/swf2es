package {
  import flash.display.Sprite;
  import flash.display3D.Context3D;
  import flash.events.Event;

  public class ByteBudgets extends Sprite {
    public var complete:Boolean = false;

    public function ByteBudgets() {
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        var context:Context3D = stage.stage3Ds[0].context3D;
        context.enableErrorChecking = true;
        probe("vertex", 9, function():* { return context.createVertexBuffer(32768, 64); });
        probe("index", 129, function():* { return context.createIndexBuffer(262144); });
        probe("texture", 4, function():* { return context.createTexture(2048, 2048, "bgra", false); });
        probe("rectangle", 5, function():* { return context.createRectangleTexture(2048, 2048, "bgra", false); });
        probe("cube", 3, function():* { return context.createCubeTexture(1024, "bgra", false); });
        context.dispose(false);
        complete = true;
        trace("bytebudgets complete");
      });
      stage.stage3Ds[0].requestContext3D("auto", "baseline");
    }

    private function probe(label:String, count:int, create:Function):void {
      var held:Array = [];
      try {
        for (var i:int = 0; i < count; i++) { held.push(create()); }
        trace("bytebudgets", label, held.length, "accepted");
      } catch (error:Error) {
        trace("bytebudgets", label, held.length, error.name, error.errorID);
      } finally {
        for (var j:int = 0; j < held.length; j++) { held[j].dispose(); }
      }
    }
  }
}
