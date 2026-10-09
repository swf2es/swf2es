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
		public static function get preventBackup():Boolean
		{
			return preventBackupImpl;
		}

		[API("689")]
		public static function set preventBackup(value:Boolean):void
		{
			preventBackupImpl = value;
		}

		public native function get data():Object;

		public native function connect(arg0:NetConnection, arg1:String = null):void;

		public function close():void
		{
			invoke(CLOSE);
		}

		public function flush(minDiskSpace:int = 0):String
		{
			if (!invoke(FLUSH, minDiskSpace))
			{
				Error.throwError(Error, 2130);
			}

			return SharedObjectFlushStatus.FLUSHED;
		}

		public function get size():uint
		{
			return invoke(GET_SIZE);
		}

		public native function set fps(arg0:Number):void;

		public native function send(...rest):void;

		public function clear():void
		{
			invoke(CLEAR);
		}

		public native function get objectEncoding():uint;

		public native function set objectEncoding(value:uint):void;

		public native function get client():Object;

		public native function set client(arg0:Object):void;

		public native function setDirty(arg0:String):void;

		public function setProperty(propertyName:String, value:Object = null):void
		{
			data[propertyName] = value;
			setDirty(propertyName);
		}

		// The player's natives (packages/player/src/playerglobal/flash/net/SharedObject.ts).
		// What the player's invoke does, by these codes (SharedObject.ts).
		private static const FLUSH:uint = 2;
		private static const CLOSE:uint = 3;
		private static const GET_SIZE:uint = 4;
		private static const CLEAR:uint = 6;

		private native function invoke(code:uint, ...rest):*;

		private static native function get preventBackupImpl():Boolean;

		private static native function set preventBackupImpl(value:Boolean):void;
	}
}
