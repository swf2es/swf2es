package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Rectangle;
  import flash.utils.getDefinitionByName;
  import flash.utils.getQualifiedClassName;

  // The SWF's bitmap characters (cases.ts, bitmapSymbols): classes bound to
  // each kind of bitmap tag, and bitmaps the timeline placed. A JPEG's
  // colours are the browser decoder's, which part from Flash's, so only
  // their size, alpha and sameness are traced; the rest trace every pixel.
  public class BitmapSymbols extends Sprite {
    public function BitmapSymbols() {
      for (var i:int = 0; i < numChildren; i++) {
        var child:Bitmap = getChildAt(i) as Bitmap;
        trace("child", i, getQualifiedClassName(child), getQualifiedClassName(child.bitmapData),
          child.bitmapData.width, child.smoothing, child.pixelSnapping);
      }

      for each (var name:String in ["L2", "L3", "L5", "L4", "L2P", "PNG", "GIF", "PNG3"]) {
        dump(name, make(name, 7, 9));
      }

      var plain:BitmapData = make("J2", 7, 9);
      for each (name in ["J2", "JP", "JT", "JPR", "J444", "J3", "J4"]) {
        var b:BitmapData = make(name, 7, 9);
        trace(name, b.width, b.height, b.transparent, "same as J2", same(b, plain));
        if (name == "J3" || name == "J4") {
          alphas(b);
        }
      }

      trace("ignores 0 by 0", make("L2", 0, 0).width, "and -5 by 100000", make("L2", -5, 100000).height);
      var first:BitmapData = make("L2", 1, 1);
      first.setPixel32(0, 0, 0xff00ff00);
      trace("a copy each", hex(make("L2", 1, 1).getPixel32(0, 0)), hex(first.getPixel32(0, 0)));
      var BB:Class = getDefinitionByName("BB") as Class;
      var bitmap:Bitmap = new BB();
      trace("BB", getQualifiedClassName(bitmap.bitmapData), bitmap.bitmapData.width, bitmap.smoothing,
        bitmap.pixelSnapping, "fresh data", bitmap.bitmapData != new BB().bitmapData);
      for each (name in ["Bad", "Short"]) {
        invalid(name, make(name, 1, 1));
      }
    }

    private static function make(name:String, w:int, h:int):BitmapData {
      var C:Class = getDefinitionByName(name) as Class;
      return new C(w, h);
    }

    private static function hex(v:uint):String {
      var s:String = v.toString(16);
      while (s.length < 8) {
        s = "0" + s;
      }

      return s;
    }

    private static function dump(name:String, b:BitmapData):void {
      trace(name, getQualifiedClassName(b), b.width, b.height, b.transparent);
      for (var y:int = 0; y < b.height; y++) {
        var row:Array = [];
        for (var x:int = 0; x < b.width; x++) {
          row.push(hex(b.getPixel32(x, y)));
        }

        trace(" " + row.join(" "));
      }
    }

    private static function alphas(b:BitmapData):void {
      for (var y:int = 0; y < b.height; y++) {
        var row:Array = [];
        for (var x:int = 0; x < b.width; x++) {
          row.push(b.getPixel32(x, y) >>> 24);
        }

        trace(" " + row.join(" "));
      }
    }

    private static function same(a:BitmapData, b:BitmapData):Boolean {
      if (a.width != b.width || a.height != b.height) {
        return false;
      }

      for (var y:int = 0; y < a.height; y++) {
        for (var x:int = 0; x < a.width; x++) {
          if (a.getPixel32(x, y) != b.getPixel32(x, y)) {
            return false;
          }
        }
      }

      return true;
    }

    private static function invalid(name:String, b:BitmapData):void {
      trace(name, b.width, b.height, b.transparent, b.rect);
      var ops:Array = [
        ["getPixel32", function():* { return b.getPixel32(0, 0); }],
        ["clone", function():* { return b.clone(); }],
        ["fillRect", function():* { b.fillRect(new Rectangle(0, 0, 1, 1), 0); }],
        ["lock", function():* { b.lock(); }],
        ["bitmap width", function():* { return new Bitmap(b).width; }],
        ["dispose", function():* { b.dispose(); }]
      ];
      for each (var op:Array in ops) {
        try {
          op[1]();
          trace(" ", op[0], "ok");
        } catch (e:Error) {
          trace(" ", op[0], e.errorID);
        }
      }
    }
  }
}
