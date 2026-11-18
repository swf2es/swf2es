package
{
	import flash.display.*;
	import flash.text.*;

	public class TextAdvancedEmptyEdges extends Sprite
	{
		public function TextAdvancedEmptyEdges()
		{
			// Corner's contours start and end with an edge of no length, which
			// is no edge: nothing is drawn past the corners they start at.
			var field:TextField = new TextField();
			field.embedFonts = true;
			field.antiAliasType = AntiAliasType.ADVANCED;
			field.gridFitType = GridFitType.NONE;
			field.defaultTextFormat = new TextFormat("Corner", 32, 0);
			field.autoSize = TextFieldAutoSize.LEFT;
			field.text = "hlhl hlh";
			field.x = 10;
			field.y = 10;
			addChild(field);
			trace("edges", field.textWidth);
		}
	}
}
