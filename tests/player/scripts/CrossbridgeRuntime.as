package {
  import flash.concurrent.Condition;
  import flash.concurrent.Mutex;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.profiler.Telemetry;
  import flash.system.ApplicationDomain;
  import flash.system.System;
  import flash.system.Worker;
  import flash.utils.ByteArray;
  import flash.utils.Endian;
  import flash.utils.getDefinitionByName;

  // What Crossbridge's runtime asks of the player as it starts (cases.ts,
  // crossbridgeRuntime): a ByteArray class bound to DefineBinaryData, the
  // domain memory, the primordial worker, mutexes, ByteArray's atomics,
  // Telemetry and disposeXML, and the main SWF's INIT and COMPLETE.
  public class CrossbridgeRuntime extends Sprite {
    private var frames:int = 0;

    public function CrossbridgeRuntime() {
      loaderInfo.addEventListener("open", function(e:Event):void { trace("open"); });
      loaderInfo.addEventListener("init", function(e:Event):void { trace("init", e.target == loaderInfo); });
      loaderInfo.addEventListener("complete", function(e:Event):void { trace("complete", e.target == loaderInfo); });
      addEventListener("enterFrame", function(e:Event):void { trace("enterFrame", ++frames); });
      addEventListener("exitFrame", function(e:Event):void { trace("exitFrame", frames); });

      var Blob:Class = getDefinitionByName("Blob") as Class;
      var blob:ByteArray = new Blob();
      trace("blob", blob.length, blob.position, blob.readUTFBytes(5), blob.readUnsignedByte(), blob.position);
      blob[0] = 0x58;
      var again:ByteArray = new Blob();
      trace("blob again", again.length, again[0], blob[0], blob is ByteArray);

      var domain:ApplicationDomain = ApplicationDomain.currentDomain;
      trace("domain memory", ApplicationDomain.MIN_DOMAIN_MEMORY_LENGTH, domain.domainMemory);
      var short:ByteArray = new ByteArray();
      short.length = 100;
      try { domain.domainMemory = short; trace("short", "set"); } catch (e:Error) { trace("short", e.errorID); }
      var ram:ByteArray = new ByteArray();
      ram.length = 1024;
      ram.endian = Endian.LITTLE_ENDIAN;
      domain.domainMemory = ram;
      ram.position = 8;
      ram.writeInt(-559038737);
      trace("domain", domain.domainMemory == ram, ram.atomicCompareAndSwapIntAt(8, -559038737, 7), ram.atomicCompareAndSwapLength(1024, 2048), ram.length);
      try { ram.atomicCompareAndSwapLength(2048, 100); } catch (e:Error) { trace("shrink", e.errorID); }
      ram.position = 8;
      trace("read back", ram.readInt(), ram.length);
      domain.domainMemory = null;
      trace("cleared", domain.domainMemory);

      var worker:Worker = Worker.current;
      trace("worker", worker == Worker.current, worker.isPrimordial, worker.state);
      trace("shared", worker.getSharedProperty("missing"));
      worker.setSharedProperty("flascc.threadId", 3);
      trace("shared", worker.getSharedProperty("flascc.threadId"));

      var m:Mutex = new Mutex();
      m.lock();
      trace("mutex", m.tryLock());
      m.unlock();
      m.unlock();
      try { m.unlock(); } catch (e:Error) { trace("unlock", e.errorID); }
      var c:Condition = new Condition(m);
      try { c.notify(); } catch (e:Error) { trace("notify", e.errorID); }

      trace("telemetry", Telemetry.connected, Telemetry.spanMarker is Number);
      Telemetry.sendMetric("name", 1);
      Telemetry.sendSpanMetric("span", Telemetry.spanMarker);
      System.disposeXML(new XML("<a><b/></a>"));
      trace("constructed");
    }
  }
}
