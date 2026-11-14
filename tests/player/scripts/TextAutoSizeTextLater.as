package
{
	import flash.display.BitmapData;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Point;
	import flash.geom.Rectangle;
	import flash.text.TextField;
	import flash.text.TextFieldAutoSize;
	import flash.text.TextFormat;

	// Text set on a field that fits itself: Flash fits it only when its
	// place, its size or its bounds are asked, it is drawn or hit, or a frame
	// is drawn, and then by the autoSize it has by then. So a label given its
	// text and then told to grow leftwards keeps the right edge it had with
	// no text. Traced as the edge kept, not in pixels, which the device font
	// sets.
	public class TextAutoSizeTextLater extends Sprite
	{
		private static const TEXT:String = "Enter text:";

		/** The right edge of the last field fitted to its text; 54 for one fitted to none. */
		private var _right:Number = 54;
		private var _later:TextField;
		private var _frames:int = 0;

		public function TextAutoSizeTextLater()
		{
			var t:TextField = make();
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, right", t);

			t = make();
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.CENTER;
			show("text, center", t);

			t = make();
			t.text = TEXT;
			show("text", t);

			t = make();
			t.text = TEXT;
			var n:Number = t.width;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, width read, right", t);

			t = make();
			t.text = TEXT;
			n = t.x;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, x read, right", t);

			t = make();
			t.text = TEXT;
			t.x = 50;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, x set, right", t);

			t = make();
			t.text = TEXT;
			t.hitTestPoint(70, 5);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, hitTestPoint, right", t);

			t = make();
			t.background = true;
			t.backgroundColor = 0xff0000;
			t.text = TEXT;
			var b:BitmapData = new BitmapData(300, 100, false, 0xffffff);
			b.draw(t);
			var r:Rectangle = b.getColorBoundsRect(0xffffff, 0xffffff, false);
			trace("text, drawn into a bitmap: " + (r.width < 10 ? "not fitted" : "fitted"));
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, drawn into a bitmap, right", t);

			t = make();
			t.text = TEXT;
			b = new BitmapData(300, 100, false, 0xffffff);
			b.draw(this);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, parent drawn into a bitmap, right", t);

			t = make();
			t.text = TEXT;
			n = t.textWidth;
			n = t.textHeight;
			n = t.numLines;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, text metrics read, right", t);

			t = make();
			t.text = TEXT;
			t.getCharBoundaries(8);
			t.getLineMetrics(0);
			t.getCharIndexAtPoint(30, 5);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, characters and lines asked, right", t);

			t = make();
			t.text = TEXT;
			n = t.scaleX;
			n = t.mouseX;
			t.localToGlobal(new Point(0, 0));
			var m:Object = t.transform.matrix;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, scale, pointer and matrix read, right", t);

			t = make();
			t.text = TEXT;
			removeChild(t);
			addChild(t);
			t.scrollRect = new Rectangle(0, 0, 50, 50);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, removed, added and scrolled, right", t);

			t = make();
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.LEFT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, left again, right", t);

			t = make();
			t.htmlText = TEXT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("htmlText, right", t);

			t = make();
			t.appendText(TEXT);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("appendText, right", t);

			t = make();
			t.replaceText(0, 0, TEXT);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("replaceText, right", t);

			t = make();
			t.type = "input";
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("an input field's text, right", t);

			t = fitted();
			t.setTextFormat(new TextFormat("_sans", 30, 0));
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("fitted, setTextFormat, right", t);

			t = fitted();
			t.defaultTextFormat = new TextFormat("_sans", 30, 0);
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("fitted, defaultTextFormat, text, right", t);

			t = fitted();
			t.replaceSelectedText(TEXT);
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("fitted, replaceSelectedText, right", t);

			t = fitted();
			t.multiline = true;
			t.text = TEXT + "\n" + TEXT + TEXT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("fitted, multiline, longer text, right", t);

			// A border changes no size: the fit it leaves moves nothing.
			t = fitted();
			t.border = true;
			t.autoSize = TextFieldAutoSize.RIGHT;
			trace("fitted, border, right: " + (t.x == 50 ? "where it was" : "moved"));

			t = make();
			t.autoSize = TextFieldAutoSize.RIGHT;
			n = t.width;
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.LEFT;
			show("right, text, left", t);

			t = make();
			t.autoSize = TextFieldAutoSize.CENTER;
			n = t.width;
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.LEFT;
			show("center, text, left", t);

			// No fit is left once the field no longer fits itself.
			t = make();
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.NONE;
			trace("text, none: " + (t.width < 10 ? "not fitted" : "fitted"));
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("text, none, right", t);

			// The fit is from the width set meanwhile.
			t = make();
			t.text = TEXT;
			t.width = 100;
			t.autoSize = TextFieldAutoSize.RIGHT;
			trace("text, width, right: " + (Math.abs(t.x + t.width - 150) < 1 ? "the set width's right kept" : "elsewhere"));

			// The lines are those of the height the field still has.
			t = make();
			t.multiline = true;
			t.text = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk";
			trace("lines, maxScrollV " + t.maxScrollV + ", bottomScrollV " + t.bottomScrollV);

			// A wordWrap set before the fit wraps at the width of no text.
			t = make();
			t.text = TEXT;
			t.wordWrap = true;
			trace("text, wordWrap: " + (t.width < 10 ? "not fitted" : "fitted"));

			t = make();
			t.text = TEXT;
			n = t.width;
			t.wordWrap = true;
			trace("text, width read, wordWrap: " + (t.width < 10 ? "not fitted" : "fitted"));

			// A label as a form's row makes it: left of its input, its text's end by it.
			t = new TextField();
			t.width = 10;
			t.height = 12;
			t.autoSize = TextFieldAutoSize.LEFT;
			t.defaultTextFormat = new TextFormat("_sans", 12, 0xffffff);
			t.setTextFormat(new TextFormat("_sans", 12, 0xffffff));
			t.x = 50;
			t.y = 7;
			addChild(t);
			t.text = TEXT;
			t.autoSize = TextFieldAutoSize.RIGHT;
			show("a label", t);

			_later = make();
			_later.text = TEXT;
			addEventListener(Event.ENTER_FRAME, frame);
		}

		/** A field that fits itself, fitted to no text: its left at 50, its right at 54. */
		private function make():TextField
		{
			var t:TextField = new TextField();
			t.defaultTextFormat = new TextFormat("_sans", 12, 0);
			t.autoSize = TextFieldAutoSize.LEFT;
			t.x = 50;
			addChild(t);
			return t;
		}

		/** One fitted to its text since: its left at 50 still. */
		private function fitted():TextField
		{
			const t:TextField = make();
			t.text = TEXT;
			_right = t.x + t.width;
			return t;
		}

		/** Which edge of the field a fit kept, of those it had before its text changed. */
		private function show(label:String, t:TextField):void
		{
			const x:Number = t.x;
			const width:Number = t.width;
			const right:Number = _right;
			_right = 54;
			var kept:String;
			if (width < 10)
			{
				kept = "not fitted";
			}
			else if (x == 50)
			{
				kept = "left";
			}
			else if (Math.abs(x + width - right) < 1)
			{
				kept = "right";
			}
			else if (Math.abs(x + width / 2 - (50 + right) / 2) < 1)
			{
				kept = "centre";
			}
			else
			{
				kept = "none";
			}

			trace(label + ": " + kept);
		}

		private function frame(event:Event):void
		{
			_frames++;
			if (_frames == 2)
			{
				removeEventListener(Event.ENTER_FRAME, frame);
				_later.autoSize = TextFieldAutoSize.RIGHT;
				show("text, a frame drawn, right", _later);
			}
		}
	}
}
