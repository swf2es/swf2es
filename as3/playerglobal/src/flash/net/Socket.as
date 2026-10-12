// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/net/Socket.ts.

package flash.net
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;
	import flash.utils.IDataInput;
	import flash.utils.IDataOutput;

	public class Socket extends EventDispatcher implements IDataInput, IDataOutput
	{
		private var _timeout:uint = 20000;

		public function Socket(host:String = null, port:int = 0)
		{
			if (host != null)
			{
				connect(host, port);
			}
		}

		public function connect(host:String, port:int):void
		{
			if (port < 0 || port > 65535)
			{
				Error.throwError(SecurityError, 2003);
			}

			internalConnect(host, port);
		}

		[API("662")]
		public function get timeout():uint
		{
			return _timeout;
		}

		[API("662")]
		// Kept: the player's connections wait as long as the host's do.
		public function set timeout(value:uint):void
		{
			// No less than 250 ms, as Flash's clamps it.
			_timeout = value < 250 ? 250 : value;
		}

		public native function readBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0):void;

		public native function writeBytes(bytes:ByteArray, offset:uint = 0, length:uint = 0):void;

		public native function writeBoolean(value:Boolean):void;

		public native function writeByte(value:int):void;

		public native function writeShort(value:int):void;

		public native function writeInt(value:int):void;

		public native function writeUnsignedInt(value:uint):void;

		public native function writeFloat(value:Number):void;

		public native function writeDouble(value:Number):void;

		public native function writeMultiByte(value:String, charSet:String):void;

		public native function writeUTF(value:String):void;

		public native function writeUTFBytes(value:String):void;

		public native function readBoolean():Boolean;

		public native function readByte():int;

		public native function readUnsignedByte():uint;

		public native function readShort():int;

		public native function readUnsignedShort():uint;

		public native function readInt():int;

		public native function readUnsignedInt():uint;

		public native function readFloat():Number;

		public native function readDouble():Number;

		public native function readMultiByte(length:uint, charSet:String):String;

		public native function readUTF():String;

		public native function readUTFBytes(length:uint):String;

		public native function get bytesAvailable():uint;

		public native function get connected():Boolean;

		public function close():void
		{
			internalClose();
		}

		public native function flush():void;

		public native function writeObject(value:*):void;

		public native function readObject():*;

		public native function get objectEncoding():uint;

		public native function set objectEncoding(value:uint):void;

		public native function get endian():String;

		public native function set endian(value:String):void;

		[API("674")]
		public native function get bytesPending():uint;

		[API("668")]
		public native function get localAddress():String;

		[API("668")]
		public native function get localPort():int;

		[API("668")]
		public native function get remoteAddress():String;

		[API("668")]
		public native function get remotePort():int;

		// The player's natives (packages/player/src/playerglobal/flash/net/Socket.ts).
		private native function internalGetSecurityErrorMessage(host:String, port:int):String;

		private native function internalConnect(host:String, port:int):void;

		private native function didFailureOccur():Boolean;

		private native function internalClose():void;

		private native function OnError():void;

		private native function wasCalledByAppContent(arg0:String):Boolean;
	}
}
