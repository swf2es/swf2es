// A child taken off its parent again, or moved, by its own listener for
// REMOVED or REMOVED_FROM_STAGE while its removal tells of it: Flash throws
// #2094 at the second removal and finishes the first, or #2025 when the
// first is the timeline's; a move goes through, and the first removal then
// takes the child from where it is. removeChildren takes those there when
// it began; addChild's move out of another parent throws at nothing. Each
// case is a row of Boxes, so what is left of it draws: the siblings after
// the child must stay. While the timeline's removal tells of it, the child
// is out of its parent's list already, still its parent's: the indexes
// have closed up, its parent contains it, and asks after its index throw.
package {
  import flash.display.DisplayObject;
  import flash.display.DisplayObjectContainer;
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Box extends MovieClip {
  }

  public class Main extends MovieClip {
    public var p0:Box;
    public var p1:Box;
    public var p2:Box;
    private var rows:int = 0;
    private var holder:Sprite;

    public function Main() {
      addFrameScript(0, frame1, 1, frame2);
    }

    private function row(names:Array):Sprite {
      var layer:Sprite = new Sprite();
      layer.name = "row" + rows;
      layer.y = 12 * rows++;
      addChild(layer);
      for (var i:int = 0; i < names.length; i++) {
        var b:Box = new Box();
        b.name = names[i];
        b.x = 12 * i;
        layer.addChild(b);
      }

      return layer;
    }

    private function list(c:DisplayObjectContainer):String {
      var names:Array = [];
      for (var i:int = 0; i < c.numChildren; i++) {
        var d:DisplayObject = c.getChildAt(i);
        names.push(d.name + (d.parent == c ? "" : "(parent " + d.parent + ")"));
      }

      return "[" + names.join(",") + "]";
    }

    private function parentName(d:DisplayObject):String {
      if (d.parent == stage) {
        return "stage";
      }

      if (d.parent == this) {
        return "main";
      }

      return d.parent ? d.parent.name : "null";
    }

    /** `f` once, from `d`'s next `type` event, reporting what it throws. */
    private function once(d:DisplayObject, type:String, what:String, f:Function):void {
      var heard:Function = function(e:Event):void {
        d.removeEventListener(type, heard);
        trace(" " + what + " in " + type + ", parent " + parentName(d) + ", on stage " + (d.stage != null));
        try {
          f();
          trace(" " + what + " done");
        } catch (err:Error) {
          trace(" " + what + " threw " + err.errorID + " " + (err is ArgumentError ? "ArgumentError" : "Error"));
        }
      };
      d.addEventListener(type, heard);
    }

    private function attempt(what:String, f:Function):void {
      try {
        f();
        trace(what + " done");
      } catch (err:Error) {
        trace(what + " threw " + err.errorID);
      }
    }

    private function frame1():void {
      holder = new Sprite();
      holder.name = "holder";
      holder.x = 60;
      addChild(holder);

      trace("removeChild, removed again from removedFromStage");
      var a:Sprite = row(["a0", "a1", "a2"]);
      var a0:DisplayObject = a.getChildAt(0);
      once(a0, Event.REMOVED_FROM_STAGE, "removeChild", function():void {
        a0.parent.removeChild(a0);
      });
      attempt("outer", function():void {
        a.removeChild(a0);
      });
      trace(list(a), parentName(a0), a.contains(a.getChildAt(a.numChildren - 1)));

      trace("removeChildAt, removed again from removed");
      var b:Sprite = row(["b0", "b1", "b2"]);
      var b1:DisplayObject = b.getChildAt(1);
      once(b1, Event.REMOVED, "removeChildAt", function():void {
        b.removeChildAt(b.getChildIndex(b1));
      });
      attempt("outer", function():void {
        b.removeChildAt(1);
      });
      trace(list(b), parentName(b1));

      trace("moved elsewhere from removedFromStage");
      var c:Sprite = row(["c0", "c1", "c2"]);
      var c0:DisplayObject = c.getChildAt(0);
      once(c0, Event.REMOVED_FROM_STAGE, "move", function():void {
        holder.addChild(c0);
      });
      attempt("outer", function():void {
        c.removeChild(c0);
      });
      trace(list(c), list(holder), parentName(c0));

      trace("moved to the top of the same parent from removed");
      var d:Sprite = row(["d0", "d1", "d2"]);
      var d0:DisplayObject = d.getChildAt(0);
      once(d0, Event.REMOVED, "top", function():void {
        d.addChild(d0);
      });
      attempt("outer", function():void {
        d.removeChild(d0);
      });
      trace(list(d), parentName(d0));

      trace("setChildIndex from removed");
      var e:Sprite = row(["e0", "e1", "e2"]);
      var e2:DisplayObject = e.getChildAt(2);
      once(e2, Event.REMOVED, "setChildIndex", function():void {
        e.setChildIndex(e2, 0);
      });
      attempt("outer", function():void {
        e.removeChild(e2);
      });
      trace(list(e), parentName(e2));

      trace("removeChildren, a sibling removed from removed");
      var f:Sprite = row(["f0", "f1", "f2", "f3"]);
      var f0:DisplayObject = f.getChildAt(0);
      var f1:DisplayObject = f.getChildAt(1);
      once(f0, Event.REMOVED, "sibling", function():void {
        f.removeChild(f1);
      });
      attempt("outer", function():void {
        f.removeChildren(0, 1);
      });
      trace(list(f), parentName(f0), parentName(f1));

      trace("removeChildren, a sibling moved from removed");
      var k:Sprite = row(["k0", "k1", "k2", "k3"]);
      var k0:DisplayObject = k.getChildAt(0);
      var k1:DisplayObject = k.getChildAt(1);
      once(k0, Event.REMOVED, "sibling", function():void {
        holder.addChild(k1);
      });
      attempt("outer", function():void {
        k.removeChildren(0, 1);
      });
      trace(list(k), list(holder), parentName(k0), parentName(k1));

      trace("removeChildren, removed again from removed");
      var g:Sprite = row(["g0", "g1", "g2"]);
      var g0:DisplayObject = g.getChildAt(0);
      once(g0, Event.REMOVED, "again", function():void {
        g.removeChild(g0);
      });
      attempt("outer", function():void {
        g.removeChildren(0, 1);
      });
      trace(list(g), parentName(g0));

      trace("addChild from another parent, moved elsewhere from removed");
      var h:Sprite = row(["h0", "h1", "h2"]);
      var h2:Sprite = row(["h3"]);
      var h0:DisplayObject = h.getChildAt(0);
      once(h0, Event.REMOVED, "move", function():void {
        holder.addChild(h0);
      });
      attempt("outer", function():void {
        h2.addChild(h0);
      });
      trace(list(h), list(h2), list(holder), parentName(h0));

      trace("addChild from another parent, removed from removed");
      var i:Sprite = row(["i0", "i1", "i2"]);
      var i2:Sprite = row(["i3"]);
      var i0:DisplayObject = i.getChildAt(0);
      once(i0, Event.REMOVED, "remove", function():void {
        i.removeChild(i0);
      });
      attempt("outer", function():void {
        i2.addChild(i0);
      });
      trace(list(i), list(i2), parentName(i0));

      trace("stage.removeChildAt, removed again from removed");
      var j:Box = new Box();
      j.name = "j";
      j.y = 12 * rows++;
      stage.addChild(j);
      once(j, Event.REMOVED, "stage", function():void {
        j.parent.removeChild(j);
      });
      attempt("outer", function():void {
        stage.removeChildAt(stage.getChildIndex(j));
      });
      trace(stage.numChildren, parentName(j));

      once(p0, Event.REMOVED_FROM_STAGE, "timeline remove", function():void {
        p0.parent.removeChild(p0);
      });
      // Its siblings' indexes as the timeline's removal tells of it: removeChildAt(0) is p2's.
      var self:Main = this;
      once(p1, Event.REMOVED, "timeline remove", function():void {
        trace(" ", self.numChildren, list(self), self.contains(p1), parentName(p1));
        trace(" ", self.getChildByName("p1"), self.p1 == p1);
        attempt(" getChildIndex", function():void {
          self.getChildIndex(p1);
        });
        attempt(" setChildIndex", function():void {
          self.setChildIndex(p1, 0);
        });
        attempt(" swapChildren", function():void {
          self.swapChildren(p1, p2);
        });
        self.removeChildAt(0);
      });
      trace("frame 1", list(this));
    }

    private function frame2():void {
      trace("frame 2", list(this), list(holder));
      trace("p0 " + p0 + ", p1 " + p1 + ", p2 " + p2);
    }
  }
}
