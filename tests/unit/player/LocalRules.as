package {
import flash.display.Sprite;import flash.net.LocalConnection;import flash.net.registerClassAlias;import flash.events.StatusEvent;import flash.events.AsyncErrorEvent;
import flash.utils.ByteArray;import flash.utils.IExternalizable;import flash.utils.IDataInput;import flash.utils.IDataOutput;
public class LocalRules extends Sprite {
 public function LocalRules() {
  var r:LocalConnection=new LocalConnection();var s:LocalConnection=new LocalConnection();
  r.client={take:function(o:Object):void{trace("copy " + o.x + " " + (o.self==o));},bad:function():void{throw new Error("receiver");},
   modern:function(b:ByteArray,xml:XML):void{trace("modern " + b.readUnsignedByte() + " " + xml.localName());},
   external:function(v:Stored):void{trace("external " + v.n);}};
  r.connect("_rules");
  r.addEventListener(AsyncErrorEvent.ASYNC_ERROR,function(e:AsyncErrorEvent):void{trace("async " + e.error.message);});
  s.addEventListener(StatusEvent.STATUS,function(e:StatusEvent):void{trace("status " + e.level);});
  var o:Object={x:1};o.self=o;s.send("_rules","take",o);o.x=2;
  s.send("_rules","bad");s.send("_missing","take");
  try {s.send("_rules","take",new Array(50001).join("x"));}catch(e:Error){trace("size " + e.errorID);}
  try {s.isPerUser=true;}catch(e:Error){trace("locked " + e.errorID);}
  var bytes:ByteArray=new ByteArray();bytes.writeByte(42);s.send("_rules","modern",bytes,new XML("<root/>"));bytes[0]=43;
  registerClassAlias("swf2es.Stored",Stored);s.send("_rules","external",new Stored());try{Stored.saved.writeInt(99);}catch(expired:Error){}
  s.send("_rules","take",{x:3});
 }
}
class Stored implements IExternalizable {
 public static var saved:IDataOutput;public var n:int=7;
 public function writeExternal(output:IDataOutput):void{saved=output;output.writeInt(n);}
 public function readExternal(input:IDataInput):void{n=input.readInt();}
}
}
