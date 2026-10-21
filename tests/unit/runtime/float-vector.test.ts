import assert from "node:assert/strict";
import { test } from "node:test";
import { FloatVector } from "../../../packages/runtime/dist/avm2/natives/float-vector.js";

test("float vector buffers round values, retain capacity, and clear regrown elements", () => {
  const a = new FloatVector(4);
  a.data.set([0.1, -0, NaN, Infinity]);
  assert.equal(a.data[0], Math.fround(0.1));
  assert.ok(Object.is(a.data[1], -0));
  assert.ok(Number.isNaN(a.data[2]));
  assert.equal(a.data[3], Infinity);
  const first = a.data;
  a.length = 1;
  a.length = 4;
  assert.equal(a.data, first);
  assert.deepEqual(Array.from(a.data), [Math.fround(0.1), 0, 0, 0]);
  a.push(0.2);
  const grown = a.data;
  assert.notEqual(grown, first);
  a.push(0.3);
  assert.equal(a.data, grown);
  assert.equal(a.length, 6);
  a.length = 0;
  assert.equal(a.data.byteLength, 0);
  a.length = 4;
  assert.deepEqual(Array.from(a.data.subarray(0, a.length)), [0, 0, 0, 0]);
});

test("float vector mutations agree with a rounded array through repeated growth and shrinkage", () => {
  const a = new FloatVector();
  const expected: number[] = [];
  let seed = 27;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let i = 0; i < 2000; i++) {
    const value = Math.fround((next() | 0) / 12345);
    switch (next() % 7) {
      case 0:
        assert.equal(a.push(value), expected.push(value));
        break;
      case 1:
        assert.equal(a.pop(), expected.pop());
        break;
      case 2:
        assert.equal(a.unshift(value), expected.unshift(value));
        break;
      case 3:
        assert.equal(a.shift(), expected.shift());
        break;
      case 4: {
        const start = (next() % 30) - 15;
        const count = next() % 4;
        assert.deepEqual(a.splice(start, count, value), expected.splice(start, count, value));
        break;
      }
      case 5: {
        const length = next() % 30;
        while (expected.length < length) {
          expected.push(0);
        }

        expected.length = length;
        a.length = length;
        break;
      }
      default:
        a.reverse();
        expected.reverse();
        break;
    }

    assert.equal(a.length, expected.length, `length at ${i}`);
    assert.deepEqual(Array.from(a.data.subarray(0, a.length)), expected, `elements at ${i}`);
  }
});
