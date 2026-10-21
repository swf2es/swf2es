package {
  import flash.display.BitmapData;
  import flash.display.GradientType;
  import flash.display.Graphics;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Matrix;

  public class Main extends Sprite {
    public function Main() {
      graphics.beginFill(0xEECC88);
      graphics.drawRect(0, 0, 480, 360);
      graphics.endFill();
      for (var i:int = 0; i < 12; i++) {
        var shape:Shape = new Shape();
        shape.x = (i % 4) * 120 + 5;
        shape.y = int(i / 4) * 120 + 5;
        addChild(shape);
        var g:Graphics = shape.graphics;
        if (i == 9) {
          var matrix:Matrix = new Matrix();
          matrix.createGradientBox(110, 100);
          g.beginGradientFill(GradientType.LINEAR, [0xCC2200, 0x0033CC], [0.6, 0.6], [0, 255], matrix);
        } else if (i == 10) {
          var bitmap:BitmapData = new BitmapData(2, 2, false, 0x336699);
          bitmap.setPixel(0, 1, 0xFFCC33);
          bitmap.setPixel(1, 0, 0xFFCC33);
          g.beginBitmapFill(bitmap, new Matrix(6, 0, 0, 6));
        } else {
          g.beginFill(0x3355BB, 0.6);
        }

        var a:Array = [[10, 10, 75, 10, 75, 85, 10, 85], [45, 25, 105, 25, 105, 105, 45, 105]];
        var winding:String = "evenOdd";
        switch (i) {
          case 0:
            a = [[0, 15, 110, 15, 110, 100, 0, 100], [25, 0, 10, 90, 45, 90], [85, 0, 65, 90, 100, 90]];
            break;
          case 2:
            winding = "nonZero";
            break;
          case 3:
            winding = "nonZero";
            a[1] = [45, 25, 45, 105, 105, 105, 105, 25];
            break;
          case 4:
          case 5:
            a[1] = a[0];
            winding = i == 5 ? "nonZero" : "evenOdd";
            break;
          case 6:
          case 7:
            a = [[55, 5, 85, 105, 5, 40, 105, 40, 25, 105]];
            winding = i == 7 ? "nonZero" : "evenOdd";
            break;
          case 8:
            a = [[5, 5, 105, 105, 5, 105, 105, 5], [5, 5, 55, 5, 5, 5]];
            break;
          case 9:
            g.drawCircle(40, 50, 38);
            g.moveTo(60, 5);
            g.cubicCurveTo(0, 30, 120, 50, 60, 100);
            g.lineTo(105, 100);
            g.lineTo(105, 5);
            g.lineTo(60, 5);
            a = [];
            break;
          case 11:
            a = [[5, 5, 105, 5, 105, 105, 5, 105], [25, 25, 85, 25, 85, 85, 25, 85],
              [40, 40, 70, 40, 70, 70, 40, 70], [70, 70, 100, 70, 100, 100, 70, 100]];
            break;
        }

        if (a.length > 0) {
          var commands:Vector.<int> = new Vector.<int>();
          var data:Vector.<Number> = new Vector.<Number>();
          for each (var contour:Array in a) {
            for (var j:int = 0; j < contour.length; j += 2) {
              commands.push(j == 0 ? 1 : 2);
              data.push(contour[j], contour[j + 1]);
            }
          }
          g.drawPath(commands, data, winding);
        }
        g.endFill();
        if (i == 10) {
          var mask:Shape = new Shape();
          mask.graphics.beginFill(0);
          mask.graphics.drawRect(10, 10, 85, 85);
          mask.graphics.drawRect(30, -10, 40, 70);
          mask.x = shape.x;
          mask.y = shape.y;
          addChild(mask);
          shape.mask = mask;
        }
        if (i == 4) {
          var emptyMask:Shape = shape;
          var hidden:Shape = new Shape();
          hidden.graphics.beginFill(0xFF0000);
          hidden.graphics.drawRect(0, 0, 110, 110);
          hidden.x = shape.x;
          hidden.y = shape.y;
          addChild(hidden);
          hidden.mask = shape;
        }
        if (i == 11) {
          shape.cacheAsBitmap = true;
        }
      }
      trace("crossing fills");
      var frame:int = 0;
      addEventListener(Event.ENTER_FRAME, function(event:Event):void {
        frame++;
        if (frame == 1) {
          hidden.mask = null;
          hidden.visible = false;
        } else {
          hidden.mask = emptyMask;
          hidden.visible = true;
          removeEventListener(Event.ENTER_FRAME, arguments.callee);
        }
        trace("mask role", frame);
      });
    }
  }
}
