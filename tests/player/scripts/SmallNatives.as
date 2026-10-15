package {
  import flash.display.Sprite;
  import flash.net.URLRequest;
  import flash.sensors.Accelerometer;
  import flash.text.CSMSettings;
  import flash.text.TextField;
  import flash.text.TextRenderer;
  import flash.ui.ContextMenu;

  // Flash Player natives that keep a value or answer a constant: what reads
  // back, and what a wrong argument throws.
  public class SmallNatives extends Sprite {
    public function SmallNatives() {
      var self:Object = this;
      var menu:ContextMenu = new ContextMenu();
      t("contextMenu at first", function():* { return self.contextMenu; });
      t("contextMenu set", function():* { self.contextMenu = menu; return self.contextMenu === menu; });
      t("contextMenu null", function():* { self.contextMenu = null; return self.contextMenu; });
      t("contextMenu undefined", function():* { self.contextMenu = undefined; return self.contextMenu; });
      // The message names the type as avmshell does, not as Flash does: not traced.
      t("contextMenu string", function():* { self.contextMenu = "x"; }, false);
      t("contextMenu object", function():* { self.contextMenu = {}; }, false);
      t("contextMenu after", function():* { return self.contextMenu; });

      var m:Object = menu;
      var request:URLRequest = new URLRequest("http://example.com/");
      t("link at first", function():* { return m.link; });
      t("link set", function():* { m.link = request; return m.link === request; });
      t("link string", function():* { m.link = "x"; }, false);
      t("link after", function():* { return m.link === request; });
      t("link undefined", function():* { m.link = undefined; return m.link; });

      var field:TextField = new TextField();
      field.text = "hello world";
      t("selectedText none", function():* { return "[" + field.selectedText + "]"; });
      field.setSelection(2, 7);
      t("selectedText 2 7", function():* { return "[" + field.selectedText + "]"; });
      field.setSelection(7, 2);
      t("selectedText 7 2", function():* { return "[" + field.selectedText + "]"; });
      field.setSelection(3, 100);
      t("selectedText 3 100", function():* { return "[" + field.selectedText + "]"; });
      field.text = "line1\nline2";
      field.setSelection(3, 8);
      t("selectedText line", function():* { return escape(field.selectedText); });
      field.htmlText = "<b>bold</b> and <i>it</i>";
      field.setSelection(2, 9);
      t("selectedText html", function():* { return "[" + field.selectedText + "]"; });

      var r:Object = TextRenderer;
      t("renderer at first", function():* { return [r.displayMode, r.maxLevel, r.antiAliasType].join(" "); });
      t("displayMode lcd", function():* { r.displayMode = "lcd"; return r.displayMode; });
      t("displayMode null", function():* { r.displayMode = null; return r.displayMode; });
      t("displayMode LCD", function():* { r.displayMode = "LCD"; return r.displayMode; });
      t("displayMode 5", function():* { r.displayMode = 5; return r.displayMode; });
      t("maxLevel 7", function():* { r.maxLevel = 7; return r.maxLevel; });
      t("maxLevel 5", function():* { r.maxLevel = 5; return r.maxLevel; });
      t("maxLevel 3.9", function():* { r.maxLevel = 3.9; return r.maxLevel; });
      t("maxLevel '4'", function():* { r.maxLevel = "4"; return r.maxLevel; });
      t("maxLevel null", function():* { r.maxLevel = null; return r.maxLevel; });
      t("maxLevel 2^32 + 3", function():* { r.maxLevel = 4294967299; return r.maxLevel; });
      t("antiAliasType on", function():* { r.antiAliasType = "on"; return r.antiAliasType; });
      t("antiAliasType ON", function():* { r.antiAliasType = "ON"; return r.antiAliasType; });
      t("antiAliasType null", function():* { r.antiAliasType = null; });
      t("antiAliasType undefined", function():* { r.antiAliasType = undefined; });
      t("antiAliasType default", function():* { r.antiAliasType = "default"; return r.antiAliasType; });

      var settings:Array = [new CSMSettings(10, 0.5, -0.5)];
      t("table", function():* { TextRenderer.setAdvancedAntiAliasingTable("Arial", "bold", "light", settings); });
      t("table fontName null", function():* { TextRenderer.setAdvancedAntiAliasingTable(null, "none", "dark", []); });
      t("table fontStyle null", function():* { TextRenderer.setAdvancedAntiAliasingTable("Arial", null, "dark", []); });
      t("table colorType null", function():* { TextRenderer.setAdvancedAntiAliasingTable("Arial", "none", null, []); });
      t("table null", function():* { TextRenderer.setAdvancedAntiAliasingTable("Arial", "none", "dark", null); });
      t("table unknown names", function():* { TextRenderer.setAdvancedAntiAliasingTable("", "x", "y", []); });
      t("table of numbers", function():* { TextRenderer.setAdvancedAntiAliasingTable("Arial", "none", "dark", [1]); });
      t("table of null", function():* { TextRenderer.setAdvancedAntiAliasingTable("Arial", "none", "dark", [null]); });
      t("table all wrong", function():* { TextRenderer.setAdvancedAntiAliasingTable(null, null, null, [1]); });

      t("Accelerometer", function():* { return Accelerometer.isSupported; });
    }

    private function t(label:String, f:Function, message:Boolean = true):void {
      try {
        trace(label, f());
      } catch (e:Error) {
        trace(label, "threw", Object(e).constructor, e.errorID, message ? e.message : "");
      }
    }
  }
}
