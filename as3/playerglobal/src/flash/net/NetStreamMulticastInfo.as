// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/NetStreamMulticastInfo.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net
{
	[API("667")]
	public final class NetStreamMulticastInfo
	{
		public function NetStreamMulticastInfo(arg0:Number, arg1:Number, arg2:Number, arg3:Number, arg4:Number, arg5:Number, arg6:Number, arg7:Number, arg8:Number, arg9:Number, arg10:Number, arg11:Number, arg12:Number, arg13:Number, arg14:Number, arg15:Number, arg16:Number, arg17:Number, arg18:Number)
		{
			// Which argument is which of the fields below is Flash Player's own:
			// not kept yet.
		}

		private var _bytesPushedFromPeers:Number;
		private var _bytesPushedToPeers:Number;
		private var _bytesReceivedFromIPMulticast:Number;
		private var _bytesReceivedFromServer:Number;
		private var _bytesRequestedByPeers:Number;
		private var _bytesRequestedFromPeers:Number;
		private var _fragmentsPushedFromPeers:Number;
		private var _fragmentsPushedToPeers:Number;
		private var _fragmentsReceivedFromIPMulticast:Number;
		private var _fragmentsReceivedFromServer:Number;
		private var _fragmentsRequestedByPeers:Number;
		private var _fragmentsRequestedFromPeers:Number;
		private var _receiveControlBytesPerSecond:Number;
		private var _receiveDataBytesPerSecond:Number;
		private var _receiveDataBytesPerSecondFromIPMulticast:Number;
		private var _receiveDataBytesPerSecondFromServer:Number;
		private var _sendControlBytesPerSecond:Number;
		private var _sendControlBytesPerSecondToServer:Number;
		private var _sendDataBytesPerSecond:Number;

		public function toString():String
		{
			return "";
		}

		public function get bytesPushedFromPeers():Number
		{
			return this._bytesPushedFromPeers;
		}

		public function get bytesPushedToPeers():Number
		{
			return this._bytesPushedToPeers;
		}

		public function get bytesReceivedFromIPMulticast():Number
		{
			return this._bytesReceivedFromIPMulticast;
		}

		public function get bytesReceivedFromServer():Number
		{
			return this._bytesReceivedFromServer;
		}

		public function get bytesRequestedByPeers():Number
		{
			return this._bytesRequestedByPeers;
		}

		public function get bytesRequestedFromPeers():Number
		{
			return this._bytesRequestedFromPeers;
		}

		public function get fragmentsPushedFromPeers():Number
		{
			return this._fragmentsPushedFromPeers;
		}

		public function get fragmentsPushedToPeers():Number
		{
			return this._fragmentsPushedToPeers;
		}

		public function get fragmentsReceivedFromIPMulticast():Number
		{
			return this._fragmentsReceivedFromIPMulticast;
		}

		public function get fragmentsReceivedFromServer():Number
		{
			return this._fragmentsReceivedFromServer;
		}

		public function get fragmentsRequestedByPeers():Number
		{
			return this._fragmentsRequestedByPeers;
		}

		public function get fragmentsRequestedFromPeers():Number
		{
			return this._fragmentsRequestedFromPeers;
		}

		public function get receiveControlBytesPerSecond():Number
		{
			return this._receiveControlBytesPerSecond;
		}

		public function get receiveDataBytesPerSecond():Number
		{
			return this._receiveDataBytesPerSecond;
		}

		public function get receiveDataBytesPerSecondFromIPMulticast():Number
		{
			return this._receiveDataBytesPerSecondFromIPMulticast;
		}

		public function get receiveDataBytesPerSecondFromServer():Number
		{
			return this._receiveDataBytesPerSecondFromServer;
		}

		public function get sendControlBytesPerSecond():Number
		{
			return this._sendControlBytesPerSecond;
		}

		public function get sendControlBytesPerSecondToServer():Number
		{
			return this._sendControlBytesPerSecondToServer;
		}

		public function get sendDataBytesPerSecond():Number
		{
			return this._sendDataBytesPerSecond;
		}
	}
}
