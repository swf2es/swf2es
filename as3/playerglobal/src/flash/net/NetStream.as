// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;
	import flash.media.Camera;
	import flash.media.Microphone;
	import flash.media.SoundTransform;
	import flash.media.VideoStreamSettings;
	import flash.utils.ByteArray;

	public class NetStream extends EventDispatcher
	{
		public function NetStream(connection:NetConnection, peer:String = "connectToFMS")
		{
		}

		public static const DIRECT_CONNECTIONS:String = "directConnections";
		public static const CONNECT_TO_FMS:String = "connectToFMS";
		[API("674")]
		public native function dispose():void;
		[API("667")]
		public native function attach(connection:NetConnection):void;
		public native function close():void;
		public native function attachAudio(mic:Microphone):void;
		public native function attachCamera(cam:Camera, ms:int = -1):void;
		public native function send(handlerName:String, ...args):void;
		public native function get bufferTime():Number;
		public native function set bufferTime(time:Number):void;
		[API("662")]
		public native function get maxPauseBufferTime():Number;
		[API("662")]
		public native function set maxPauseBufferTime(time:Number):void;
		[API("667")]
		public native function get backBufferTime():Number;
		[API("667")]
		public native function set backBufferTime(time:Number):void;
		[API("667")]
		public native function get inBufferSeek():Boolean;
		[API("667")]
		public native function set inBufferSeek(isInBuffer:Boolean):void;
		[API("667")]
		public native function get backBufferLength():Number;
		[API("667")]
		public native function step(frames:int):void;
		[API("667")]
		public native function get bufferTimeMax():Number;
		[API("667")]
		public native function set bufferTimeMax(time:Number):void;
		public native function receiveAudio(flag:Boolean):void;
		public native function receiveVideo(flag:Boolean):void;
		public native function receiveVideoFPS(fps:Number):void;
		public native function pause():void;
		public native function resume():void;
		public native function togglePause():void;
		public native function seek(offset:Number):void;
		public native function play(...args):void;
		[API("662")]
		public native function play2(param:NetStreamPlayOptions):void;
		[API("662")]
		public native function get info():NetStreamInfo;
		[API("667")]
		public native function get multicastInfo():NetStreamMulticastInfo;
		public native function publish(name:String = null, type:String = null):void;
		public native function get time():Number;
		public native function get currentFPS():Number;
		public native function get bufferLength():Number;
		public native function get liveDelay():Number;
		public native function get bytesLoaded():uint;
		public native function get bytesTotal():uint;
		public native function get decodedFrames():uint;
		public native function get videoCodec():uint;
		public native function get audioCodec():uint;
		public native function get soundTransform():SoundTransform;
		public native function set soundTransform(tf:SoundTransform):void;
		public native function get checkPolicyFile():Boolean;
		public native function set checkPolicyFile(doCheck:Boolean):void;
		public native function get client():Object;
		public native function set client(client:Object):void;
		public native function get objectEncoding():uint;
		[API("667")]
		public native function get multicastPushNeighborLimit():Number;
		[API("667")]
		public native function set multicastPushNeighborLimit(limit:Number):void;
		[API("667")]
		public native function get multicastWindowDuration():Number;
		[API("667")]
		public native function set multicastWindowDuration(dur:Number):void;
		[API("667")]
		public native function get multicastRelayMarginDuration():Number;
		[API("667")]
		public native function set multicastRelayMarginDuration(dur:Number):void;
		[API("667")]
		public native function get multicastAvailabilityUpdatePeriod():Number;
		[API("667")]
		public native function set multicastAvailabilityUpdatePeriod(period:Number):void;
		[API("667")]
		public native function get multicastFetchPeriod():Number;
		[API("667")]
		public native function set multicastFetchPeriod(period:Number):void;
		[API("667")]
		public native function get multicastAvailabilitySendToAll():Boolean;
		[API("667")]
		public native function set multicastAvailabilitySendToAll(toAll:Boolean):void;
		[API("662")]
		public native function get farID():String;
		[API("662")]
		public native function get nearNonce():String;
		[API("662")]
		public native function get farNonce():String;
		[API("662")]
		public native function get peerStreams():Array;
		[API("662")]
		public native function onPeerConnect(arg0:NetStream):Boolean;
		[API("667")]
		public native function get audioReliable():Boolean;
		[API("667")]
		public native function set audioReliable(isReliable:Boolean):void;
		[API("667")]
		public native function get videoReliable():Boolean;
		[API("667")]
		public native function set videoReliable(isReliable:Boolean):void;
		[API("667")]
		public native function get dataReliable():Boolean;
		[API("667")]
		public native function set dataReliable(isReliable:Boolean):void;
		[API("667")]
		public native function get audioSampleAccess():Boolean;
		[API("667")]
		public native function set audioSampleAccess(isAccessible:Boolean):void;
		[API("667")]
		public native function get videoSampleAccess():Boolean;
		[API("667")]
		public native function set videoSampleAccess(isReadable:Boolean):void;
		[API("667")]
		public native function appendBytes(bytes:ByteArray):void;
		[API("667")]
		public native function appendBytesAction(action:String):void;
		public native function get useHardwareDecoder():Boolean;
		public native function set useHardwareDecoder(dec:Boolean):void;
		[API("680")]
		public native function get useJitterBuffer():Boolean;
		[API("680")]
		public native function set useJitterBuffer(jbuf:Boolean):void;
		[API("663")]
		public native function preloadEmbeddedData(param:NetStreamPlayOptions):void;
		[API("674")]
		public native function get videoStreamSettings():VideoStreamSettings;
		[API("674")]
		public native function set videoStreamSettings(settings:VideoStreamSettings):void;
	}
}
