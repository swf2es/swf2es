package
{
	import flash.desktop.Clipboard;
	import flash.desktop.ClipboardFormats;
	import flash.desktop.ClipboardTransferMode;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.KeyboardEvent;
	import flash.events.MouseEvent;
	import flash.system.System;

	public class ClipboardMain extends Sprite
	{
		public function ClipboardMain()
		{
			var c:Clipboard = Clipboard.generalClipboard;
			trace("same", c == Clipboard.generalClipboard);
			attempt("new", function():void
				{
					new Clipboard();
				});
			attempt("setData", function():void
				{
					c.setData(ClipboardFormats.TEXT_FORMAT, "x");
				});
			attempt("getData", function():void
				{
					c.getData(ClipboardFormats.TEXT_FORMAT);
				});
			attempt("clear", function():void
				{
					c.clear();
				});
			attempt("setClipboard", function():void
				{
					System.setClipboard("x");
				});
			trace("formats", c.formats.length, c.hasFormat(ClipboardFormats.TEXT_FORMAT));

			// A move, and the hover a press brings, are no user's gesture; the press is.
			stage.addEventListener(MouseEvent.MOUSE_MOVE, function(e:MouseEvent):void
				{
					attempt("move", function():void
						{
							System.setClipboard("moved");
						});
				});
			stage.addEventListener(MouseEvent.MOUSE_DOWN, function(e:MouseEvent):void
				{
					attempt("down", function():void
						{
							System.setClipboard("pressed");
						});
				});

			stage.focus = this;
			stage.addEventListener(KeyboardEvent.KEY_DOWN, function(e:KeyboardEvent):void
				{
					if (e.keyCode == 83)
					{
						System.setClipboard("from setClipboard");
						return;
					}

					c.clear();
					c.setData(ClipboardFormats.TEXT_FORMAT, "written");
					c.setData(ClipboardFormats.HTML_FORMAT, "<b>written</b>");
					c.setData("custom", {n: 7});
					trace("formats", c.formats.sort());
				});
			addEventListener(Event.COPY, function(e:Event):void
				{
					c.clear();
					c.setData(ClipboardFormats.TEXT_FORMAT, "copied");
					c.setData("custom", {n: 8});
				});
			addEventListener(Event.PASTE, function(e:Event):void
				{
					var custom:Object = c.getData("custom");
					var clone:Object = c.getData("custom", ClipboardTransferMode.CLONE_ONLY);
					trace("paste", c.getData(ClipboardFormats.TEXT_FORMAT), c.hasFormat("custom"),
							custom ? custom.n : null, clone ? clone.n : null, clone == custom);
				});
		}

		private static function attempt(name:String, f:Function):void
		{
			try
			{
				f();
				trace(name, "ok");
			}
			catch (e:Error)
			{
				trace(name, Object(e).constructor, e.errorID, e.message);
			}
		}
	}
}
