package {
  import flash.display.Sprite;
  import flash.display3D.Context3D;
  import flash.events.Event;
  import flash.utils.ByteArray;
  public class AGALValidation extends Sprite {
    public var complete:Boolean = false;
    private var c:Context3D;
    public function AGALValidation() {
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        c = stage.stage3Ds[0].context3D;
        c.enableErrorChecking = true;
        var op:Array = [0,0x030f0000,0xe4000000,0,0,0];
        var oc:Array = [0,0x030f0000,0xe4000000,1,0,0];
        var v0:Array = [0,0x040f0000,0xe4000000,0,0,0];
        test("valid",[op],[oc]);
        test("temp-unwritten",[[0,0x030f0000,0xe4000000,2,0,0]],[oc]);
        test("temp-partial",[[0,0x02010000,0xe4000000,0,0,0],[0,0x030f0000,0xe4000000,2,0,0]],[oc]);
        test("temp-replicate",[[0,0x02010000,0xe4000000,0,0,0],[0,0x030f0000,0,2,0,0]],[oc]);
        test("temp-self",[[0,0x020f0000,0xe4000000,2,0,0],op],[oc]);
        test("vertex-partial",[[0,0x03030000,0xe4000000,0,0,0]],[oc]);
        test("vertex-split",[[0,0x03030000,0xe4000000,0,0,0],[0,0x030c0000,0xe4000000,0,0,0]],[oc]);
        test("fragment-partial",[op],[[0,0x03030000,0xe4000000,1,0,0]]);
        test("fragment-split",[op],[[0,0x03030000,0xe4000000,1,0,0],[0,0x030c0000,0xe4000000,1,0,0]]);
        test("varying-unwritten",[op],[[0,0x030f0000,0xe4000000,4,0,0]]);
        test("varying-partial",[op,[0,0x04010000,0xe4000000,0,0,0]],[[0,0x030f0000,0xe4000000,4,0,0]]);
        test("varying-scalar",[op,[0,0x04010000,0xe4000000,0,0,0]],[[0,0x030f0000,0,4,0,0]]);
        test("varying-unused",[op,[0,0x04010000,0xe4000000,0,0,0]],[oc]);
        test("dot3-partial",[[0,0x02070000,0xe4000000,0,0,0],[0x12,0x030f0000,0xe4000000,2,0xe4000000,0]],[oc]);
        test("dot4-partial",[[0,0x02070000,0xe4000000,0,0,0],[0x13,0x030f0000,0xe4000000,2,0xe4000000,0]],[oc]);
        test("masked-temp-read",[[0,0x02010000,0xe4000000,0,0,0],[0,0x02010001,0xe4000000,2,0,0],op],[oc]);
        test("dot3-replicated",[[0,0x02070000,0xe4000000,0,0,0],[0x12,0x030f0000,0x24000000,2,0xe4000000,0]],[oc]);
        test("dot3-masked",[[0,0x02070000,0xe4000000,0,0,0],[0x12,0x02010001,0xe4000000,2,0xe4000000,0],op],[oc]);
        test("dot3-only-x",[[0,0x02010000,0xe4000000,0,0,0],[0x12,0x02010001,0xe4000000,2,0xe4000000,0],op],[oc]);
        test("masked-fragment-temp",[op],[[0,0x02010000,0xe4000000,1,0,0],[0,0x02010001,0xe4000000,2,0,0],oc]);
        c.dispose(false);
        complete = true;
        trace("agalvalidation complete");
      });
      stage.stage3Ds[0].requestContext3D("auto", "baseline");
    }
    private function bytes(fragment:Boolean, rows:Array):ByteArray {
      var b:ByteArray = new ByteArray();
      b.endian = "littleEndian"; b.writeByte(0xa0); b.writeUnsignedInt(1); b.writeByte(0xa1); b.writeByte(fragment ? 1 : 0);
      for (var i:int = 0; i < rows.length; i++) { for (var j:int = 0; j < 6; j++) { b.writeUnsignedInt(rows[i][j]); } }
      return b;
    }
    private function test(label:String, vertex:Array, fragment:Array):void {
      var p:* = c.createProgram();
      try { p.upload(bytes(false, vertex), bytes(true, fragment)); trace("agalvalidation",label,"accepted"); }
      catch (e:Error) { trace("agalvalidation",label,e.name,e.errorID); }
      p.dispose();
    }
  }
}
