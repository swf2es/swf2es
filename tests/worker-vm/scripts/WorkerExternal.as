package {
  import flash.display.Sprite;
  import flash.external.ExternalInterface;

  public class WorkerExternal extends Sprite {
    public function WorkerExternal() {
      ExternalInterface.marshallExceptions = true;
      ExternalInterface.addCallback("nest", nest);
      ExternalInterface.addCallback("outbound", outbound);
      ExternalInterface.call("probePage", 0, "");
    }

    private function nest(depth:int, failure:String):String {
      trace("vm:" + depth);
      if (failure == "vm:" + depth) {
        trace("throw:" + depth);
        throw new Error("vm failure " + depth);
      }
      return depth == 0 ? "leaf" : "vm(" + ExternalInterface.call("probePage", depth - 1, failure) + ")";
    }

    private function outbound(depth:int, failure:String):* {
      return ExternalInterface.call("probePage", depth, failure);
    }
  }
}
