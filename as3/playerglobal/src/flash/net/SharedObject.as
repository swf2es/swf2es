// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/net/SharedObject.ts.

package flash.net
{
	import flash.events.EventDispatcher;

	public class SharedObject extends EventDispatcher
	{
		public function SharedObject()
		{
		}

		public static native function deleteAll(arg0:String):int;

		public static native function getDiskUsage(arg0:String):int;

		public static native function getLocal(name:String, localPath:String = null, secure:Boolean = false):SharedObject;

		public static native function getRemote(arg0:String, arg1:String = null, arg2:Object = false, arg3:Boolean = false):SharedObject;

		public static native function get defaultObjectEncoding():uint;

		public static native function set defaultObjectEncoding(arg0:uint):void;

		[API("689")]
		public static native function get preventBackup():Boolean;

		[API("689")]
		public static native function set preventBackup(arg0:Boolean):void;

		public native function get data():Object;

		public native function connect(arg0:NetConnection, arg1:String = null):void;

		public native function close():void;

		public native function flush(minDiskSpace:int = 0):String;

		public native function get size():uint;

		public native function set fps(arg0:Number):void;

		public native function send(...rest):void;

		public native function clear():void;

		public native function get objectEncoding():uint;

		public native function set objectEncoding(value:uint):void;

		public native function get client():Object;

		public native function set client(arg0:Object):void;

		public native function setDirty(arg0:String):void;

		public native function setProperty(propertyName:String, value:Object = null):void;
	}
}
