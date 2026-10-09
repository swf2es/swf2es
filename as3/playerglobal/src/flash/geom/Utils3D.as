// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/geom/Utils3D.ts.

package flash.geom {
    [API("662")]
    public class Utils3D {
        public function Utils3D() {
        }

        public static native function projectVector(m:Matrix3D, v:Vector3D):Vector3D;
        public static native function projectVectors(m:Matrix3D, verts:Vector.<Number>, projectedVerts:Vector.<Number>, uvts:Vector.<Number>):void;
        public static native function pointTowards(arg0:Number, arg1:Matrix3D, arg2:Vector3D, arg3:Vector3D = null, arg4:Vector3D = null):Matrix3D;
    }
}
