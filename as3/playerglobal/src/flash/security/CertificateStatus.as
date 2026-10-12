// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/security/CertificateStatus.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.security
{
	[API("668", "672")]
	public final class CertificateStatus
	{
		public static const EXPIRED:String = "expired";
		public static const INVALID:String = "invalid";
		public static const INVALID_CHAIN:String = "invalidChain";
		public static const NOT_YET_VALID:String = "notYetValid";
		public static const PRINCIPAL_MISMATCH:String = "principalMismatch";
		public static const REVOKED:String = "revoked";
		public static const TRUSTED:String = "trusted";
		public static const UNKNOWN:String = "unknown";
		public static const UNTRUSTED_SIGNERS:String = "untrustedSigners";
	}
}
