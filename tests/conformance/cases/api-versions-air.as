// avmshell: -api AIR_1_5
// API versioning in AIR's series: avmshell run at AIR 1.5 sees the names
// shell_toplevel marks with an AIR version up to 1.5, and those it marks
// with a Flash Player version moved into AIR's series, as
// AvmCore::newNamespace moves every namespace: FP_10_0 becomes AIR_1_5,
// seen; FP_10_0_32 becomes AIR_1_5_2, not. swf2es runs it at the same
// version (tests/conformance/run.ts), its domain in AIR's series.
import avmplus.*;
import avmshell.*;

function probe(name:String, f:Function):void {
  try { trace(name + " " + f()); } catch (e:Error) { trace(name + " " + e.errorID); }
}

class Sub extends public_class {
  override public function public_function_FP_10_0():Boolean { return false; }
}

probe("apiVersion", function():* { return System.apiVersion; });
probe("public_var", function():* { return public_var; });
probe("public_var_AIR_1_0", function():* { return public_var_AIR_1_0; });
probe("public_var_FP_10_0", function():* { return public_var_FP_10_0; });
probe("public_var_AIR_1_5", function():* { return public_var_AIR_1_5; });
probe("public_var_AIR_1_5_1", function():* { return public_var_AIR_1_5_1; });
probe("public_var_FP_10_0_32", function():* { return public_var_FP_10_0_32; });
probe("public_var_AIR_1_5_2", function():* { return public_var_AIR_1_5_2; });
probe("public_var_AIR_1_0_FP_10_0", function():* { return public_var_AIR_1_0_FP_10_0; });
probe("public_var_AIR_1_5_1_FP_10_0_AIR_1_5_2", function():* { return public_var_AIR_1_5_1_FP_10_0_AIR_1_5_2; });
probe("public_var_FP_10_0_32_AIR_1_0_FP_10_0", function():* { return public_var_FP_10_0_32_AIR_1_0_FP_10_0; });
probe("public_function_FP_10_0_32", function():* { return public_function_FP_10_0_32(); });

var o:public_class = new public_class();
probe("member public_var_FP_10_0", function():* { return o.public_var_FP_10_0; });
probe("member public_var_FP_10_0_32", function():* { return o["public_var_FP_10_0_32"]; });
probe("member public_getset_AIR_1_5", function():* { return o.public_getset_AIR_1_5; });
probe("member public_function_AIR_1_5_2", function():* { return o["public_function_AIR_1_5_2"](); });
probe("override public_function_FP_10_0", function():* { return new Sub().public_function_FP_10_0(); });
probe("class public_class_FP_10_0", function():* { return public_class_FP_10_0; });
probe("class public_class_FP_10_0_32", function():* { return public_class_FP_10_0_32; });
probe("Domain.getClass FP_10_0_32", function():* { return Domain.currentDomain.getClass("avmshell.public_class_FP_10_0_32"); });
probe("JSON", function():* { return JSON.stringify(o).indexOf("FP_10_0_32") < 0; });
