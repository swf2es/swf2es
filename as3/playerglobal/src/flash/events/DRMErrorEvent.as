// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/DRMErrorEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	import flash.net.drm.DRMContentData;

	[API("661", "667")]
	public class DRMErrorEvent extends ErrorEvent
	{
		public static const DRM_ERROR:String = "drmError";
		public static const DRM_LOAD_DEVICEID_ERROR:String = "drmLoadDeviceIdError";

		private var _subErrorID:int;
		private var _contentData:DRMContentData;
		private var _systemUpdateNeeded:Boolean;
		private var _drmUpdateNeeded:Boolean;

		public function DRMErrorEvent(type:String = "drmError", bubbles:Boolean = false, cancelable:Boolean = false, errorDetail:String = "", errorCode:int = 0, subErrorID:int = 0, contentData:DRMContentData = null, systemUpdateNeeded:Boolean = false, drmUpdateNeeded:Boolean = false)
		{
			super(type, bubbles, cancelable, errorDetail, errorCode);

			this._subErrorID = subErrorID;
			this._contentData = contentData;
			this._systemUpdateNeeded = systemUpdateNeeded;
			this._drmUpdateNeeded = drmUpdateNeeded;
		}

		public function get subErrorID():int
		{
			return this._subErrorID;
		}

		[API("663", "667")]
		public function get contentData():DRMContentData
		{
			return this._contentData;
		}
		[API("663", "667")]
		public function set contentData(value:DRMContentData):void
		{
			this._contentData = value;
		}

		[API("667")]
		public function get systemUpdateNeeded():Boolean
		{
			return this._systemUpdateNeeded;
		}

		[API("667")]
		public function get drmUpdateNeeded():Boolean
		{
			return this._drmUpdateNeeded;
		}

		override public function clone():Event
		{
			return new DRMErrorEvent(type, bubbles, cancelable, text, errorID, this.subErrorID, this._contentData, this._systemUpdateNeeded, this._drmUpdateNeeded);
		}

		override public function toString():String
		{
			return this.formatToString("DRMErrorEvent", "type", "bubbles", "cancelable", "eventPhase", "errorID", "subErrorID", "text", "systemUpdateNeeded", "drmUpdateNeeded");
		}
	}
}
