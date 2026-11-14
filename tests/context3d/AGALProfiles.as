package
{
	import flash.display.Sprite;
	import flash.display.Stage3D;
	import flash.display3D.Context3D;
	import flash.events.ErrorEvent;
	import flash.events.Event;
	import flash.utils.ByteArray;

	// Which AGAL versions each profile takes, and what each version allows there:
	// registers, opcodes, sampler flags and program lengths.
	public class AGALProfiles extends Sprite
	{
		public var complete:Boolean = false;
		private static const VERBOSE:Boolean = false;
		private var profiles:Array = ["baselineConstrained", "baseline", "baselineExtended",
				"standardConstrained", "standard", "standardExtended"];
		private var index:int = 0;
		private var c:Context3D;
		private var label:String;

		private static const VOP:Array = [0, 0x030f0000, 0xe4000000, 0, 0, 0];
		private static const FOC:Array = [0, 0x030f0000, 0xe4000000, 1, 0, 0];
		private static const FT0:Array = [0, 0x030f0000, 0xe4000000, 2, 0, 0];
		private static const EIF:Array = [0x21, 0, 0, 0, 0, 0];
		private static const ELS:Array = [0x20, 0, 0, 0, 0, 0];

		public function AGALProfiles()
		{
			next();
		}

		private function next():void
		{
			if (index >= profiles.length)
			{
				complete = true;
				trace("agalprofiles complete");
				return;
			}

			var slot:Stage3D = stage.stage3Ds[0];
			var profile:String = profiles[index++];
			var created:Function = function(event:Event):void
			{
				slot.removeEventListener(Event.CONTEXT3D_CREATE, created);
				slot.removeEventListener(ErrorEvent.ERROR, failed);
				c = slot.context3D;
				c.enableErrorChecking = true;
				for (var version:int = 0; version <= 4; version++)
				{
					label = "agalprofiles " + profile + " v" + version;
					if (test(version, "trivial", [VOP], [FOC]) && version > 0)
					{
						cases(version);
					}
				}
				c.dispose(false);
				next();
			};
			var failed:Function = function(event:ErrorEvent):void
			{
				slot.removeEventListener(Event.CONTEXT3D_CREATE, created);
				slot.removeEventListener(ErrorEvent.ERROR, failed);
				trace("agalprofiles", profile, "error", event.errorID);
				next();
			};
			slot.addEventListener(Event.CONTEXT3D_CREATE, created);
			slot.addEventListener(ErrorEvent.ERROR, failed);
			slot.requestContext3D("auto", profile);
		}

		private function bytes(version:int, fragment:Boolean, rows:Array):ByteArray
		{
			var b:ByteArray = new ByteArray();
			b.endian = "littleEndian";
			b.writeByte(0xa0);
			b.writeUnsignedInt(version);
			b.writeByte(0xa1);
			b.writeByte(fragment ? 1 : 0);
			for (var i:int = 0; i < rows.length; i++)
			{
				for (var j:int = 0; j < 6; j++)
				{
					b.writeUnsignedInt(rows[i][j]);
				}
			}
			return b;
		}

		private function test(version:int, name:String, vertex:Array, fragment:Array):Boolean
		{
			var p:* = c.createProgram();
			var accepted:Boolean = false;
			try
			{
				p.upload(bytes(version, false, vertex), bytes(version, true, fragment));
				trace(label, name, "accepted");
				accepted = true;
			}
			catch (e:Error)
			{
				trace(label, name, e.name, e.errorID);
				if (VERBOSE)
				{
					trace("message", e.message);
				}
			}
			p.dispose();
			return accepted;
		}

		private function repeat(row:Array, count:int):Array
		{
			var rows:Array = [];
			for (var i:int = 0; i < count; i++)
			{
				rows.push(row);
			}
			return rows;
		}

		private function cases(v:int):void
		{
			var n:int;
			for each (n in [7, 8, 15, 16])
			{
				test(v, "va" + n, [[0, 0x030f0000, 0xe4000000 | n, 0, 0, 0]], [FOC]);
			}
			for each (n in [127, 128, 249, 250])
			{
				test(v, "vc" + n, [[0, 0x030f0000, 0xe4000000 | n, 1, 0, 0]], [FOC]);
			}
			for each (n in [7, 8, 25, 26])
			{
				test(v, "vt" + n, [[0, 0x020f0000 | n, 0xe4000000, 0, 0, 0], [0, 0x030f0000, 0xe4000000 | n, 2, 0, 0]], [FOC]);
			}
			for each (n in [7, 8, 9, 10])
			{
				test(v, "v" + n, [VOP, [0, 0x040f0000 | n, 0xe4000000, 0, 0, 0]], [[0, 0x030f0000, 0xe4000000 | n, 4, 0, 0]]);
			}
			for each (n in [27, 28, 63, 64, 199, 200])
			{
				test(v, "fc" + n, [VOP], [[0, 0x030f0000, 0xe4000000 | n, 1, 0, 0]]);
			}
			for each (n in [7, 8, 25, 26])
			{
				test(v, "ft" + n, [VOP], [[0, 0x020f0000 | n, 0xe4000000, 1, 0, 0], [0, 0x030f0000, 0xe4000000 | n, 2, 0, 0]]);
			}
			for each (n in [7, 8, 15, 16])
			{
				test(v, "fs" + n, [VOP], [[0x28, 0x020f0000, 0xe4000000, 1, n, 5], FT0]);
			}
			for each (n in [1, 3, 4])
			{
				test(v, "oc" + n, [VOP], [FOC, [0, 0x030f0000 | n, 0xe4000000, 1, 0, 0]]);
			}
			test(v, "oc1-alone", [VOP], [[0, 0x030f0001, 0xe4000000, 1, 0, 0]]);
			test(v, "oc1-partial", [VOP], [FOC, [0, 0x03030001, 0xe4000000, 1, 0, 0]]);
			test(v, "oc0-partial", [VOP], [[0, 0x03030000, 0xe4000000, 1, 0, 0]]);
			test(v, "od-x", [VOP], [FOC, [0, 0x06010000, 0xe4000000, 1, 0, 0]]);
			test(v, "od-xyzw", [VOP], [FOC, [0, 0x060f0000, 0xe4000000, 1, 0, 0]]);
			test(v, "od-y", [VOP], [FOC, [0, 0x06020000, 0xe4000000, 1, 0, 0]]);
			test(v, "od1", [VOP], [FOC, [0, 0x06010001, 0xe4000000, 1, 0, 0]]);
			test(v, "od-read", [VOP], [[0, 0x06010000, 0xe4000000, 1, 0, 0], [0, 0x030f0000, 0xe4000000, 6, 0, 0]]);
			test(v, "od-vertex", [VOP, [0, 0x06010000, 0xe4000000, 0, 0, 0]], [FOC]);
			test(v, "iid", [[0, 0x020f0000, 0xe4000000, 0, 0, 0], [1, 0x020f0000, 0xe4000000, 2, 0, 7], [0, 0x030f0000, 0xe4000000, 2, 0, 0]], [FOC]);
			test(v, "iid-fragment", [VOP], [[1, 0x030f0000, 0xe4000000, 1, 0, 7]]);

			test(v, "ddx", [VOP], [[0x1a, 0x020f0000, 0xe4000000, 1, 0, 0], FT0]);
			test(v, "ddy", [VOP], [[0x1b, 0x020f0000, 0xe4000000, 1, 0, 0], FT0]);
			test(v, "ddx-vertex", [[0x1a, 0x030f0000, 0xe4000000, 0, 0, 0]], [FOC]);
			var mov1:Array = [0, 0x020f0000, 0xe4000001, 1, 0, 0];
			var mov2:Array = [0, 0x020f0000, 0xe4000002, 1, 0, 0];
			var start:Array = [0, 0x020f0000, 0xe4000000, 1, 0, 0];
			for each (n in [0x1c, 0x1d, 0x1e, 0x1f])
			{
				var cond:Array = [n, 0, 0x00000000, 1, 0x55000000, 1];
				test(v, "if" + n.toString(16), [VOP], [start, cond, mov1, ELS, mov2, EIF, FT0]);
			}
			var ife:Array = [0x1c, 0, 0x00000000, 1, 0x55000000, 1];
			test(v, "if-no-else", [VOP], [start, ife, mov1, EIF, FT0]);
			test(v, "if-unclosed", [VOP], [start, ife, mov1, FT0]);
			test(v, "eif-alone", [VOP], [start, EIF, FT0]);
			test(v, "els-alone", [VOP], [start, ELS, FT0]);
			test(v, "els-twice", [VOP], [start, ife, mov1, ELS, mov2, ELS, mov1, EIF, FT0]);
			test(v, "if-empty", [VOP], [start, ife, EIF, FT0]);
			test(v, "if-vector", [VOP], [start, [0x1c, 0, 0xe4000000, 1, 0xe4000000, 1], mov1, EIF, FT0]);
			test(v, "if-dest", [VOP], [start, [0x1c, 0x020f0000, 0, 1, 0x55000000, 1], mov1, EIF, FT0]);
			test(v, "if-temp-unwritten", [VOP], [start, [0x1c, 0, 0, 2, 0x55000000, 2], mov1, EIF, FT0]);
			test(v, "if-output-inside", [VOP], [ife, FOC, EIF]);
			test(v, "if-temp-inside", [VOP], [ife, mov1, EIF, FT0]);
			test(v, "if-temp-both", [VOP], [ife, mov1, ELS, mov2, EIF, FT0]);
			test(v, "if-kil", [VOP], [start, ife, [0x27, 0, 0, 2, 0, 0], EIF, FT0]);
			test(v, "if-tex", [VOP], [start, ife, [0x28, 0x020f0000, 0xe4000000, 1, 0, 5], EIF, FT0]);
			for each (n in [4, 5])
			{
				var nested:Array = [start];
				for (var i:int = 0; i < n; i++)
				{
					nested.push(ife);
				}
				nested.push(mov1);
				for (i = 0; i < n; i++)
				{
					nested.push(EIF);
				}
				nested.push(FT0);
				test(v, "if-depth" + n, [VOP], nested);
			}

			test(v, "sgn", [[0x2b, 0x030f0000, 0xe4000000, 0, 0, 0]], [FOC]);
			test(v, "sne", [[0x2d, 0x030f0000, 0xe4000000, 0, 0xe4000000, 1]], [FOC]);
			test(v, "ted", [VOP], [[0x26, 0x020f0000, 0xe4000000, 1, 0, 5], FT0]);
			test(v, "tld", [[0x2e, 0x030f0000, 0xe4000000, 0, 0, 5]], [FOC]);
			test(v, "op22", [[0x22, 0x030f0000, 0xe4000000, 0, 0, 0]], [FOC]);
			test(v, "op2f", [[0x2f, 0x030f0000, 0xe4000000, 0, 0, 0]], [FOC]);

			var flags:Array = [["linear", 0x10000005], ["anisotropic16x", 0x50000005], ["repeat", 0x00100005],
					["clamp-u-repeat-v", 0x00200005], ["repeat-u-clamp-v", 0x00300005], ["3d", 0x00002005],
					["video", 0x00000305], ["centroid", 0x00010005], ["single", 0x00020005],
					["ignoresampler", 0x00040005], ["special8", 0x00080005], ["miplinear", 0x02000005],
					["mip3", 0x03000005], ["filter6", 0x60000005], ["format4", 0x00000405]];
			for each (var flag:Array in flags)
			{
				test(v, "sampler-" + flag[0], [VOP], [[0x28, 0x020f0000, 0xe4000000, 1, 0, flag[1]], FT0]);
			}
			test(v, "sampler-bias", [VOP], [[0x28, 0x020f0000, 0xe4000000, 1, 0x00100000, 5], FT0]);

			for each (n in [200, 201, 1024, 1025, 2048, 2049])
			{
				test(v, "tokens" + n, repeat(VOP, n), [FOC]);
				var rows:Array = repeat([0, 0x020f0000, 0xe4000000, 1, 0, 0], n - 1);
				rows.push(FT0);
				test(v, "fragment-tokens" + n, [VOP], rows);
			}

			test(v, "two-constants", [VOP], [[1, 0x020f0000, 0xe4000000, 1, 0xe4000001, 1], FT0]);
			test(v, "two-constants-vertex", [[1, 0x030f0000, 0xe4000000, 1, 0xe4000001, 1]], [FOC]);
			test(v, "two-constants-dp3", [VOP], [[0x12, 0x020f0000, 0xe4000000, 1, 0xe4000001, 1], FT0]);
			test(v, "two-constants-m44", [[0x18, 0x030f0000, 0xe4000000, 1, 0xe4000004, 1]], [FOC]);
			test(v, "constant-varying", [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000000, 0, 0, 0]],
					[[1, 0x020f0000, 0xe4000000, 1, 0xe4000000, 4], FT0]);
			test(v, "kil-constant", [VOP], [[0x27, 0, 0x00000000, 1, 0, 0], FOC]);
			test(v, "od-twice", [VOP], [FOC, [0, 0x06010000, 0xe4000000, 1, 0, 0], [0, 0x06010000, 0xe4000001, 1, 0, 0]]);
			test(v, "od-alone", [VOP], [[0, 0x06010000, 0xe4000000, 1, 0, 0]]);
			test(v, "if-partial-branches", [VOP], [[0x1c, 0, 0x00000000, 1, 0x55000000, 1], [0, 0x02010000, 0xe4000000, 1, 0, 0],
						ELS, [0, 0x02020000, 0xe4000000, 1, 0, 0], EIF, [0, 0x030f0000, 0x54000000, 2, 0, 0]]);
			test(v, "if-else-if", [VOP], [start, ife, mov1, ELS, ife, mov2, EIF, EIF, FT0]);
			test(v, "if-tex-varying", [[0, 0x030f0000, 0xe4000000, 0, 0, 0], [0, 0x040f0000, 0xe4000000, 0, 0, 0]],
					[start, ife, [0x28, 0x020f0000, 0xe4000000, 4, 0, 5], EIF, FT0]);
			test(v, "if-tex-constant", [VOP], [start, ife, [0x28, 0x020f0000, 0xe4000000, 1, 0, 5], EIF, FT0]);
			test(v, "if-ddx", [VOP], [start, ife, [0x1a, 0x020f0000, 0xe4000000, 2, 0, 0], EIF, FT0]);
			test(v, "indirect-fragment", [VOP], [[0, 0x020f0000, 0xe4000000, 1, 0, 0], [0, 0x030f0000, 0xe4000000, 0x80000201, 0, 0]]);
			test(v, "indirect-vertex-temp", [[0, 0x020f0000, 0xe4000000, 0, 0, 0], [0, 0x030f0000, 0xe4000000, 0x80000201, 0, 0]], [FOC]);
			test(v, "indirect-vertex-offset200", [[0, 0x030f0000, 0xe4c80000, 0x80000001, 0, 0]], [FOC]);
		}
	}
}
