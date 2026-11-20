// A background worker of a SWF 17 root, the first with workers, started
// from the root's own bytes. The root runs at its version, which sees
// neither DisplayObjectContainer's stopAllMovieClips, of SWF 21, nor
// Stage's browserZoomFactor, of SWF 26; adl runs the worker at the latest,
// whatever its root's or its own SWF's version, and it sees both. Only the
// primordial traces, its own probe and then the worker's, which the worker
// leaves in a shared property.
package
{
	import flash.display.Sprite;
	import flash.display.Stage;
	import flash.events.Event;
	import flash.system.Worker;
	import flash.system.WorkerDomain;
	import flash.utils.describeType;
	import flash.utils.getQualifiedClassName;

	public class VersionedWorker extends Sprite
	{
		private var worker:Worker;

		public function VersionedWorker()
		{
			// Nothing escapes: an error before the first frame ends would stop adl with a dialog.
			try
			{
				if (Worker.current.isPrimordial)
				{
					trace("primordial " + probe());
					worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
					worker.start();
					addEventListener(Event.ENTER_FRAME, poll);
				}
				else
				{
					Worker.current.setSharedProperty("probe", probe());
				}
			}
			catch (e:Error)
			{
				trace(getQualifiedClassName(e) + " " + e.errorID);
			}
		}

		private static function probe():String
		{
			var stopAll:int = describeType(Sprite).factory.method.(@name == "stopAllMovieClips").length();
			var zoom:int = describeType(Stage).factory.accessor.(@name == "browserZoomFactor").length();
			return "stopAllMovieClips " + stopAll + " browserZoomFactor " + zoom;
		}

		private function poll(e:Event):void
		{
			var probed:* = worker.getSharedProperty("probe");
			if (probed != null)
			{
				trace("worker " + probed);
				removeEventListener(Event.ENTER_FRAME, poll);
			}
		}
	}
}
