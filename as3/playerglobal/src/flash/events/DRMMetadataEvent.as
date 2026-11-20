// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	import flash.net.drm.DRMContentData;
	import flash.utils.ByteArray;

	public class DRMMetadataEvent extends Event
	{
		public static const DRM_METADATA:String = "drmMetadata";

		private var _drmMetadata:DRMContentData;
		private var _timestamp:Number;

		public function DRMMetadataEvent(type:String = "drmMetadata", bubbles:Boolean = false, cancelable:Boolean = false, metadata:ByteArray = null, timestamp:Number = 0)
		{
			super(type, bubbles, cancelable);
			_drmMetadata = new DRMContentData(metadata);
			_timestamp = timestamp;
		}

		public function get drmMetadata():DRMContentData
		{
			return _drmMetadata;
		}

		public function get timestamp():Number
		{
			return _timestamp;
		}
	}
}
