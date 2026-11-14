// A SWF whose document class's constructor throws (scripts/UncaughtErrors.as.template).
package
{
	import flash.display.MovieClip;

	public class UncaughtErrorsBad extends MovieClip
	{
		public function UncaughtErrorsBad()
		{
			trace("the bad child's constructor runs");
			throw new Error("the bad child's constructor");
		}
	}
}
