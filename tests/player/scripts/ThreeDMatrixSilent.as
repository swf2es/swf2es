package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.geom.Matrix3D;
  import flash.geom.Vector3D;

  // A display object's own Matrix3D changed by copyColumnFrom, copyRowFrom
  // and copyToMatrix3D: its rawData shows the change, but the object is
  // drawn where it was and its x is as it was, until a property set writes
  // its matrix back; appendTranslation moves it.
  public class ThreeDMatrixSilent extends Sprite {
    private var n:int = 0;
    private var a:Sprite, b:Sprite, c:Sprite, d:Sprite;
    public function ThreeDMatrixSilent() {
      a = card(50, 50);
      b = card(50, 150);
      c = card(50, 250);
      d = card(50, 350);
      a.transform.matrix3D.copyColumnFrom(3, new Vector3D(250, 50, 0, 1));
      b.transform.matrix3D.copyRowFrom(0, new Vector3D(1, 0, 0, 250));
      var o:Matrix3D = new Matrix3D();
      o.appendTranslation(250, 250, 0);
      o.copyToMatrix3D(c.transform.matrix3D);
      d.transform.matrix3D.appendTranslation(200, 0, 0);
      trace(a.x, b.x, c.x, d.x, a.transform.matrix3D.rawData[12]);
      addEventListener(Event.ENTER_FRAME, step);
    }
    private function step(e:Event):void {
      n++;
      trace(n, a.x, b.x, c.x, d.x, a.transform.matrix3D.rawData[12]);
      if (n == 2) {
        a.rotation = 0;
        b.alpha = 0.5;
        c.y = c.y;
        trace("after", a.x, b.x, c.x, a.transform.matrix3D.rawData[12], c.transform.matrix3D.rawData[12]);
      }
    }
    private function card(x:Number, y:Number):Sprite {
      var s:Sprite = new Sprite();
      s.graphics.beginFill(0xcc3333);
      s.graphics.drawRect(0, 0, 60, 60);
      s.x = x;
      s.y = y;
      s.z = 0;
      addChild(s);
      return s;
    }
  }
}
