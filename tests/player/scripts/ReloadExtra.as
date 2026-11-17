package
{
	import flash.display.MovieClip;
	import flash.system.ApplicationDomain;

	public class ReloadExtra extends MovieClip
	{
		public function ReloadExtra()
		{
			var d:ApplicationDomain = ApplicationDomain.currentDomain;
			trace("extra: its domain has the child", d.hasDefinition("ReloadChild"));
			trace("extra: its domain has itself", d.hasDefinition("ReloadExtra"));
			trace("extra: the child made", Object(d.getDefinition("ReloadChild")).made);
		}
	}
}
