// The SWF scripts/LoaderParameters.as.template loads: it keeps the
// parameters its constructor sees, for the loader to tell (Flash completes
// several loads in no fixed order).
package {
  import flash.display.MovieClip;

  public class ParametersInner extends MovieClip {
    public var seen:String;

    public function ParametersInner() {
      var p:Object = loaderInfo.parameters;
      var pairs:Array = [];
      for (var name:String in p) {
        pairs.push(name + "=" + p[name]);
      }

      pairs.sort();
      seen = pairs.join(",");
    }
  }
}
