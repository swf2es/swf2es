// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	[API("668")]
	public class NetworkInterface
	{
		public function NetworkInterface()
		{
		}

		public native function get name():String;
		public native function set name(arg0:String):void;
		public native function get displayName():String;
		public native function set displayName(arg0:String):void;
		public native function get addresses():Vector.<InterfaceAddress>;
		public native function set addresses(arg0:Vector.<InterfaceAddress>):void;
		public native function get mtu():int;
		public native function set mtu(arg0:int):void;
		public native function get hardwareAddress():String;
		public native function set hardwareAddress(arg0:String):void;
		public native function get parent():NetworkInterface;
		public native function set parent(arg0:NetworkInterface):void;
		public native function get subInterfaces():Vector.<NetworkInterface>;
		public native function set subInterfaces(arg0:Vector.<NetworkInterface>):void;
		public native function get active():Boolean;
		public native function set active(arg0:Boolean):void;
	}
}
