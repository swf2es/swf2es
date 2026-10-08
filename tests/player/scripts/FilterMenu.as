package {
  import flash.display.*;
  import flash.events.Event;
  import flash.filters.BevelFilter;
  import flash.text.*;

  // A menu as a game's chat makes one: each option a background scaled to
  // the widest label, a label and an arrow, under a bevel; an option's
  // submenu its child, beside it, under a bevel of its own and hidden
  // until frame 3 shows it. Flash draws the submenu whole.
  public class FilterMenu extends Sprite {
    private var top:Sprite;
    // The stage's size over its own: as built for Flash at a host's zoom.
    private var zoom:Number = 1;
    private var frame:int = 0;

    private function option(label:String):Sprite {
      var o:Sprite = new Sprite();
      var bg:Shape = new Shape();
      bg.name = "bg";
      bg.graphics.beginFill(0x404080);
      bg.graphics.drawRect(0, 0, 120, 23);
      bg.graphics.endFill();
      o.addChild(bg);
      var t:TextField = new TextField();
      t.name = "txt";
      t.x = 2;
      t.y = 2.55;
      t.height = 18.6;
      t.textColor = 0x404080;
      t.text = label;
      o.addChild(t);
      var more:Shape = new Shape();
      more.name = "more";
      more.graphics.beginFill(0xffcc00);
      more.graphics.drawRect(0, 6, 8, 11);
      more.graphics.endFill();
      o.addChild(more);
      for (var i:int = 0; i < 3; i++) {
        var dot:Shape = new Shape();
        dot.graphics.beginFill(0x8080c0);
        dot.graphics.drawRect(60 + i * 6, 10, 3, 3);
        dot.graphics.endFill();
        o.addChild(dot);
      }
      return o;
    }

    private function menu(widths:Array, sub:Array):Sprite {
      var m:Sprite = new Sprite();
      var widest:Number = 0;
      for (var i:int = 0; i < widths.length; i++) {
        var o:Sprite = option("item " + i);
        o.y = i * 23;
        widest = Math.max(widest, widths[i]);
        m.addChild(o);
        if (i == 1 && sub) {
          var s:Sprite = menu(sub, null);
          s.name = "sub";
          s.y = -23;
          s.visible = false;
          o.addChild(s);
        }
      }
      for (i = 0; i < m.numChildren; i++) {
        o = m.getChildAt(i) as Sprite;
        (o.getChildByName("txt") as TextField).width = widest + 6;
        o.getChildByName("bg").width = widest + 20;
        o.getChildByName("more").x = widest + 10;
        if (o.getChildByName("sub")) {
          o.getChildByName("sub").x = widest + 20;
        }
      }
      m.cacheAsBitmap = true;
      m.filters = [new BevelFilter(zoom, 45, 0, 1, 0, 1, 0, 0, 1, 3)];
      return m;
    }

    public function FilterMenu() {
      addEventListener(Event.ENTER_FRAME, tick);
    }

    private function build():void {
      zoom = loaderInfo.width / 300;
      // Enough options in the submenu to make it a batch of its own in the player.
      top = menu([60, 77, 50, 40], [149, 120, 100, 149, 80, 90, 110, 70, 60, 149, 100, 120]);
      top.x = 10 * zoom;
      top.y = 30 * zoom;
      top.scaleX = top.scaleY = zoom;
      top.visible = false;
      addChild(top);
    }

    private function tick(e:Event):void {
      frame++;
      if (frame == 1) {
        build();
      } else if (frame == 2) {
        top.visible = true;
      } else if (frame == 3) {
        var sub:DisplayObject = (top.getChildAt(1) as Sprite).getChildByName("sub");
        sub.visible = true;
        trace(Math.round(top.width / zoom), Math.round(top.height / zoom), sub.width, sub.height);
        removeEventListener(Event.ENTER_FRAME, tick);
      }
    }
  }
}
