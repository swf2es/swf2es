package
{
	import flash.display.MovieClip;
	import flash.system.ApplicationDomain;

	public class ReloadChild extends MovieClip
	{
		public static var made:int = 0;
		/** The domain each run of the script found its code in, for the main SWF to look at. */
		public static var scripts:Array = [];
		public static var note:String = noted();

		public function ReloadChild()
		{
			made++;
			var own:ApplicationDomain = loaderInfo.applicationDomain;
			trace("child: made", made);
			trace("child: its loaderInfo's domain has it", own.hasDefinition("ReloadChild"));
			trace("child: that domain's class is its own", own.getDefinition("ReloadChild") == ReloadChild);
			trace("child: its domain's class is its own", ApplicationDomain.currentDomain.getDefinition("ReloadChild") == ReloadChild);
		}

		private static function noted():String
		{
			trace("child: static init");
			return "noted";
		}
	}
}

import flash.system.ApplicationDomain;
import flash.utils.getDefinitionByName;

// The script's own code, which each load of the ABC runs.
var scriptDomain:ApplicationDomain = ApplicationDomain.currentDomain;
trace("script: its domain has the class", scriptDomain.hasDefinition("ReloadChild"));
trace("script: its domain's class is the script's", scriptDomain.getDefinition("ReloadChild") == ReloadChild);
trace("script: found by name is the script's", getDefinitionByName("ReloadChild") == ReloadChild);
trace("script: made before", ReloadChild.made);
ReloadChild.scripts.push(scriptDomain);
