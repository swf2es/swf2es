// What a MorphShape and the clip holding it measure as the morph's ratio
// changes (morphBoundsTimeline in cases/common.ts): bounds, rectangles,
// pixel bounds, sizes, points tested with and without the shape flag,
// hitTestObject, getObjectsUnderPoint as the mouse's stand-in, each frame
// and straight after a goto, and what setting a size scales by.
package
{
	import flash.display.DisplayObject;
	import flash.display.DisplayObjectContainer;
	import flash.display.MovieClip;
	import flash.display.Shape;
	import flash.geom.Point;

	public class Main extends MovieClip
	{
		private static const POINTS:Array = [[50, 50], [65, 48], [130, 85]];

		// The timeline's named instances, which Flash sets on the document class.
		public var h:MovieClip;
		public var g:MovieClip;
		public var k:MovieClip;
		public var ta:MovieClip;
		public var tb:MovieClip;
		public var tc:MovieClip;
		public var j:MovieClip;
		public var m:MovieClip;

		public function Main()
		{
			addFrameScript(0, frame1, 1, frame2, 2, frame3, 3, frame4, 4, frame5, 5, stop);
		}

		private function clip(name:String):MovieClip
		{
			return getChildByName(name) as MovieClip;
		}

		private function frame1():void
		{
			clip("h").stop();
			clip("j").stop();
			clip("m").stop();
			all(1);
			var drawn:Shape = new Shape();
			drawn.graphics.beginFill(0);
			drawn.graphics.drawRect(10, 20, 30, 40);
			addChild(drawn);
			trace("shapes: pixels " + tb.getChildAt(0).transform.pixelBounds + " drawn " + drawn.transform.pixelBounds);
			removeChild(drawn);
		}

		private function frame2():void
		{
			all(2);
			clip("h").gotoAndStop(2);
			both("2 h at 2", clip("h"));
			clip("j").gotoAndStop(2);
			both("2 j at 2", clip("j"));
			clip("m").gotoAndStop(2);
			clip("m").gotoAndStop(3);
			both("2 m back at 0", clip("m"));
		}

		private function frame3():void
		{
			all(3);
			clip("h").gotoAndStop(3);
			both("3 h at 3", clip("h"));
			both("3 j", clip("j"));
			both("3 m", clip("m"));
		}

		private function frame4():void
		{
			all(4);
			setters("4 h", clip("h"));
			clip("h").gotoAndStop(1);
			both("4 h at 1", clip("h"));
		}

		private function frame5():void
		{
			all(5);
			setters("5 g", clip("g"));
			setters("5 g morph", clip("g").getChildAt(0));
			setters("5 k morph", clip("k").getChildAt(0));
		}

		private function all(frame:int):void
		{
			both(frame + " h", clip("h"));
			both(frame + " g", clip("g"));
			both(frame + " k", clip("k"));
		}

		private function both(label:String, c:MovieClip):void
		{
			probe(label, c);
			probe(label + " morph", c.getChildAt(0));
		}

		private function probe(label:String, d:DisplayObject):void
		{
			var s:String = label + ": bounds " + d.getBounds(this) + " rect " + d.getRect(this);
			s += " pixels " + d.transform.pixelBounds + " size " + d.width + " " + d.height;
			s += " box " + hits(d, false) + " shape " + hits(d, true);
			s += " objects " + objects(d) + " under " + under(d);
			trace(s);
		}

		private function hits(d:DisplayObject, shapeFlag:Boolean):String
		{
			var t:String = "";
			for (var i:int = 0; i < POINTS.length; i++)
			{
				t += d.hitTestPoint(POINTS[i][0], POINTS[i][1], shapeFlag) ? "1" : "0";
			}
			return t;
		}

		private function objects(d:DisplayObject):String
		{
			const names:Array = ["ta", "tb", "tc"];
			var t:String = "";
			for (var i:int = 0; i < names.length; i++)
			{
				t += d.hitTestObject(getChildByName(names[i])) ? "1" : "0";
			}
			return t;
		}

		// Whether the stage lists d, or something in it, under each point.
		private function under(d:DisplayObject):String
		{
			var t:String = "";
			for (var i:int = 0; i < POINTS.length; i++)
			{
				var found:Array = stage.getObjectsUnderPoint(new Point(POINTS[i][0], POINTS[i][1]));
				var hit:Boolean = false;
				for (var j:int = 0; j < found.length; j++)
				{
					var o:DisplayObject = found[j];
					if (o == d || (d is DisplayObjectContainer && DisplayObjectContainer(d).contains(o)))
					{
						hit = true;
					}
				}
				t += hit ? "1" : "0";
			}
			return t;
		}

		private function setters(label:String, d:DisplayObject):void
		{
			d.width = 100;
			const sx:Number = d.scaleX;
			d.scaleX = 1;
			d.height = 100;
			const sy:Number = d.scaleY;
			d.scaleY = 1;
			trace(label + ": scaled " + sx + " " + sy);
		}
	}
}
