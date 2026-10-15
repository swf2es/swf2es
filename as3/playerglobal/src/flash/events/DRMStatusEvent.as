// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/DRMStatusEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	import flash.net.drm.DRMContentData;
	import flash.net.drm.DRMVoucher;

	[API("661", "667")]
	public class DRMStatusEvent extends Event
	{
		public static const DRM_STATUS:String = "drmStatus";

		private var _contentData:DRMContentData;
		private var _voucher:DRMVoucher;
		private var _isLocal:Boolean;

		public function DRMStatusEvent(type:String = "drmStatus", bubbles:Boolean = false, cancelable:Boolean = false, contentData:DRMContentData = null, voucher:DRMVoucher = null, local:Boolean = false)
		{
			super(type, bubbles, cancelable);

			this._contentData = contentData;
			this._voucher = voucher;
			this._isLocal = local;
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

		[API("663", "667")]
		public function get voucher():DRMVoucher
		{
			return this._voucher;
		}
		[API("663", "667")]
		public function set voucher(value:DRMVoucher):void
		{
			this._voucher = value;
		}

		[API("663", "667")]
		public function get isLocal():Boolean
		{
			return this._isLocal;
		}
		[API("663", "667")]
		public function set isLocal(value:Boolean):void
		{
			this._isLocal = value;
		}

		override public function clone():Event
		{
			return new DRMStatusEvent(type, bubbles, cancelable, this._contentData, this._voucher, this._isLocal);
		}

		override public function toString():String
		{
			return this.formatToString("DRMStatusEvent", "type", "bubbles", "cancelable");
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function get isAvailableOffline():Boolean;
		public native function get isAnonymous():Boolean;
		public native function get voucherEndDate():Date;
		[API("661")]
		public native function get offlineLeasePeriod():uint;
		public native function get policies():Object;
		public native function get detail():String;
	}
}
