package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.BlurFilter;
  import flash.geom.ColorTransform;
  import flash.geom.Rectangle;

  public class RenderGroups extends Sprite {
    private var frame:int = 1;
    private var panels:Array = [];
    private var art:Array = [];
    private var clipping:Shape;
    private var saved:Array = [];

    public function RenderGroups() {
      for (var p:int = 0; p < 3; p++) {
        var panel:Sprite = new Sprite();
        panel.x = 8 + p * 76;
        panel.y = 8;
        panel.transform.colorTransform = new ColorTransform(0.75, 0.5, 1, 0.75);
        addChild(panel);
        panels.push(panel);
        var tiles:Sprite = new Sprite();
        panel.addChild(tiles);
        art.push(tiles);
        for (var i:int = 0; i < 64; i++) {
          var tile:Shape = new Shape();
          tile.graphics.beginFill(i % 2 ? 0x4080c0 : 0xc08040);
          tile.graphics.drawRect(0, 0, 6, 6);
          tile.graphics.endFill();
          tile.x = (i % 8) * 8;
          tile.y = int(i / 8) * 8;
          if (i % 3 == 0) {
            tile.transform.colorTransform = new ColorTransform(1, 1, 1, 1, 24, -16, 32);
          }
          tiles.addChild(tile);
        }
      }
      clipping = new Shape();
      clipping.graphics.beginFill(0);
      clipping.graphics.drawRect(0, 0, 32, 64);
      clipping.graphics.endFill();
      panels[1].addChild(clipping);
      art[1].mask = clipping;
      panels[2].filters = [new BlurFilter(2, 2, 1)];
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(event:Event):void {
      frame++;
      if (frame == 2) {
        panels[0].x += 3;
        panels[0].alpha = 0.5;
        addChild(clipping);
        clipping.x = 100;
        clipping.y = 8;
      } else if (frame == 3) {
        art[1].mask = null;
        removeChild(clipping);
        panels[0].scrollRect = new Rectangle(8, 8, 48, 48);
      } else if (frame == 4) {
        while (art[0].numChildren > 4) {
          saved.push(art[0].removeChildAt(4));
        }
      } else if (frame == 5) {
        for each (var tile:Shape in saved) {
          art[0].addChild(tile);
        }
        panels[0].scrollRect = null;
        panels[0].transform.colorTransform = new ColorTransform(1, 1, 1, 1, 32, 16, -16);
      }
      trace(frame);
    }
  }
}
