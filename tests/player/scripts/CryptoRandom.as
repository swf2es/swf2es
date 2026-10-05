package {
  import flash.crypto.generateRandomBytes;
  import flash.display.Sprite;
  import flash.utils.ByteArray;

  public class CryptoRandom extends Sprite {
    public function CryptoRandom() {
      for each (var length:uint in [1, 16, 1024]) {
        var bytes:ByteArray = generateRandomBytes(length);
        trace("size", length, bytes.length, bytes.position, bytes.bytesAvailable);
      }

      var first:ByteArray = generateRandomBytes(16);
      var second:ByteArray = generateRandomBytes(16);
      trace("distinct", first !== second);

      for each (var invalid:uint in [0, 1025, uint.MAX_VALUE]) {
        try {
          var result:ByteArray = generateRandomBytes(invalid);
          trace("invalid", invalid, result == null ? "null" : "accepted");
        } catch (error:Error) {
          trace("invalid", invalid, error.toString());
        }
      }
    }
  }
}
