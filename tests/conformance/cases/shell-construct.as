// How avmshell's native classes limit their construction: abstract ones
// only through a subclass, restricted ones not through a subclass from
// another ABC, or what extends that; native ones not from AS3 at all.
package {
  import avmshell.AbstractBase;
  public class FromAbstract extends AbstractBase {}
}
package {
  import avmshell.RestrictedBase;
  public class FromRestricted extends RestrictedBase {}
}
package {
  public class FromFromRestricted extends FromRestricted {}
}
package {
  import avmshell.SubclassOfRestrictedBase;
  public class FromShellChild extends SubclassOfRestrictedBase {}
}
package {
  import avmshell.AbstractRestrictedBase;
  public class FromAbstractRestricted extends AbstractRestrictedBase {}
}
import avmshell.*;
function make(name:String, cls:Class):void {
  try { new cls(); trace(name, "made"); } catch (e:Error) { trace(name, e); }
}
make("abstract", AbstractBase);
make("abstract's subclass", FromAbstract);
make("abstract's shell subclass", SubclassOfAbstractBase);
make("restricted", RestrictedBase);
make("restricted's subclass", FromRestricted);
make("its subclass", FromFromRestricted);
make("shell subclass's subclass", FromShellChild);
make("abstract-restricted", AbstractRestrictedBase);
make("abstract-restricted's subclass", FromAbstractRestricted);
make("native", NativeBase);
make("native AS3", NativeBaseAS3);
make("check", CheckBase);
