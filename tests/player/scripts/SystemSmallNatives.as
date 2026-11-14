// Small natives with fixed answers: an Accelerometer where there is none,
// Capabilities' _internal, the security domain's ID, and touch drags with no
// touch point down, which move nothing.
package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Rectangle;
	import flash.sensors.Accelerometer;
	import flash.system.Capabilities;
	import flash.system.SecurityDomain;

	public class SystemSmallNatives extends Sprite
	{
		private function t(label:String, f:Function):void
		{
			try
			{
				trace(label + " " + f());
			}
			catch (e:Error)
			{
				trace(label + " " + e);
			}
		}

		public function SystemSmallNatives()
		{
			var a:Accelerometer = new Accelerometer();
			t("accelerometer", function():*
				{
					return Accelerometer.isSupported + " " + a.muted;
				});
			for each (var interval:Number in [100, 0, -1, NaN, -Infinity, 0.5])
			{
				t("interval " + interval, function():*
					{
						a.setRequestedUpdateInterval(interval);
						return "set";
					});
			}

			t("_internal", function():*
				{
					return Object(Capabilities)["_internal"];
				});
			// A hash of the main SWF's URL, which is adl's harness there and the page's SWF here.
			t("domainID", function():*
				{
					var id:String = SecurityDomain.currentDomain.domainID;
					return id.length + " " + /^[0-9A-F]+$/.test(id) + " " + (id === SecurityDomain.currentDomain.domainID);
				});

			var s:Sprite = new Sprite();
			s.graphics.beginFill(0xff0000);
			s.graphics.drawRect(0, 0, 20, 20);
			s.x = 30;
			s.y = 40;
			addChild(s);
			t("touch drag", function():*
				{
					s.startTouchDrag(1);
					return s.x + "," + s.y;
				});
			t("locked", function():*
				{
					s.startTouchDrag(2, true);
					return s.x + "," + s.y;
				});
			t("bounded", function():*
				{
					s.startTouchDrag(3, true, new Rectangle(100, 100, 10, 10));
					return s.x + "," + s.y;
				});
			t("negative id", function():*
				{
					s.startTouchDrag(-1);
					return s.x + "," + s.y;
				});
			t("stop another", function():*
				{
					s.stopTouchDrag(9);
					return s.x + "," + s.y;
				});
			t("stop", function():*
				{
					s.stopTouchDrag(-1);
					return s.x + "," + s.y;
				});
			t("drop target", function():*
				{
					return s.dropTarget;
				});
			s.startTouchDrag(4, true, new Rectangle(100, 100, 10, 10));
			var frames:int = 0;
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					frames++;
					trace("frame " + frames + " " + s.x + "," + s.y);
					if (frames == 2)
					{
						s.stopTouchDrag(4);
						removeEventListener(Event.ENTER_FRAME, arguments.callee);
					}
				});
		}
	}
}
