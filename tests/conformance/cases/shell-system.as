// avmshell's System natives that report on the VM: the features of the
// 32-bit oracle, which object is a global, and the collector's no-ops.
import avmplus.System;
import flash.utils.ByteArray;
var features:String = System.getFeatures();
trace(features.indexOf("AVMSYSTEM_32BIT;") >= 0, features.indexOf("AVMFEATURE_SWF18;") >= 0);
trace(System.isGlobal(this), System.isGlobal({}), System.isGlobal(null), System.isGlobal(1));
trace(System.canonicalizeNumber(1.5), System.canonicalizeNumber(-0) === 0, System.canonicalizeNumber("s"));
System.forceFullCollection();
System.queueCollection();
System.pauseForGCIfCollectionImminent(0.5);
// A ByteArray past 32-bit avmshell's limit fails before allocating.
try {
  new ByteArray().length = 0xFFFFF000;
  trace("grew");
} catch (e:Error) {
  trace(e, e.errorID);
}
// The memory System reports, which differs from run to run in avmshell.
trace(System.totalMemory > 0, System.freeMemory >= 0, System.freeMemory <= System.totalMemory);
trace(System.privateMemory > 0);
// exec runs nothing without a command.
try {
  System.exec(null);
} catch (e:Error) {
  trace(e, e.errorID);
}
