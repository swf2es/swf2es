// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.display.BitmapData;
	import flash.events.EventDispatcher;
	import flash.geom.Rectangle;
	import flash.utils.ByteArray;

	public final class Camera extends EventDispatcher
	{
		public function Camera()
		{
		}

		public static native function get names():Array;
		[API("667")]
		public static native function get isSupported():Boolean;
		public static native function getCamera(name:String = null):Camera;
		public native function get activityLevel():Number;
		public native function get bandwidth():int;
		public native function get currentFPS():Number;
		public native function get fps():Number;
		public native function get height():int;
		public native function get index():int;
		public native function get keyFrameInterval():int;
		public native function get loopback():Boolean;
		public native function get motionLevel():int;
		public native function get motionTimeout():int;
		public native function get muted():Boolean;
		public native function get name():String;
		[API("675")]
		public native function get position():String;
		public native function get quality():int;
		public native function get width():int;
		public native function setCursor(arg0:Boolean):void;
		public native function setKeyFrameInterval(keyFrameInterval:int):void;
		public native function setLoopback(compress:Boolean = false):void;
		public native function setMode(width:int, height:int, fps:Number, favorArea:Boolean = true):void;
		public native function setMotionLevel(motionLevel:int, timeout:int = 2000):void;
		public native function setQuality(bandwidth:int, quality:int):void;
		[API("682")]
		public native function drawToBitmapData(destination:BitmapData):void;
		[API("682")]
		public native function copyToByteArray(rect:Rectangle, destination:ByteArray):void;
		[API("682")]
		public native function copyToVector(rect:Rectangle, destination:Vector.<uint>):void;
	}
}
