package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.text.TextField;
  import flash.text.TextFieldType;

  // Where a field's selection goes when a script changes its text: each
  // change made with 2 to 4 selected, by the field's type.
  public class TextFieldSelectionMoves extends Sprite {
    public function TextFieldSelectionMoves() {
      // The Flash oracle loads the SWF and adds it to its stage later.
      if (stage) {
        run();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, run);
      }
    }

    private function run(e:Event = null):void {
      changes(new TextField(), "dynamic");
      var unselectable:TextField = new TextField();
      unselectable.selectable = false;
      changes(unselectable, "unselectable");
      // adl moves an input field's selection for text and htmlText too, but
      // Flash Player keeps it (Ruffle's avm2/selection): not traced.
      var input:TextField = new TextField();
      input.type = TextFieldType.INPUT;
      addChild(input);
      stage.focus = input;
      appends(input, "focused input");
    }

    private function appends(field:TextField, label:String):void {
      field.text = "hello world";
      change(field, label + " appendText", function():void { field.appendText(" more"); });
      change(field, label + " replaceText", function():void { field.replaceText(0, 1, "J"); });
    }

    private function changes(field:TextField, label:String):void {
      field.text = "hello world";
      change(field, label + " text longer", function():void { field.text = "hello world again"; });
      change(field, label + " text the same", function():void { field.text = "hello world again"; });
      change(field, label + " htmlText", function():void { field.htmlText = "<b>hello</b> world"; });
      change(field, label + " appendText", function():void { field.appendText(" more"); });
      change(field, label + " replaceText", function():void { field.replaceText(0, 1, "J"); });
      change(field, label + " text shorter", function():void { field.text = "ab"; });
      change(field, label + " text empty", function():void { field.text = ""; });
    }

    private function change(field:TextField, label:String, f:Function):void {
      if (field.length >= 4) {
        field.setSelection(2, 4);
      }

      f();
      trace(label, "[" + field.selectedText + "]", field.selectionBeginIndex,
        field.selectionEndIndex, field.caretIndex);
    }
  }
}
