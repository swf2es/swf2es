// Setting a new object's slots to their initial values by name. V8 turns
// an object that a store by a computed key gives its seventeenth property
// into a dictionary, whose every access is a lookup; a store by name does
// so only past 128 properties outside the object. So objects of a class of
// many slots, a MouseEvent's 22, stay as fast as small ones.

// biome-ignore-all lint/suspicious/noFallthroughSwitchClause: fillSlots' cases fall through by design.

import type { AsObject, Value } from "./descriptors.js";

/** The most slots set by name, V8's own limit for stores by name. */
export const NAMED_SLOTS = 128;

/** What sets slots 0 to `values.length - 1` of a new object to `values`. */
export type SlotFiller = (o: AsObject, values: Value[]) => void;

/**
 * Set slots 0 to `values.length - 1` of `o`, at most NAMED_SLOTS of them,
 * to `values`, by name, highest first, as slotFiller's functions do: the
 * objects of a class get one shape whichever sets their slots.
 */
export function fillSlots(o: AsObject, values: Value[]): void {
  switch (values.length) {
    case 128:
      o.$127 = values[127];
    case 127:
      o.$126 = values[126];
    case 126:
      o.$125 = values[125];
    case 125:
      o.$124 = values[124];
    case 124:
      o.$123 = values[123];
    case 123:
      o.$122 = values[122];
    case 122:
      o.$121 = values[121];
    case 121:
      o.$120 = values[120];
    case 120:
      o.$119 = values[119];
    case 119:
      o.$118 = values[118];
    case 118:
      o.$117 = values[117];
    case 117:
      o.$116 = values[116];
    case 116:
      o.$115 = values[115];
    case 115:
      o.$114 = values[114];
    case 114:
      o.$113 = values[113];
    case 113:
      o.$112 = values[112];
    case 112:
      o.$111 = values[111];
    case 111:
      o.$110 = values[110];
    case 110:
      o.$109 = values[109];
    case 109:
      o.$108 = values[108];
    case 108:
      o.$107 = values[107];
    case 107:
      o.$106 = values[106];
    case 106:
      o.$105 = values[105];
    case 105:
      o.$104 = values[104];
    case 104:
      o.$103 = values[103];
    case 103:
      o.$102 = values[102];
    case 102:
      o.$101 = values[101];
    case 101:
      o.$100 = values[100];
    case 100:
      o.$99 = values[99];
    case 99:
      o.$98 = values[98];
    case 98:
      o.$97 = values[97];
    case 97:
      o.$96 = values[96];
    case 96:
      o.$95 = values[95];
    case 95:
      o.$94 = values[94];
    case 94:
      o.$93 = values[93];
    case 93:
      o.$92 = values[92];
    case 92:
      o.$91 = values[91];
    case 91:
      o.$90 = values[90];
    case 90:
      o.$89 = values[89];
    case 89:
      o.$88 = values[88];
    case 88:
      o.$87 = values[87];
    case 87:
      o.$86 = values[86];
    case 86:
      o.$85 = values[85];
    case 85:
      o.$84 = values[84];
    case 84:
      o.$83 = values[83];
    case 83:
      o.$82 = values[82];
    case 82:
      o.$81 = values[81];
    case 81:
      o.$80 = values[80];
    case 80:
      o.$79 = values[79];
    case 79:
      o.$78 = values[78];
    case 78:
      o.$77 = values[77];
    case 77:
      o.$76 = values[76];
    case 76:
      o.$75 = values[75];
    case 75:
      o.$74 = values[74];
    case 74:
      o.$73 = values[73];
    case 73:
      o.$72 = values[72];
    case 72:
      o.$71 = values[71];
    case 71:
      o.$70 = values[70];
    case 70:
      o.$69 = values[69];
    case 69:
      o.$68 = values[68];
    case 68:
      o.$67 = values[67];
    case 67:
      o.$66 = values[66];
    case 66:
      o.$65 = values[65];
    case 65:
      o.$64 = values[64];
    case 64:
      o.$63 = values[63];
    case 63:
      o.$62 = values[62];
    case 62:
      o.$61 = values[61];
    case 61:
      o.$60 = values[60];
    case 60:
      o.$59 = values[59];
    case 59:
      o.$58 = values[58];
    case 58:
      o.$57 = values[57];
    case 57:
      o.$56 = values[56];
    case 56:
      o.$55 = values[55];
    case 55:
      o.$54 = values[54];
    case 54:
      o.$53 = values[53];
    case 53:
      o.$52 = values[52];
    case 52:
      o.$51 = values[51];
    case 51:
      o.$50 = values[50];
    case 50:
      o.$49 = values[49];
    case 49:
      o.$48 = values[48];
    case 48:
      o.$47 = values[47];
    case 47:
      o.$46 = values[46];
    case 46:
      o.$45 = values[45];
    case 45:
      o.$44 = values[44];
    case 44:
      o.$43 = values[43];
    case 43:
      o.$42 = values[42];
    case 42:
      o.$41 = values[41];
    case 41:
      o.$40 = values[40];
    case 40:
      o.$39 = values[39];
    case 39:
      o.$38 = values[38];
    case 38:
      o.$37 = values[37];
    case 37:
      o.$36 = values[36];
    case 36:
      o.$35 = values[35];
    case 35:
      o.$34 = values[34];
    case 34:
      o.$33 = values[33];
    case 33:
      o.$32 = values[32];
    case 32:
      o.$31 = values[31];
    case 31:
      o.$30 = values[30];
    case 30:
      o.$29 = values[29];
    case 29:
      o.$28 = values[28];
    case 28:
      o.$27 = values[27];
    case 27:
      o.$26 = values[26];
    case 26:
      o.$25 = values[25];
    case 25:
      o.$24 = values[24];
    case 24:
      o.$23 = values[23];
    case 23:
      o.$22 = values[22];
    case 22:
      o.$21 = values[21];
    case 21:
      o.$20 = values[20];
    case 20:
      o.$19 = values[19];
    case 19:
      o.$18 = values[18];
    case 18:
      o.$17 = values[17];
    case 17:
      o.$16 = values[16];
    case 16:
      o.$15 = values[15];
    case 15:
      o.$14 = values[14];
    case 14:
      o.$13 = values[13];
    case 13:
      o.$12 = values[12];
    case 12:
      o.$11 = values[11];
    case 11:
      o.$10 = values[10];
    case 10:
      o.$9 = values[9];
    case 9:
      o.$8 = values[8];
    case 8:
      o.$7 = values[7];
    case 7:
      o.$6 = values[6];
    case 6:
      o.$5 = values[5];
    case 5:
      o.$4 = values[4];
    case 4:
      o.$3 = values[3];
    case 3:
      o.$2 = values[2];
    case 2:
      o.$1 = values[1];
    case 1:
      o.$0 = values[0];
  }
}

/** Whether code may be made from text: a page whose policy has no 'unsafe-eval' refuses it. */
let evaluates = true;

/**
 * A function of its own that sets `n` slots as fillSlots does, or null
 * where code may not be made from text. Each store of fillSlots sees the
 * objects of every class, and V8 looks a store that has seen many shapes
 * up in a table; one class's function sees one shape, which its stores
 * keep inline: a class's objects are made faster so.
 */
export function slotFiller(n: number): SlotFiller | null {
  if (!evaluates) {
    return null;
  }

  const stores: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    stores.push(`o.$${i} = v[${i}];`);
  }

  try {
    return new Function("o", "v", stores.join("")) as SlotFiller;
  } catch {
    evaluates = false;
    return null;
  }
}
