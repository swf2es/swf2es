// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/system/JPEGLoaderContext.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.system
{
	// Both the docs and playerglobal.swc says this is "663", but it's actually available in regular Flash Player
	[API("662", "663")]
	public class JPEGLoaderContext extends LoaderContext
	{
		public var deblockingFilter:Number = 0.0;

		public function JPEGLoaderContext(
				deblockingFilter:Number = 0.0,
				checkPolicyFile:Boolean = false,
				applicationDomain:ApplicationDomain = null,
				securityDomain:SecurityDomain = null
			)
		{
			super(checkPolicyFile, applicationDomain, securityDomain);
			this.deblockingFilter = deblockingFilter;
		}
	}
}
