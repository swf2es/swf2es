// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/drm/DRMContentData.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net.drm
{

	import flash.utils.ByteArray;

	public class DRMContentData
	{
		public function DRMContentData(rawData:ByteArray = null)
		{
			super();
		}

		public function get serverURL():String
		{

			return null;
		}

		public function get authenticationMethod():String
		{

			return null;
		}

		public function get licenseID():String
		{

			return null;
		}

		public function get domain():String
		{

			return null;
		}

		[API("662", "668")]
		public function getVoucherAccessInfo():Vector.<VoucherAccessInfo>
		{

			return null;
		}
	}
}
