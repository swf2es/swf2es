package {
  import flash.display.Sprite;
  import flash.net.*;
  public class Main extends Sprite {
    public function Main() {
      function t(name:String, f:Function):void {
        try { f(); trace(name, "ok"); } catch (e:Error) { trace(name, Object(e).constructor, e.message); }
      }
      t("nav null", function():void { navigateToURL(null); });
      t("nav null url", function():void { navigateToURL(new URLRequest(), "_self"); });
      t("send null", function():void { sendToURL(null); });
      t("send null url", function():void { sendToURL(new URLRequest()); });

      var vars:URLVariables = new URLVariables();
      vars.q = "a b";
      var get:URLRequest = new URLRequest("page.html?x=1");
      get.data = vars;
      t("nav get", function():void { navigateToURL(get, "_self"); });
      t("nav default", function():void { navigateToURL(new URLRequest("/top.html")); });
      var post:URLRequest = new URLRequest("http://other.test/form");
      post.method = URLRequestMethod.POST;
      post.data = vars;
      t("nav post", function():void { navigateToURL(post, "named"); });
      t("send", function():void { sendToURL(new URLRequest("ping")); });
      t("nav blank", function():void { navigateToURL(new URLRequest("b"), "Blank"); });
      t("nav blanket", function():void { navigateToURL(new URLRequest("c"), "_blanket"); });
      t("nav empty", function():void { navigateToURL(new URLRequest("")); });
      var put:URLRequest = new URLRequest("put.html");
      put.method = "PUT";
      put.data = vars;
      t("nav put", function():void { navigateToURL(put); });
    }
  }
}
