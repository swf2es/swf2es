// Camera and Microphone on a machine without a camera, as the player is:
// supported, no camera to get, and ones made with `new` that read as zeros
// whatever is set. The microphones the reference's machine has are left
// out (names, getMicrophone() and getEnhancedMicrophone() of the default),
// as are setCursor, which AIR, where the reference is drawn, does not have,
// and position, which only AIR has.
package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.geom.Rectangle;
  import flash.media.Camera;
  import flash.media.Microphone;
  import flash.media.MicrophoneEnhancedMode;
  import flash.media.MicrophoneEnhancedOptions;
  import flash.media.SoundCodec;
  import flash.media.SoundTransform;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;

  public class CameraMicrophone extends Sprite {
    public function CameraMicrophone() {
      t("Camera.isSupported", function():* { return Camera.isSupported; });
      t("Camera.names", function():* { var n:Array = Camera.names; return n.length + " new " + (n != Camera.names); });
      t("getCamera()", function():* { return Camera.getCamera(); });
      t("getCamera('0')", function():* { return Camera.getCamera("0"); });
      t("getCamera(null)", function():* { return Camera.getCamera(null); });
      t("new Camera", function():* { var c:Camera = new Camera(); return c + " " + cam(c); });
      t("name", function():* { return new Camera().name === null; });
      t("setMode", function():* { var c:Camera = new Camera(); c.setMode(640, 480, 30, false); return cam(c); });
      t("setQuality", function():* { var c:Camera = new Camera(); c.setQuality(16384, 80); return cam(c); });
      t("setMotionLevel", function():* { var c:Camera = new Camera(); c.setMotionLevel(40, 500); return cam(c); });
      t("setKeyFrameInterval", function():* { var c:Camera = new Camera(); c.setKeyFrameInterval(30); return cam(c); });
      t("setLoopback", function():* { var c:Camera = new Camera(); c.setLoopback(true); return cam(c); });
      t("drawToBitmapData", function():* { var b:BitmapData = new BitmapData(4, 4, false, 0x123456); new Camera().drawToBitmapData(b); return b.getPixel(0, 0).toString(16); });
      t("drawToBitmapData(null)", function():* { new Camera().drawToBitmapData(null); });
      t("copyToByteArray", function():* { var ba:ByteArray = new ByteArray(); new Camera().copyToByteArray(new Rectangle(0, 0, 2, 2), ba); return ba.length; });
      t("copyToByteArray(null, ba)", function():* { new Camera().copyToByteArray(null, new ByteArray()); });
      t("copyToByteArray(rect, null)", function():* { new Camera().copyToByteArray(new Rectangle(0, 0, 2, 2), null); });
      t("copyToVector", function():* { var v:Vector.<uint> = new Vector.<uint>(); new Camera().copyToVector(new Rectangle(0, 0, 2, 2), v); return v.length; });
      t("copyToVector(null, null)", function():* { new Camera().copyToVector(null, null); });
      t("copyToVector(rect, null)", function():* { new Camera().copyToVector(new Rectangle(0, 0, 2, 2), null); });

      t("Microphone.isSupported", function():* { return Microphone.isSupported; });
      t("getMicrophone(99)", function():* { return Microphone.getMicrophone(99); });
      t("getMicrophone(-5)", function():* { return Microphone.getMicrophone(-5); });
      t("new Microphone", function():* { var m:Microphone = new Microphone(); return m + " " + mic(m); });
      t("name, codec", function():* { var m:Microphone = new Microphone(); return (m.name === null) + " " + (m.codec === null); });
      t("set all", function():* {
        var m:Microphone = new Microphone();
        m.gain = 75;
        m.rate = 44;
        m.codec = SoundCodec.SPEEX;
        m.encodeQuality = 8;
        m.framesPerPacket = 4;
        m.noiseSuppressionLevel = -20;
        m.enableVAD = true;
        m.setSilenceLevel(30, 5000);
        m.setUseEchoSuppression(true);
        m.setLoopBack();
        return mic(m);
      });
      t("codec = null", function():* { new Microphone().codec = null; });
      t("soundTransform", function():* { var m:Microphone = new Microphone(); var s:SoundTransform = m.soundTransform; return s.volume + " " + s.pan + " new " + (s != m.soundTransform); });
      t("soundTransform set", function():* { var m:Microphone = new Microphone(); m.soundTransform = new SoundTransform(0.5, -1); return m.soundTransform.volume + " " + m.soundTransform.pan; });
      t("soundTransform = null", function():* { new Microphone().soundTransform = null; });
      t("enhancedOptions", function():* { var m:Microphone = new Microphone(); m.enhancedOptions = headset(); return m.enhancedOptions; });

      // Once getEnhancedMicrophone is called, every Microphone shares one set of options.
      t("getEnhancedMicrophone(99)", function():* { return Microphone.getEnhancedMicrophone(99); });
      t("enhancedOptions now", function():* { var m:Microphone = new Microphone(); return options(m.enhancedOptions) + " new " + (m.enhancedOptions != m.enhancedOptions); });
      t("enhancedOptions shared", function():* { new Microphone().enhancedOptions = headset(); return options(new Microphone().enhancedOptions); });
      t("enhancedOptions = null", function():* { var m:Microphone = new Microphone(); m.enhancedOptions = null; return options(m.enhancedOptions); });
      t("enhancedOptions copied", function():* { var o:MicrophoneEnhancedOptions = new Microphone().enhancedOptions; o.mode = MicrophoneEnhancedMode.OFF; return options(new Microphone().enhancedOptions); });

      t("new MicrophoneEnhancedOptions", function():* { var o:MicrophoneEnhancedOptions = new MicrophoneEnhancedOptions(); return o + " " + options(o); });
      t("options set", function():* {
        var o:MicrophoneEnhancedOptions = new MicrophoneEnhancedOptions();
        o.mode = MicrophoneEnhancedMode.HEADSET;
        o.echoPath = 256;
        o.nonLinearProcessing = false;
        o.isVoiceDetected = 3;
        o.autoGain = true;
        return options(o);
      });
      t("options set badly", function():* {
        var o:MicrophoneEnhancedOptions = new MicrophoneEnhancedOptions();
        o.mode = MicrophoneEnhancedMode.HALF_DUPLEX;
        o.mode = "HALFDUPLEX";
        o.mode = null;
        o.echoPath = 256;
        o.echoPath = 129;
        return options(o);
      });
    }

    private function headset():MicrophoneEnhancedOptions {
      var o:MicrophoneEnhancedOptions = new MicrophoneEnhancedOptions();
      o.mode = MicrophoneEnhancedMode.HEADSET;
      o.echoPath = 256;
      o.nonLinearProcessing = false;
      o.isVoiceDetected = 1;
      o.autoGain = true;
      return o;
    }

    private function cam(c:Camera):String {
      return [c.activityLevel, c.bandwidth, c.currentFPS, c.fps, c.width, c.height, c.index, c.keyFrameInterval, c.loopback, c.motionLevel, c.motionTimeout, c.muted, c.quality].join(" ");
    }

    private function mic(m:Microphone):String {
      return [m.activityLevel, m.gain, m.rate, m.index, m.muted, m.encodeQuality, m.framesPerPacket, m.noiseSuppressionLevel, m.enableVAD, m.silenceLevel, m.silenceTimeout, m.useEchoSuppression].join(" ");
    }

    private function options(o:MicrophoneEnhancedOptions):String {
      return [o.mode, o.autoGain, o.echoPath, o.nonLinearProcessing, o.isVoiceDetected].join(" ");
    }

    private function t(name:String, f:Function):void {
      try {
        var v:* = f();
        trace(name + ": " + v + " (" + getQualifiedClassName(v) + ")");
      } catch (e:Error) {
        trace(name + " threw " + e.errorID + " " + e);
      }
    }
  }
}
