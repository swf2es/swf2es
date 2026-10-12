// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/system/LoaderContext.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.system
{
	import flash.display.DisplayObjectContainer;

	public class LoaderContext
	{
		public var allowCodeImport:Boolean;

		public var applicationDomain:ApplicationDomain = null;

		public var checkPolicyFile:Boolean = false;
		[API("671", "674")]
		public var imageDecodingPolicy:String;
		[API("670")]
		public var parameters:Object; // unset by default
		[API("670")]
		public var requestedContentParent:DisplayObjectContainer; // unset by default
		public var securityDomain:SecurityDomain = null;

		public function LoaderContext(
				checkPolicyFile:Boolean = false,
				applicationDomain:ApplicationDomain = null,
				securityDomain:SecurityDomain = null
			)
		{
			this.allowCodeImport = true;
			this.applicationDomain = applicationDomain;
			this.checkPolicyFile = checkPolicyFile;
			// This should be `ImageDecodingPolicy.ON_DEMAND;`, but that's an AIR only class.
			this.imageDecodingPolicy = "onDemand";
			this.securityDomain = securityDomain;
		}

		[API("661")]
		public function get allowLoadBytesCodeExecution():Boolean
		{
			return this.allowCodeImport;
		}

		[API("661")]
		public function set allowLoadBytesCodeExecution(value:Boolean):void
		{
			this.allowCodeImport = value;
		}
	}
}
