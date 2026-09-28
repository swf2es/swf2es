// Error messages as the release player and avmshell give them: the error's
// number only, whether the runtime throws it or AS3 does with throwError.
import avmplus.System;
var o:Object = null;
try { o.x; } catch (e:Error) { trace("[" + e.message + "]", e.errorID); trace(e); }
try { Error.throwError(TypeError, 1034, "a", "B"); } catch (e:Error) { trace("[" + e.message + "]"); }
try { undefinedName; } catch (e:ReferenceError) { trace(e); }
trace("debugger", System.isDebugger());
