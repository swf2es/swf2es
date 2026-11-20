// A SWF 12 document class with a getter of its own named isPlaying, which
// MovieClip has only from a later version (as the corpus's
// avm2/versioned_isplaying): run as the root, at SWF_12 in Flash Player and
// AIR 2.7 in adl, MovieClip's is not seen, so the class's needs no
// override, and it is what a name built from a string finds too. Loaded by
// a root of a later version, as the oracle's harness, the class is refused
// with VerifyError #1053.
package
{
	import flash.display.MovieClip;

	public class Main extends MovieClip
	{
		// Public at run time, as a namespace of URI "" is, though ASC, which
		// checks every builtin name whatever the version, takes it for another.
		namespace pub = "";

		public function Main()
		{
			trace("early bound", pub::isPlaying);
			trace("by name", this["isPlaying"]);
			trace("in", "isPlaying" in this);
			trace("own", hasOwnProperty("isPlaying"));
		}

		pub function get isPlaying():String
		{
			trace("own isPlaying");
			return "own";
		}
	}
}
