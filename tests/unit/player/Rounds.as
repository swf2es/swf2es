package {
  import flash.display.MovieClip;

  public dynamic class Clip extends MovieClip {
    public function Clip() {
      addFrameScript(0, function():void { trace(name, 1); },
        1, function():void { trace(name, 2); stop(); if (name != "a") poke(); },
        2, function():void { trace(name, 3); stop(); },
        3, function():void { trace(name, 4); stop(); });
    }

    private function poke():void {
      var a:MovieClip = MovieClip(parent.getChildByName("a"));
      if (name == "goto") {
        a.gotoAndStop(3);
      } else if (name == "place") {
        a.gotoAndStop(4);
      } else {
        var kid:Kid = new Kid();
        kid.name = name;
        if (name == "add") {
          MovieClip(parent).addChild(kid);
        }
      }
    }
  }

  public class Kid extends MovieClip {
    public function Kid() {
      addFrameScript(0, function():void { trace("kid", name); });
    }
  }

  public dynamic class Main extends MovieClip {
    public function Main() {
      addFrameScript(1, function():void { trace("main", 2); stop(); });
    }
  }
}
