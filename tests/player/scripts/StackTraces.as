package
{
	import flash.display.Sprite;

	// Error.getStackTrace in the debugger player: the error as a string,
	// then each method running when it was made, named as Flash names it.
	public class StackTraces extends Sprite
	{
		namespace custom = "http://example.com/custom";

		private static var _made:String = new Error("static").getStackTrace();

		public function StackTraces()
		{
			trace(_made);
			trace(new Error("constructor").getStackTrace());
			method();
			this.value;
			this.value = 1;
			staticMethod();
			this.custom::named();
			privately();
			var anonymous:Function = function():void
			{
				trace(new Error("closure").getStackTrace());
			};
			anonymous();
			new Helper().run();
			var e:Error = new RangeError("renamed", 7);
			e.name = "Other";
			trace(e.getStackTrace());
			try
			{
				thrower();
			}
			catch (caught:Error)
			{
				trace(caught.getStackTrace());
			}

			trace(new SubError().getStackTrace());
			scriptFunction();
		}

		public function method():void
		{
			trace(new Error().getStackTrace());
		}

		public function get value():int
		{
			trace(new Error("getter").getStackTrace());
			return 0;
		}

		public function set value(v:int):void
		{
			trace(new Error("setter").getStackTrace());
		}

		public static function staticMethod():void
		{
			trace(new Error("static method").getStackTrace());
		}

		custom function named():void
		{
			trace(new Error("namespaced").getStackTrace());
		}

		private function privately():void
		{
			trace(new Error("private").getStackTrace());
		}

		private function thrower():void
		{
			null["x"];
		}
	}
}

class Helper
{
	public function run():void
	{
		trace(new Error("file-private class").getStackTrace());
	}
}

class SubError extends Error
{
	public function SubError()
	{
		super("subclass");
	}
}

function scriptFunction():void
{
	trace(new Error("script function").getStackTrace());
}
