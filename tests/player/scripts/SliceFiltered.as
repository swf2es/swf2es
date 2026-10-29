// A filtered Shape in a 9-slice panel whose slice moves as a sibling's
// drawing grows (cases.ts, `slice-filtered`): adl draws the filtered Shape
// as a bitmap of it, stretched whole and not sliced, while the panel's own
// drawing is sliced, and moves with the slice.
package {
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.filters.GlowFilter;
  import flash.geom.Rectangle;

  public class SliceFiltered extends Sprite {
    private var sibling:Shape = new Shape();
    private var frame:int = 0;

    public function SliceFiltered() {
      graphics.beginFill(0xdddddd);
      graphics.drawRect(0, 0, 320, 120);
      graphics.endFill();
      var panel:Sprite = new Sprite();
      panel.graphics.beginFill(0x99aacc);
      panel.graphics.drawRoundRect(0, 0, 100, 40, 16);
      panel.graphics.endFill();
      var bars:Shape = new Shape();
      bars.graphics.beginFill(0xcc3333);
      bars.graphics.drawRect(4, 12, 8, 16);
      bars.graphics.drawRect(88, 12, 8, 16);
      bars.graphics.endFill();
      bars.filters = [new GlowFilter(0x000000, 1, 4, 4, 2, 1)];
      panel.addChild(bars);
      sibling.graphics.beginFill(0x339933);
      sibling.graphics.drawRect(40, 16, 10, 8);
      sibling.graphics.endFill();
      panel.addChild(sibling);
      panel.scale9Grid = new Rectangle(20, 10, 60, 20);
      panel.scaleX = 2.5;
      panel.scaleY = 2;
      panel.x = 20;
      panel.y = 20;
      addChild(panel);
      addEventListener(Event.ENTER_FRAME, tick);
      trace("drawn");
    }

    private function tick(e:Event):void {
      frame++;
      if (frame == 2) {
        // Widens what the grid divides: the panel's right edge, and the bars with it, move.
        sibling.graphics.clear();
        sibling.graphics.beginFill(0x339933);
        sibling.graphics.drawRect(40, 16, 80, 8);
        sibling.graphics.endFill();
      } else if (frame == 3) {
        removeEventListener(Event.ENTER_FRAME, tick);
      }
    }
  }
}
