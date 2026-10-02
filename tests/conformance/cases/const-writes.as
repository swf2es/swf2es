// A const is set in its declarer's initializer only: a subclass's
// constructor writing an inherited one, or a method of the declarer, fails.
package {
  public class Holder {
    public const kept:Object = new Array("first");
    protected const guarded:Object = new Array("first");
    public function Holder() {
    }
    public function rewrite():void {
      this["kept"] = "late";
    }
  }
}
package {
  public class FromPublic extends Holder {
    public function FromPublic() {
      super();
      this.kept = "by subclass";
    }
  }
}
package {
  public class FromProtected extends Holder {
    public function FromProtected() {
      super();
      this.guarded = "by subclass";
    }
  }
}
function make(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
make("own", function():* { return new Holder().kept; });
make("public", function():* { return new FromPublic().kept; });
make("protected", function():* { return new FromProtected().kept; });
make("method", function():* { var h:Holder = new Holder(); h.rewrite(); return h.kept; });
