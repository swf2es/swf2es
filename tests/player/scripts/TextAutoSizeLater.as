package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.text.TextField;
  import flash.text.TextFieldAutoSize;
  import flash.text.TextFormat;

  // A size set on a field that fits itself, or an autoSize set on one:
  // Flash fits it only when its size or bounds are asked, its transform
  // changes or a frame is drawn, so a wordWrap set before any of those
  // wraps at the width the field has. Traced as kept or fitted, not in
  // pixels, which the device font sets.
  public class TextAutoSizeLater extends Sprite {
    private static const TEXT:String = "A field that fits itself to a long line of text, longer than the width a script gives it.";

    private var _later:TextField;
    private var _laterRead:TextField;
    private var _laterAutoSize:TextField;
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

      // An autoSize set on a field of no text, 200 wide, as a chat bubble's label is.
      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.LEFT;
      t.wordWrap = true;
      t.text = TEXT;
      show("left autoSize, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      var x:Number = t.x;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, x read, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.x = t.x;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, x set as it was, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      var autoWidth:Number = t.width;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, width read, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      var y:Number = t.y;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, y read, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      var scale:Number = t.scaleX;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, scaleX read, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      var turn:Number = t.rotation;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, rotation read, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.alpha = 0.5;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, alpha set, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.visible = true;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, visible set, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.y = 30;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, y set, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.scaleX = 1;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, scaleX set, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.rotation = 0;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, rotation set, wordWrap, text", t);

      t = plain();
      t.autoSize = TextFieldAutoSize.CENTER;
      t.transform.matrix = t.transform.matrix;
      t.wordWrap = true;
      t.text = TEXT;
      show("autoSize, transform.matrix set, wordWrap, text", t);

      t = plain();
      t.text = "abc";
      t.autoSize = TextFieldAutoSize.CENTER;
      t.wordWrap = true;
      t.text = TEXT;
      show("text, autoSize, wordWrap, text", t);

      _later = make();
      _later.width = 200;
      _laterRead = make();
      _laterRead.width = 200;
      _laterAutoSize = plain();
      _laterAutoSize.autoSize = TextFieldAutoSize.CENTER;
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

    /** A field of no text and no autoSize, 200 wide, its x 50. */
    private function plain():TextField {
      var t:TextField = new TextField();
      t.defaultTextFormat = new TextFormat("_sans", 12, 0);
      t.x = 50;
      t.width = 200;
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
        _laterAutoSize.wordWrap = true;
        _laterAutoSize.text = TEXT;
        show("autoSize, a frame drawn, wordWrap, text", _laterAutoSize);
      }
    }
  }
}
