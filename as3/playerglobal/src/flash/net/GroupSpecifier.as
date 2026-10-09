// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	[API("667")]
	public class GroupSpecifier
	{
		public function GroupSpecifier(arg0:String)
		{
		}

		public static native function encodePostingAuthorization(arg0:String):String;

		public static native function encodePublishAuthorization(arg0:String):String;

		public static native function encodeIPMulticastAddressSpec(arg0:String, arg1:* = null, arg2:String = null):String;

		public static native function encodeBootstrapPeerIDSpec(arg0:String):String;

		[API("684")]
		public static native function get maxSupportedGroupspecVersion():int;

		public native function makeUnique():void;

		public native function get routingEnabled():Boolean;

		public native function set routingEnabled(arg0:Boolean):void;

		public native function get multicastEnabled():Boolean;

		public native function set multicastEnabled(arg0:Boolean):void;

		public native function get objectReplicationEnabled():Boolean;

		public native function set objectReplicationEnabled(arg0:Boolean):void;

		public native function get postingEnabled():Boolean;

		public native function set postingEnabled(arg0:Boolean):void;

		public native function get peerToPeerDisabled():Boolean;

		public native function set peerToPeerDisabled(arg0:Boolean):void;

		public native function get ipMulticastMemberUpdatesEnabled():Boolean;

		public native function set ipMulticastMemberUpdatesEnabled(arg0:Boolean):void;

		public native function setPublishPassword(arg0:String = null, arg1:String = null):void;

		public native function setPostingPassword(arg0:String = null, arg1:String = null):void;

		public native function get serverChannelEnabled():Boolean;

		public native function set serverChannelEnabled(arg0:Boolean):void;

		public native function addBootstrapPeer(arg0:String):void;

		public native function addIPMulticastAddress(arg0:String, arg1:* = null, arg2:String = null):void;

		public native function toString():String;

		public native function groupspecWithoutAuthorizations():String;

		public native function groupspecWithAuthorizations():String;

		public native function authorizations():String;

		[API("684")]
		public native function get minGroupspecVersion():int;

		[API("684")]
		public native function set minGroupspecVersion(arg0:int):void;
	}
}
