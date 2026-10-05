package {
  import flash.display.Sprite;
  import flash.system.LoaderContext;
  import flash.system.SecurityDomain;

  public class SecurityDomainNatives extends Sprite {
    public function SecurityDomainNatives() {
      var first:SecurityDomain = SecurityDomain.currentDomain;
      var second:SecurityDomain = SecurityDomain.currentDomain;
      trace("current", first != null, first is SecurityDomain, first === second);

      var context:LoaderContext = new LoaderContext(false, null, first);
      trace("context", context.securityDomain === first);

      try {
        var cls:Class = SecurityDomain;
        var made:SecurityDomain = new cls() as SecurityDomain;
        trace("new", made != null, made === first);
      } catch (error:Error) {
        trace("new", error.toString());
      }
    }
  }
}
