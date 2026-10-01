// A class the script's initializer constructs, before the frame's SymbolClass
// has bound it to a sprite with a child: Flash says whether that instance
// gets the sprite's child, and whether one made in the constructor does.
// Box comes first: classes initialize in source order, and Main's static
// initializer needs Box made (Flash: Error #1115 the other way round).
package {
  import flash.display.MovieClip;

  public class Box extends MovieClip {
    public function Box() {
      trace("Box", numChildren);
    }
  }

  public class Main extends MovieClip {
    private static var early:Box = new Box();

    public function Main() {
      trace("Main", early.numChildren, new Box().numChildren, numChildren);
    }
  }
}
