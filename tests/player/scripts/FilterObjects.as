package {
  import flash.display.*;
  import flash.filters.*;
  import flash.geom.*;
  import flash.utils.*;

  // Filter objects as adl keeps their values: each class's defaults, every
  // property set to values past its range, and the arrays' rules.
  public class FilterObjects extends Sprite {
    private function t(label:String, f:Function):void {
      try { trace(label, f()); } catch (e:Error) { trace(label, "threw", e.errorID); }
    }
    public function FilterObjects() {
      var classes:Array = [BlurFilter, GlowFilter, DropShadowFilter, BevelFilter, ColorMatrixFilter,
        ConvolutionFilter, DisplacementMapFilter, GradientGlowFilter, GradientBevelFilter];
      for each (var c:Class in classes) {
        var f:Object = new c();
        var d:XML = describeType(f);
        var line:Array = [getQualifiedClassName(f)];
        var props:Array = [];
        for each (var a:XML in d.accessor) {
          props.push(String(a.@name) + ":" + String(a.@type) + ":" + String(a.@access));
        }
        props.sort();
        trace(line[0], "defaults");
        for each (var p:String in props) {
          var name:String = p.split(":")[0];
          var v:* = f[name];
          trace("  ", p, "=", v is Array ? "[" + v.join(",") + "]" : v);
        }
        for each (var q:String in props) {
          var parts:Array = q.split(":");
          if (parts[2] != "readwrite") continue;
          var n:String = parts[0];
          var results:Array = [];
          var values:Array = parts[1] == "Number" || parts[1] == "int" || parts[1] == "uint"
            ? [-1.5, 0.5, 3.4, 300, 1e9, NaN, -1e9, 0x123456789]
            : parts[1] == "Boolean" ? [1, 0, "x", null]
            : parts[1] == "String" ? ["inner", "outer", "full", "bogus", null]
            : [];
          for each (var val:* in values) {
            var g:Object = new c();
            try {
              g[n] = val;
              results.push(val + "->" + g[n]);
            } catch (e:Error) {
              results.push(val + "->" + e.errorID);
            }
          }
          if (results.length) trace("  set", n, results.join(" "));
        }
      }
      t("cm short", function():* { var f:ColorMatrixFilter = new ColorMatrixFilter([1, 2]); return f.matrix.length + " " + f.matrix; });
      t("cm long", function():* { var a:Array = []; for (var i:int = 0; i < 25; i++) a.push(i); var f:ColorMatrixFilter = new ColorMatrixFilter(a); return f.matrix.length + " " + f.matrix; });
      t("cm values", function():* { var f:ColorMatrixFilter = new ColorMatrixFilter(["2", NaN, null, undefined, "x", 1.5, true, 0x123456789, -3.3, 1e40]); return f.matrix.length + " " + f.matrix; });
      t("cm null", function():* { var f:ColorMatrixFilter = new ColorMatrixFilter(); f.matrix = null; return f.matrix; });
      t("cm copy", function():* { var a:Array = [1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0]; var f:ColorMatrixFilter = new ColorMatrixFilter(a); a[0] = 9; var m:Array = f.matrix; m[1] = 9; return f.matrix[0] + " " + f.matrix[1] + " " + (f.matrix == f.matrix); });
      t("cm float", function():* { var f:ColorMatrixFilter = new ColorMatrixFilter([0.1, 1/3, 1e-50, 123456789.123]); return f.matrix.slice(0, 4); });
      t("conv", function():* { var f:ConvolutionFilter = new ConvolutionFilter(3, 2, [1,2,3,4,5,6,7], 2); return f.matrixX + " " + f.matrixY + " " + f.matrix.length + " [" + f.matrix + "]"; });
      t("conv long", function():* { var f:ConvolutionFilter = new ConvolutionFilter(2, 2, [1,2,3,4,5,6,7,8.3], 2); return f.matrix.length + " [" + f.matrix + "]"; });
      t("conv resize", function():* { var f:ConvolutionFilter = new ConvolutionFilter(2, 2, [1,2,3,4]); f.matrixX = 3; return f.matrix.length + " [" + f.matrix + "]"; });
      t("conv null", function():* { var f:ConvolutionFilter = new ConvolutionFilter(2, 2, [1,2,3,4]); f.matrix = null; return f.matrix; });
      t("conv float", function():* { var f:ConvolutionFilter = new ConvolutionFilter(1, 1, [0.1]); return f.matrix[0]; });
      t("gg", function():* { var f:GradientGlowFilter = new GradientGlowFilter(4, 45, [0xff0000, 0x00ff00, 0x123456789], [1, 0.5], [0, 128, 300, 255], 4, 4, 1, 1, "outer"); return f.colors + " | " + f.alphas + " | " + f.ratios; });
      t("gg alphas long", function():* { var f:GradientGlowFilter = new GradientGlowFilter(4, 45, [1, 2], [1, 0.5, 0.25, 2], [0, 255]); return f.colors + " | " + f.alphas + " | " + f.ratios; });
      t("gg ratios short", function():* { var f:GradientGlowFilter = new GradientGlowFilter(4, 45, [1, 2, 3], [1, 0.5, 0.2], [0]); return f.colors + " | " + f.alphas + " | " + f.ratios; });
      t("gg set colors", function():* { var f:GradientGlowFilter = new GradientGlowFilter(4, 45, [1, 2], [1, 0.5], [0, 255]); f.colors = [7, 8, 9]; return f.colors + " | " + f.alphas + " | " + f.ratios; });
      t("gg alpha values", function():* { var f:GradientGlowFilter = new GradientGlowFilter(4, 45, [1, 2, 3, 4], [-1, 0.5, 2, NaN], [-5, 1.5, 254.9, NaN]); return f.colors + " | " + f.alphas + " | " + f.ratios; });
      t("gg null", function():* { var f:GradientGlowFilter = new GradientGlowFilter(4, 45, [1, 2], [1, 0.5], [0, 255]); f.colors = null; return f.colors + " | " + f.alphas + " | " + f.ratios; });
      t("gg 20", function():* { var c:Array = []; for (var i:int = 0; i < 20; i++) c.push(i); var f:GradientGlowFilter = new GradientGlowFilter(4, 45, c, c, c); return f.colors.length + " " + f.alphas.length + " " + f.ratios.length; });
      t("dm", function():* { var f:DisplacementMapFilter = new DisplacementMapFilter(null, new Point(1.5, 2.5), 1, 2, 3.3, 4.4, "clamp"); var p:Point = f.mapPoint; p.x = 99; return f.mapPoint + " " + f.mode + " " + f.scaleX; });
      t("dm bitmap", function():* { var b:BitmapData = new BitmapData(2, 2); var f:DisplacementMapFilter = new DisplacementMapFilter(b); return (f.mapBitmap == b) + " " + f.mapPoint; });
      t("clone", function():* { var f:BlurFilter = new BlurFilter(3, 4, 2); var c:BlurFilter = f.clone() as BlurFilter; return c.blurX + " " + c.blurY + " " + c.quality + " " + (c == f); });
      t("toString", function():* { return new BlurFilter() + " " + new ColorMatrixFilter(); });
    }
  }
}
