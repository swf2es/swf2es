// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/drm/DRMDeviceGroup.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net.drm
{

	public final class DRMDeviceGroup
	{
		public function get serverURL():String
		{

			return null;
		}

		public function get authenticationMethod():String
		{

			return null;
		}

		public function get domain():String
		{

			return null;
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function get serverUrl():String;
	}
}
