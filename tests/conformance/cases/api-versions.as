// API versioning: avmshell (SWF_31, Flash Player's series) sees names that
// shell_toplevel marks with a Flash Player version, and not the AIR-only ones.
// swf2es' domain must agree (tests/unit/codegen/domain.test.ts).
import avmshell.*;
function probe(name:String, f:Function):void {
  try { f(); trace(name + " ok"); } catch (e:Error) { trace(name + " " + e.errorID); }
}
probe("public_var", function():* { return public_var; });
probe("public_var_AIR_1_0", function():* { return public_var_AIR_1_0; });
probe("public_var_FP_10_0", function():* { return public_var_FP_10_0; });
probe("public_var_AIR_1_5", function():* { return public_var_AIR_1_5; });
probe("public_var_FP_10_0_32", function():* { return public_var_FP_10_0_32; });
probe("public_var_AIR_1_0_FP_10_0", function():* { return public_var_AIR_1_0_FP_10_0; });
probe("public_var_AIR_1_5_1_FP_10_0_AIR_1_5_2", function():* { return public_var_AIR_1_5_1_FP_10_0_AIR_1_5_2; });
probe("public_var_FP_10_0_32_AIR_1_0_FP_10_0", function():* { return public_var_FP_10_0_32_AIR_1_0_FP_10_0; });
