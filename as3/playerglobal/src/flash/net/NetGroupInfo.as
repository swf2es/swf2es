// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	[API("667")]
	public final class NetGroupInfo
	{
		public function NetGroupInfo(arg0:Number, arg1:Number, arg2:Number, arg3:Number, arg4:Number, arg5:Number, arg6:Number, arg7:Number)
		{
		}

		public native function get postingSendDataBytesPerSecond():Number;

		public native function get postingSendControlBytesPerSecond():Number;

		public native function get postingReceiveDataBytesPerSecond():Number;

		public native function get postingReceiveControlBytesPerSecond():Number;

		public native function get routingSendBytesPerSecond():Number;

		public native function get routingReceiveBytesPerSecond():Number;

		public native function get objectReplicationSendBytesPerSecond():Number;

		public native function get objectReplicationReceiveBytesPerSecond():Number;

		public native function toString():String;
	}
}
