// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	[API("667")]
	public class NetGroup extends EventDispatcher
	{
		public function NetGroup(connection:NetConnection, groupspec:String)
		{
		}

		public native function close():void;

		public native function get replicationStrategy():String;

		public native function set replicationStrategy(arg0:String):void;

		public native function addHaveObjects(arg0:Number, arg1:Number):void;

		public native function removeHaveObjects(arg0:Number, arg1:Number):void;

		public native function addWantObjects(arg0:Number, arg1:Number):void;

		public native function removeWantObjects(arg0:Number, arg1:Number):void;

		public native function writeRequestedObject(arg0:int, arg1:Object):void;

		public native function denyRequestedObject(arg0:int):void;

		public native function get estimatedMemberCount():Number;

		public native function get neighborCount():Number;

		public native function get receiveMode():String;

		public native function set receiveMode(arg0:String):*;

		public native function get info():NetGroupInfo;

		public native function convertPeerIDToGroupAddress(arg0:String):String;

		public native function get localCoverageFrom():String;

		public native function get localCoverageTo():String;

		public native function post(arg0:Object):String;

		public native function sendToNearest(arg0:Object, arg1:String):String;

		public native function sendToNeighbor(arg0:Object, arg1:String):String;

		public native function sendToAllNeighbors(arg0:Object):String;

		public native function addNeighbor(arg0:String):Boolean;

		public native function addMemberHint(arg0:String):Boolean;
	}
}
