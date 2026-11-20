package
{
	import flash.display.DisplayObject;
	import flash.display.Graphics;
	import flash.display.InteractiveObject;
	import flash.display.MovieClip;
	import flash.display.Shape;
	import flash.display3D.Context3D;
	import flash.events.Event;
	import flash.events.UncaughtErrorEvent;
	import flash.net.registerClassAlias;
	import flash.text.engine.ContentElement;
	import flash.utils.ByteArray;
	import flash.utils.getDefinitionByName;
	import flash.utils.getQualifiedClassName;

	// Script subclasses of the restricted display classes, most bound by
	// SymbolClass to a character (the case's SWF, tests/player/cases):
	// what Flash throws for a `new` of each, what the timeline places of
	// their characters on frame 2, and what AMF reads of an alias of one,
	// and of the other classes a script may not construct.
	public class BoundAbstractDisplay extends MovieClip
	{
		private var _frame:int = 0;

		public function BoundAbstractDisplay()
		{
			loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, uncaught);
			const names:Array = ["BoundDisplayObject", "BoundInteractiveObject", "BoundContainer",
				"BoundShapeDisplayObject", "BoundAVM1Movie", "BoundStage", "MyDisplayObject",
				"MyAVM1Movie", "MyStage"];
			for (var i:int = 0; i < names.length; i++)
			{
				try
				{
					const c:Class = getDefinitionByName(names[i]) as Class;
					trace(names[i] + ": made " + getQualifiedClassName(new c()));
				}
				catch (e:Error)
				{
					trace(names[i] + ": " + e);
				}
			}

			const classes:Array = [Graphics, DisplayObject, InteractiveObject,
				getDefinitionByName("MyDisplayObject"), getDefinitionByName("BoundDisplayObject"),
				Context3D, ContentElement, Shape];
			const encodings:Array = [0, 3];
			for (var j:int = 0; j < encodings.length; j++)
			{
				const bytes:ByteArray = new ByteArray();
				bytes.objectEncoding = encodings[j];
				registerClassAlias("A", Aliased);
				bytes.writeObject(new Aliased());
				for (var k:int = 0; k < classes.length; k++)
				{
					registerClassAlias("A", classes[k]);
					bytes.position = 0;
					const name:String = "amf" + encodings[j] + " " + getQualifiedClassName(classes[k]);
					try
					{
						trace(name + ": made " + getQualifiedClassName(bytes.readObject()));
					}
					catch (e2:Error)
					{
						trace(name + ": " + e2);
					}
				}
			}

			addEventListener(Event.ENTER_FRAME, frame);
		}

		private function uncaught(e:UncaughtErrorEvent):void
		{
			trace("uncaught " + e.error);
			e.preventDefault();
		}

		private function frame(e:Event):void
		{
			_frame++;
			const children:Array = [];
			for (var i:int = 0; i < numChildren; i++)
			{
				const child:DisplayObject = getChildAt(i);
				children.push(child == null ? "null" : child.name + "=" + getQualifiedClassName(child));
			}

			trace("frame " + currentFrame + ": " + numChildren + " " + children.join(" ") + " a=" + getChildByName("a"));
			if (_frame == 3)
			{
				removeEventListener(Event.ENTER_FRAME, frame);
			}
		}
	}
}

class Aliased
{
}
