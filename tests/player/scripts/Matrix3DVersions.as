package {
  import flash.display.Sprite;
  import flash.geom.Matrix3D;
  import flash.geom.Vector3D;

  // What Matrix3D did before SWF 13: a determinant of the other sign, and
  // a rotation about an axis that is not a unit one taken as it came.
  public class Matrix3DVersions extends Sprite {
    public function Matrix3DVersions() {
      var m:Matrix3D = new Matrix3D();
      m.appendScale(2, 3, 4);
      trace("scale", m.determinant);
      m.appendRotation(90, Vector3D.Z_AXIS);
      trace("turned", m.determinant);
      var n:Matrix3D = new Matrix3D();
      n.appendRotation(30, new Vector3D(1, 2, 3), new Vector3D(4, 5, 6));
      trace("long axis", n.rawData);
      n = new Matrix3D();
      n.prependRotation(30, new Vector3D(0, 0, 2));
      trace("prepended", n.rawData);
      trace("inverted", n.invert(), n.rawData);
    }
  }
}
