package {
  import flash.display.Sprite;
  import flash.system.ApplicationDomain;
  import flash.utils.getDefinitionByName;

  public class CurrentDomainChild extends Sprite {
    public function CurrentDomainChild() {
      var d:ApplicationDomain = ApplicationDomain.currentDomain;
      trace("child sees its class", d.hasDefinition("CurrentDomainOnly"));
      trace("child sees the main class", d.hasDefinition("Main"));
      trace("child finds its class", getDefinitionByName("CurrentDomainOnly"));
      var f:Function = function ():Boolean {
        return ApplicationDomain.currentDomain.hasDefinition("CurrentDomainOnly");
      };
      trace("child's closure sees its class", f());
    }
  }
}
