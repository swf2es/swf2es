// ApplicationDomain's lookups of the current domain: a class whose lazy
// script throws as it runs (scripts/DefinitionsBad.as), which hasDefinition
// reports as not defined, before getDefinition and after, while
// getDefinition and getDefinitionByName let its error through each time,
// one whose script throws an invalid Vector's error among them
// (scripts/DefinitionsIndirect.as); and names nothing defines, refused by
// their local names.
package {
  import flash.display.Sprite;
  import flash.system.ApplicationDomain;
  import flash.utils.getDefinitionByName;

  public class Main extends Sprite {
    public function Main() {
      var d:ApplicationDomain = ApplicationDomain.currentDomain;
      probe("has Bad", function():* { return d.hasDefinition("Bad"); });
      probe("get Bad", function():* { return d.getDefinition("Bad"); });
      probe("get Bad again", function():* { return d.getDefinition("Bad"); });
      probe("has Bad after gets", function():* { return d.hasDefinition("Bad"); });
      probe("byName Bad", function():* { return getDefinitionByName("Bad"); });
      probe("byName Bad again", function():* { return getDefinitionByName("Bad"); });
      probe("byName some.pkg.Missing", function():* { return getDefinitionByName("some.pkg.Missing"); });
      probe("has Indirect", function():* { return d.hasDefinition("Indirect"); });
      probe("get Indirect", function():* { return d.getDefinition("Indirect"); });
      probe("has Indirect after get", function():* { return d.hasDefinition("Indirect"); });
      probe("has Missing", function():* { return d.hasDefinition("Missing"); });
      probe("get Missing", function():* { return d.getDefinition("Missing"); });
      probe("get some.pkg.Missing", function():* { return d.getDefinition("some.pkg.Missing"); });
      probe("has null", function():* { return d.hasDefinition(null); });
      probe("get Main", function():* { return d.getDefinition("Main"); });
    }
  }
}

function probe(name:String, f:Function):void {
  try {
    trace(name, f());
  } catch (e:Error) {
    trace(name, e);
  }
}
