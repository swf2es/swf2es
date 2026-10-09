// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	[API("686")]
	public final class ApplicationInstallerMode
	{
		public function ApplicationInstallerMode()
		{
		}

		public static const INSTALL_ONLY:String = "install_only";
		public static const SHORTCUTS_ONLY:String = "shortcuts_only";
		public static const INSTALL_WITH_SHORTCUTS:String = "install_with_shortcuts";
	}
}
