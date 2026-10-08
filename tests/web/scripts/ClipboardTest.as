package {
  import flash.desktop.Clipboard;
  import flash.desktop.ClipboardFormats;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.MouseEvent;
  import flash.events.TextEvent;
  import flash.external.ExternalInterface;
  import flash.system.System;
  import flash.text.TextField;
  import flash.text.TextFieldType;

  // The web test's clipboard SWF: an input field and a sprite, either of
  // which the page focuses through ExternalInterface, logging what each
  // hears of copy, cut and paste; a press on the stage writes the
  // clipboard with System.setClipboard.
  public class ClipboardTest extends Sprite {
    private var field:TextField = new TextField();
    private var log:Array = [];

    public function ClipboardTest() {
      field.type = TextFieldType.INPUT;
      field.width = 140;
      field.height = 20;
      field.border = true;
      addChild(field);
      field.addEventListener(TextEvent.TEXT_INPUT, function (e:TextEvent):void {
        log.push("textInput " + e.text);
      });
      field.addEventListener(Event.CHANGE, function (e:Event):void {
        log.push("change " + field.text);
      });

      var box:Sprite = new Sprite();
      box.graphics.beginFill(0x00ff00);
      box.graphics.drawRect(0, 0, 40, 40);
      box.y = 40;
      addChild(box);
      var c:Clipboard = Clipboard.generalClipboard;
      box.addEventListener(Event.COPY, function (e:Event):void {
        c.clear();
        c.setData(ClipboardFormats.TEXT_FORMAT, "copied by the box");
        log.push("copy");
      });
      box.addEventListener(Event.PASTE, function (e:Event):void {
        log.push("paste " + c.getData(ClipboardFormats.TEXT_FORMAT));
      });
      box.addEventListener(Event.SELECT_ALL, function (e:Event):void {
        log.push("selectAll");
      });

      stage.addEventListener(MouseEvent.MOUSE_DOWN, function (e:MouseEvent):void {
        System.setClipboard("set on a press");
        log.push("press");
      });

      ExternalInterface.addCallback("focusField", function ():void {
        stage.focus = field;
      });
      ExternalInterface.addCallback("focusBox", function ():void {
        stage.focus = box;
      });
      ExternalInterface.addCallback("text", function ():String {
        return field.text;
      });
      ExternalInterface.addCallback("takeLog", function ():Array {
        var taken:Array = log;
        log = [];
        return taken;
      });
    }
  }
}
