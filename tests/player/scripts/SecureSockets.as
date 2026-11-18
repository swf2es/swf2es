package {
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.IOErrorEvent;
    import flash.events.MouseEvent;
    import flash.events.ProgressEvent;
    import flash.events.SecurityErrorEvent;
    import flash.net.SecureSocket;
    import flash.security.X509Certificate;
    import flash.utils.ByteArray;

    public class SecureSockets extends Sprite {
        private var socket:SecureSocket = new SecureSocket();
        private var config:Object;

        public function SecureSockets() {
            config = loaderInfo.parameters;
            trace("supported " + SecureSocket.isSupported);
            trace("initial " + socket.serverCertificateStatus + " " + socket.serverCertificate);
            for each (var invalid:ByteArray in [null, new ByteArray()]) {
                try {
                    socket.addBinaryChainBuildingCertificate(invalid, true);
                    trace("invalid accepted");
                } catch (error:ArgumentError) {
                    trace("invalid " + error.errorID);
                }
            }

            if (config.ca) {
                var bytes:ByteArray = decode(config.ca);
                bytes.position = 3;
                socket.addBinaryChainBuildingCertificate(bytes, config.trusted != "false");
                trace("certificate position " + bytes.position);
                bytes[0] = 0;
            }
            if (config.intermediate) {
                socket.addBinaryChainBuildingCertificate(decode(config.intermediate), false);
            }

            socket.timeout = 2000;
            if (config.air == "true") {
                socket.tcpNoDelay = true;
            }
            socket.endian = "littleEndian";
            socket.addEventListener(Event.CONNECT, connected);
            socket.addEventListener(ProgressEvent.SOCKET_DATA, received);
            socket.addEventListener(IOErrorEvent.IO_ERROR, failed);
            if (config.accept) {
                socket.addEventListener("certificateError", function(event:SecurityErrorEvent):void {
                    trace("certificateError " + event.cancelable + " " + socket.serverCertificateStatus);
                    if (config.accept == "yes") {
                        event.preventDefault();
                    }
                });
            }

            if (config.wait == "true") {
                stage.addEventListener(MouseEvent.CLICK, connectNow);
                trace("ready");
            } else {
                connectNow();
            }
        }

        private function connectNow(event:Event = null):void {
            stage.removeEventListener(MouseEvent.CLICK, connectNow);
            socket.connect(config.host || "localhost", int(config.port));
            trace("opening " + socket.connected + " " + socket.serverCertificateStatus);
        }

        private function decode(hex:String):ByteArray {
            var bytes:ByteArray = new ByteArray();
            for (var i:int = 0; i < hex.length; i += 2) {
                bytes.writeByte(parseInt(hex.substr(i, 2), 16));
            }
            return bytes;
        }

        private function connected(event:Event):void {
            trace("connect " + socket.connected + " " + socket.serverCertificateStatus);
            var certificate:X509Certificate = socket.serverCertificate;
            trace("subject " + certificate.subject.commonName);
            trace("fresh " + (certificate !== socket.serverCertificate) + " " +
                (certificate.subject !== certificate.subject) + " " +
                (certificate.validNotBefore !== certificate.validNotBefore) + " " +
                (certificate.encoded !== certificate.encoded));
            var encoded:ByteArray = certificate.encoded;
            trace("encoded " + (encoded.position == encoded.length) + " " + encoded.endian);
            encoded[0] = 0;
            certificate.validNotBefore.time = 0;
            trace("unchanged " + (certificate.encoded[0] == 48) + " " + (certificate.validNotBefore.time != 0));
            socket.writeInt(0x1020304);
            socket.writeByte(255);
            socket.flush();
        }

        private function received(event:ProgressEvent):void {
            if (socket.bytesAvailable < 5) {
                return;
            }
            trace("data " + socket.readInt() + " " + socket.readUnsignedByte());
            socket.close();
            trace("closed " + socket.connected + " " + socket.serverCertificateStatus + " " + socket.serverCertificate);
            trace("done");
        }

        private function failed(event:IOErrorEvent):void {
            trace("error " + event.errorID + " " + socket.serverCertificateStatus + " " + (socket.serverCertificate != null));
            trace("done");
        }
    }
}
