package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.text.TextField;
  import flash.text.TextFieldAutoSize;
  import flash.text.TextFormat;

  // A size set on a field that fits itself: Flash fits it again only when
  // its size or bounds are asked, its transform changes or a frame is
  // drawn, so a wordWrap set before any of those wraps at the size set.
  // Traced as kept or fitted, not in pixels, which the device font sets.
  public class TextAutoSizeLater extends Sprite {
    private static const TEXT:String = "A field that fits itself to a long line of text, longer than the width a script gives it.";

    private var _later:TextField;
    private var _laterRead:TextField;
    private var _frames:int = 0;

    public function TextAutoSizeLater() {
      var t:TextField = make();
      t.width = 200;
      t.wordWrap = true;
      show("width, wordWrap", t);

      t = make();
      t.width = 200;
      var w:Number = t.width;
      t.wordWrap = true;
      show("width, width read, wordWrap", t);

      t = make();
      t.width = 200;
      var h:Number = t.height;
      t.wordWrap = true;
      show("width, height read, wordWrap", t);

      t = make();
      t.width = 200;
      var n:int = t.numLines;
      t.wordWrap = true;
      show("width, numLines read, wordWrap", t);

      t = make();
      t.width = 200;
      var tw:Number = t.textWidth;
      t.wordWrap = true;
      show("width, textWidth read, wordWrap", t);

      t = make();
      t.width = 200;
      t.getBounds(this);
      t.wordWrap = true;
      show("width, getBounds, wordWrap", t);

      t = make();
      t.width = 200;
      var parentWidth:Number = width;
      t.wordWrap = true;
      show("width, parent's width, wordWrap", t);

      t = make();
      t.width = 200;
      t.text = TEXT + " And some more.";
      t.wordWrap = true;
      show("width, new text, wordWrap", t);

      t = make();
      t.width = 200;
      t.x = 3;
      t.wordWrap = true;
      show("width, x, wordWrap", t);

      t = make();
      t.width = 200;
      show("width, then read", t);

      t = make();
      t.width = 200;
      t.autoSize = TextFieldAutoSize.LEFT;
      t.wordWrap = true;
      show("width, autoSize again, wordWrap", t);

      t = make();
      t.width = 200;
      t.multiline = true;
      t.wordWrap = true;
      show("width, multiline, wordWrap", t);

      _later = make();
      _later.width = 200;
      _laterRead = make();
      _laterRead.width = 200;
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function make():TextField {
      var t:TextField = new TextField();
      t.autoSize = TextFieldAutoSize.LEFT;
      t.defaultTextFormat = new TextFormat("_sans", 12, 0);
      t.text = TEXT;
      addChild(t);
      return t;
    }

    private function show(label:String, t:TextField):void {
      var kept:Boolean = Math.round(t.width) == 200;
      trace(label + ": " + (kept ? "kept, " + (t.numLines > 1 ? "wrapped" : "one line") : "fitted"));
    }

    private function frame(event:Event):void {
      _frames++;
      if (_frames == 2) {
        removeEventListener(Event.ENTER_FRAME, frame);
        _later.wordWrap = true;
        show("width, a frame drawn, wordWrap", _later);
        show("width, a frame drawn, read", _laterRead);
      }
    }
  }
}
