// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/accessibility/AccessibilityImplementation.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.accessibility
{
	import flash.geom.Rectangle;

	public class AccessibilityImplementation
	{
		public var errno:uint;
		public var stub:Boolean;

		public function AccessibilityImplementation()
		{
			this.errno = 0;
			this.stub = false;
		}

		public function accDoDefaultAction(childID:uint):void
		{
		}

		public function accLocation(childID:uint):*
		{
			return null;
		}

		public function accSelect(operation:uint, childID:uint):void
		{
		}

		public function get_accDefaultAction(childID:uint):String
		{
			return null;
		}

		public function get_accFocus():uint
		{
			return 0;
		}

		public function get_accName(childID:uint):String
		{
			return null;
		}

		public function get_accRole(childID:uint):uint
		{
			Error.throwError(Error, 2143);
			return 0;
		}

		public function get_accSelection():Array
		{
			return null;
		}

		public function get_accState(childID:uint):uint
		{
			Error.throwError(Error, 2144);
			return 0;
		}

		public function get_accValue(childID:uint):String
		{
			return null;
		}

		public function getChildIDArray():Array
		{
			return null;
		}

		public function isLabeledBy(labelBounds:Rectangle):Boolean
		{
			return false;
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		[API("702")]
		public native function get_selectionAnchorIndex():*;
		[API("702")]
		public native function get_selectionActiveIndex():*;
	}
}
