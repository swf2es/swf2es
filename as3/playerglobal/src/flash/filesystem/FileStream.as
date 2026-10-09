// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.filesystem
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;
	import flash.utils.IDataInput;
	import flash.utils.IDataOutput;

	[API("661")]
	public class FileStream extends EventDispatcher implements IDataInput, IDataOutput
	{
		public function FileStream()
		{
		}

		public native function open(arg0:File, arg1:String):void;
		public native function openAsync(arg0:File, arg1:String):void;
		public native function truncate():void;
		public native function get position():Number;
		public native function set position(arg0:Number):void;
		public native function close():void;
		public native function get readAhead():Number;
		public native function set readAhead(arg0:Number):void;
		public native function get bytesAvailable():uint;
		public native function get endian():String;
		public native function set endian(arg0:String):void;
		public native function get objectEncoding():uint;
		public native function set objectEncoding(arg0:uint):void;
		public native function readBoolean():Boolean;
		public native function readByte():int;
		public native function readBytes(arg0:ByteArray, arg1:uint = 0, arg2:uint = 0):void;
		public native function readDouble():Number;
		public native function readFloat():Number;
		public native function readInt():int;
		public native function readMultiByte(arg0:uint, arg1:String):String;
		public native function readObject():*;
		public native function readShort():int;
		public native function readUnsignedByte():uint;
		public native function readUnsignedInt():uint;
		public native function readUnsignedShort():uint;
		public native function readUTF():String;
		public native function readUTFBytes(arg0:uint):String;
		public native function writeBoolean(arg0:Boolean):void;
		public native function writeByte(arg0:int):void;
		public native function writeBytes(arg0:ByteArray, arg1:uint = 0, arg2:uint = 0):void;
		public native function writeDouble(arg0:Number):void;
		public native function writeFloat(arg0:Number):void;
		public native function writeInt(arg0:int):void;
		public native function writeMultiByte(arg0:String, arg1:String):void;
		public native function writeObject(arg0:*):void;
		public native function writeShort(arg0:int):void;
		public native function writeUnsignedInt(arg0:uint):void;
		public native function writeUTF(arg0:String):void;
		public native function writeUTFBytes(arg0:String):void;
	}
}
