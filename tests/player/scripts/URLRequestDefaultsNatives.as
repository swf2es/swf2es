// AIR's URLRequestDefaults: the defaults, what a set keeps, the requests made
// before and after it, and the user agent of null and "".
package {
  import flash.display.Sprite;
  import flash.net.URLRequest;
  import flash.net.URLRequestDefaults;

  public class URLRequestDefaultsNatives extends Sprite {
    private static const NAMES:Array = ["authenticate", "cacheResponse", "followRedirects", "idleTimeout",
      "manageCookies", "useCache"];

    private function t(label:String, f:Function):void {
      try {
        trace(label + " " + f());
      } catch (e:Error) {
        trace(label + " " + e);
      }
    }

    // The agent is AIR's own on adl's Windows, the player's platform here.
    private static function agent(v:*):String {
      return String(v).indexOf("AdobeAIR/51.3") > 0 ? "air" : JSON.stringify(v);
    }

    private function report(label:String, o:Object):void {
      for (var i:int = 0; i < NAMES.length; i++) {
        trace(label + " " + NAMES[i] + " " + o[NAMES[i]]);
      }

      trace(label + " userAgent " + agent(o["userAgent"]));
    }

    public function URLRequestDefaultsNatives() {
      var d:Object = URLRequestDefaults;
      report("default", d);
      var before:Object = new URLRequest("a");
      report("before", before);
      t("set booleans", function():* {
        d["authenticate"] = false;
        d["cacheResponse"] = 0;
        d["followRedirects"] = false;
        d["manageCookies"] = "";
        d["useCache"] = false;
        return "done";
      });
      t("idleTimeout 2.5", function():* { d["idleTimeout"] = 2.5; return d["idleTimeout"]; });
      t("idleTimeout -1", function():* { d["idleTimeout"] = -1; return d["idleTimeout"]; });
      t("idleTimeout NaN", function():* { d["idleTimeout"] = NaN; return d["idleTimeout"]; });
      t("idleTimeout 3", function():* { d["idleTimeout"] = 3; return d["idleTimeout"]; });
      t("userAgent x", function():* { d["userAgent"] = "x"; return agent(d["userAgent"]); });
      report("defaults set", d);
      var after:Object = new URLRequest("b");
      report("after", after);
      report("before still", before);
      t("userAgent 5", function():* { d["userAgent"] = 5; return agent(d["userAgent"]); });
      t("userAgent null", function():* { d["userAgent"] = null; return agent(d["userAgent"]); });
      t("request of null", function():* { return agent(new URLRequest()["userAgent"]); });
      t("userAgent empty", function():* { d["userAgent"] = ""; return agent(d["userAgent"]); });
      t("request of empty", function():* { return agent(new URLRequest()["userAgent"]); });
      t("request set null", function():* {
        d["userAgent"] = "y";
        var r:Object = new URLRequest();
        r["userAgent"] = null;
        return agent(r["userAgent"]);
      });
      t("request idleTimeout -1", function():* {
        var r:Object = new URLRequest();
        r["idleTimeout"] = -1;
        return r["idleTimeout"];
      });
      t("login", function():* { return d.setLoginCredentialsForHost("example.com", "user", "password"); });
      t("login nulls", function():* { return d.setLoginCredentialsForHost(null, null, null); });
      t("new", function():* { return new URLRequestDefaults(); });
    }
  }
}
