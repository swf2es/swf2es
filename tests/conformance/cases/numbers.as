// Numbers as strings, as avmplus writes them.
trace(0.1, 1/3, 2/3, 100, 1e21, 1e-7, 123456789012345680000, 0.000001, -0, 5e-324);
trace(Number.MAX_VALUE, Number.MIN_VALUE, int.MAX_VALUE, int.MIN_VALUE, uint.MAX_VALUE);
trace((255).toString(16), (255).toString(2), (-255).toString(36), (3.5).toString(2));
trace((3.14159).toFixed(2), (1234.5678).toFixed(0), (0.5).toFixed(0), (1.5).toFixed(0));
trace((123.456).toPrecision(4), (0.00001234).toExponential(2), (1e21).toFixed(2));
trace(parseInt("42px"), parseInt("0x1f"), parseInt("777", 8), parseFloat("3.14abc"), parseInt(""));
trace(isNaN("abc"), isFinite("12"), Number(""), Number(" "), Number("1,5"), Number(null), Number(undefined));
trace(Math.round(-0.5), Math.round(2.5), Math.floor(-1.5), Math.ceil(-1.5), Math.max(), Math.min(1, "2"));
trace(int("  42  "), int("0x10"), uint("-1"), int(true), int(3000000000), uint(-0.5));
