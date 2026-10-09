// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts); natives in Matrix3D.ts.

package flash.geom {
    [API("662")]
    public class Matrix3D {
        public function Matrix3D(v:Vector.<Number> = null) {
            ctor(v);
        }

        // The player's native constructor (Matrix3D.ts).
        private native function ctor(v:Vector.<Number>):void;

        public static native function interpolate(fromMat:Matrix3D, toMat:Matrix3D, percent:Number):Matrix3D;
        public native function clone():Matrix3D;
        public native function copyToMatrix3D(dest:Matrix3D):void;
        public native function get rawData():Vector.<Number>;
        public native function set rawData(value:Vector.<Number>):void;
        public native function append(lhs:Matrix3D):void;
        public native function prepend(rhs:Matrix3D):void;
        public native function invert():Boolean;
        public native function identity():void;
        public native function decompose(orientationStyle:String = "eulerAngles"):Vector.<Vector3D>;
        public native function recompose(components:Vector.<Vector3D>, orientationStyle:String = "eulerAngles"):Boolean;
        public native function get position():Vector3D;
        public native function set position(val:Vector3D):void;
        public native function appendTranslation(x:Number, y:Number, z:Number):void;
        public native function appendRotation(degrees:Number, axis:Vector3D, pivotPoint:Vector3D = null):void;
        public native function appendScale(xScale:Number, yScale:Number, zScale:Number):void;
        public native function prependTranslation(x:Number, y:Number, z:Number):void;
        public native function prependRotation(degrees:Number, axis:Vector3D, pivotPoint:Vector3D = null):void;
        public native function prependScale(xScale:Number, yScale:Number, zScale:Number):void;
        public native function transformVector(vector:Vector3D):Vector3D;
        public native function deltaTransformVector(vector:Vector3D):Vector3D;
        public native function transformVectors(vin:Vector.<Number>, vout:Vector.<Number>):void;
        public native function get determinant():Number;
        public native function transpose():void;
        public native function pointAt(pos:Vector3D, at:Vector3D = null, up:Vector3D = null):void;
        public native function interpolateTo(toMat:Matrix3D, percent:Number):void;
        [API("674")]
        public native function copyFrom(source:Matrix3D):void;
        [API("674")]
        public native function copyRawDataTo(dest:Vector.<Number>, index:uint = 0, transpose:Boolean = false):void;
        [API("674")]
        public native function copyRawDataFrom(source:Vector.<Number>, index:uint = 0, transpose:Boolean = false):void;
        [API("674")]
        public native function copyRowTo(row:uint, vector3D:Vector3D):void;
        [API("674")]
        public native function copyColumnTo(column:uint, vector3D:Vector3D):void;
        [API("674")]
        public native function copyRowFrom(row:uint, vector3D:Vector3D):void;
        [API("674")]
        public native function copyColumnFrom(column:uint, vector3D:Vector3D):void;
    }
}
