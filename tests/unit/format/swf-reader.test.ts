import assert from "node:assert/strict";
import { test } from "node:test";
import { SwfReader } from "@swf2es/format";
import { BitWriter } from "../../swf-writer.ts";

test("signed fields preserve both limits at every width and bit offset", () => {
  for (let width = 1; width <= 32; width++) {
    const min = -(2 ** (width - 1));
    const max = 2 ** (width - 1) - 1;

    for (let offset = 0; offset < 8; offset++) {
      const values = [0, min, max, -1];
      const writer = new BitWriter().ub(offset, 0);

      for (const value of values) {
        writer.sb(width, value);
      }

      writer.ub(5, 0b10101);
      const reader = new SwfReader(writer.done());
      reader.ub(offset);

      for (const value of values) {
        assert.equal(reader.sb(width), value, `${width} bits at offset ${offset}`);
      }

      assert.equal(reader.ub(5), 0b10101);
      assert.equal(reader.overrun, false);
    }
  }
});

test("signed fields match numeric decoding on random and truncated reads", () => {
  let state = 1;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };

  for (let trial = 0; trial < 200; trial++) {
    const bytes = Uint8Array.from({ length: random() % 100 }, () => random() >>> 24);
    const end = random() % (bytes.length + 1);
    const reader = new SwfReader(bytes, 0, end);
    const reference = new SwfReader(bytes, 0, end);

    for (let field = 0; field < 200; field++) {
      const width = random() % 33;
      const unsigned = reference.ub(width);
      const expected = unsigned >= 2 ** (width - 1) ? unsigned - 2 ** width : unsigned;
      assert.equal(reader.sb(width), expected, `trial ${trial}, field ${field}, width ${width}`);
      assert.equal(reader.pos, reference.pos);
      assert.equal(reader.overrun, reference.overrun);
      if (random() % 5 === 0) {
        reader.align();
        reference.align();
      }
    }
  }
});

test("zero-width fields consume nothing and wider fields retain their range", () => {
  const writer = new BitWriter()
    .ub(3, 0b101)
    .sb(33, -(2 ** 32))
    .sb(40, 2 ** 38);
  const reader = new SwfReader(writer.done());
  assert.equal(reader.ub(1), 1);
  const pos = reader.pos;
  assert.equal(reader.sb(0), 0);
  assert.equal(reader.pos, pos);
  assert.equal(reader.ub(2), 0b01);
  assert.equal(reader.sb(33), -(2 ** 32));
  assert.equal(reader.sb(40), 2 ** 38);
});
