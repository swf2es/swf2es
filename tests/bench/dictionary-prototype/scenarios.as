// Shared scenario body: the driver supplies thin JS or AS3 adapters.
// Results tagged "layout" describe physical hash-table behavior, not portable ordering.
var total = 0;
function record(category, name, action) {
  var result;
  try {
    result = String(action());
  } catch (error:*) {
    result = "THREW:" + String(error);
  }
  emit(category + "\t" + name + "\t" + result);
  total++;
}

function label(key) {
  if (key !== null && (typeof key === "object" || typeof key === "function")) {
    return "object:" + key.id;
  }
  return typeof key + ":" + String(key);
}

function snapshot(dictionary) {
  var entries = [];
  walk(dictionary, function(key) {
    entries.push(label(key) + "=" + String(read(dictionary, key)));
  });
  return entries.sort().join(",");
}

function count(dictionary) {
  var n = 0;
  walk(dictionary, function(key) { n++; });
  return n;
}

function makeKey(kind, i) {
  switch (kind) {
    case "string": return "key" + i;
    case "number": return i;
    case "mixed":
      switch (i % 3) {
        case 0: return { id: i };
        case 1: return "key" + i;
        default: return i;
      }
    default: return { id: i };
  }
}

function filled(size, kind, weak) {
  var dictionary = makeDictionary(weak);
  var keys = [];
  for (var i = 0; i < size; i++) {
    var key = makeKey(kind, i);
    keys.push(key);
    put(dictionary, key, i);
  }
  return { dictionary: dictionary, keys: keys };
}

function mutationSuite(size, kind, weak) {
  var prefix = (weak ? "weak/" : "strong/") + kind + "/" + size + "/";
  record("stable", prefix + "unchanged", function() {
    var f = filled(size, kind, weak);
    var values = [];
    walkValues(f.dictionary, function(value) { values.push(String(value)); });
    return snapshot(f.dictionary) + ";values=" + values.sort().join(",") + ";held=" + f.keys.length;
  });
  record("stable", prefix + "overwrite", function() {
    var f = filled(size, kind, weak);
    var seen = [];
    walk(f.dictionary, function(key) {
      for (var i = 0; i < f.keys.length; i++) { put(f.dictionary, f.keys[i], 1000 + i); }
      seen.push(label(key) + "=" + read(f.dictionary, key));
    });
    return seen.sort().join(",") + ";final=" + snapshot(f.dictionary);
  });
  record("stable", prefix + "delete-current", function() {
    var f = filled(size, kind, weak);
    var seen = [];
    walk(f.dictionary, function(key) { seen.push(label(key)); remove(f.dictionary, key); });
    return seen.sort().join(",") + ";final=" + snapshot(f.dictionary);
  });
  record("stable", prefix + "delete-current-values", function() {
    var f = filled(size, kind, weak);
    for (var i = 0; i < f.keys.length; i++) {
      put(f.dictionary, f.keys[i], { key: f.keys[i], id: i });
    }
    var seen = [];
    walkValues(f.dictionary, function(value) {
      seen.push(value.id);
      remove(f.dictionary, value.key);
    });
    return seen.sort().join(",") + ";final=" + count(f.dictionary);
  });
  record("stable", prefix + "delete-unvisited", function() {
    var f = filled(size, kind, weak);
    var n = 0;
    walk(f.dictionary, function(key) {
      n++;
      for (var i = 0; i < f.keys.length; i++) {
        if (f.keys[i] !== key) { remove(f.dictionary, f.keys[i]); }
      }
      if (n > size + 1) { return false; }
    });
    return n + ";final=" + count(f.dictionary);
  });
  record("stable", prefix + "delete-already-visited", function() {
    var f = filled(size, kind, weak);
    var seen = [];
    var previous;
    var first = true;
    walk(f.dictionary, function(key) {
      if (!first) { remove(f.dictionary, previous); }
      first = false;
      previous = key;
      seen.push(label(key));
    });
    return seen.sort().join(",") + ";final=" + count(f.dictionary);
  });
  record("stable", prefix + "nested-readonly", function() {
    var f = filled(size, kind, weak);
    var seen = [];
    var inner = -1;
    walk(f.dictionary, function(key) {
      if (inner === -1) { inner = count(f.dictionary); }
      seen.push(label(key));
    });
    return seen.sort().join(",") + ";inner=" + inner;
  });
  record("stable", prefix + "nested-overwrite", function() {
    var f = filled(size, kind, weak);
    var seen = [];
    var inner = -1;
    walk(f.dictionary, function(key) {
      if (inner === -1) {
        inner = 0;
        walk(f.dictionary, function(innerKey) {
          put(f.dictionary, innerKey, read(f.dictionary, innerKey) + 1000);
          inner++;
        });
      }
      seen.push(label(key) + "=" + read(f.dictionary, key));
    });
    return seen.sort().join(",") + ";inner=" + inner;
  });
  record("stable", prefix + "nested-delete-all", function() {
    var f = filled(size, kind, weak);
    var outer = 0;
    var inner = 0;
    walk(f.dictionary, function(key) {
      outer++;
      walk(f.dictionary, function(innerKey) { inner++; remove(f.dictionary, innerKey); });
    });
    return outer + ";inner=" + inner + ";final=" + count(f.dictionary);
  });
  record("stable", prefix + "clear-then-nested", function() {
    var f = filled(size, kind, weak);
    var outer = 0;
    var inner = 0;
    walk(f.dictionary, function(key) {
      outer++;
      for (var i = 0; i < f.keys.length; i++) { remove(f.dictionary, f.keys[i]); }
      inner += count(f.dictionary);
    });
    return outer + ";inner=" + inner + ";final=" + count(f.dictionary);
  });
  record("stable", prefix + "delete-before-start", function() {
    var f = filled(size, kind, weak);
    for (var i = 0; i < f.keys.length; i += 2) { remove(f.dictionary, f.keys[i]); }
    return snapshot(f.dictionary);
  });
  record("stable", prefix + "break-and-restart", function() {
    var f = filled(size, kind, weak);
    walk(f.dictionary, function(key) { remove(f.dictionary, key); return false; });
    return count(f.dictionary) + ";again=" + count(f.dictionary);
  });
  // These depend on hash order or compaction policy. Keep raw outputs instead of asserting equality.
  record("layout", prefix + "reinsert-current", function() {
    var f = filled(size, kind, weak);
    var n = 0;
    var fired = false;
    walk(f.dictionary, function(key) {
      n++;
      if (!fired) {
        fired = true;
        var value = read(f.dictionary, key);
        remove(f.dictionary, key);
        put(f.dictionary, key, value);
      }
      if (n > size * 3 + 3) { return false; }
    });
    return n + ";final=" + snapshot(f.dictionary);
  });
  record("layout", prefix + "reinsert-current-nested", function() {
    var f = filled(size, kind, weak);
    var n = 0;
    var inner = 0;
    var fired = false;
    walk(f.dictionary, function(key) {
      n++;
      if (!fired) {
        fired = true;
        var value = read(f.dictionary, key);
        remove(f.dictionary, key);
        put(f.dictionary, key, value);
        inner = count(f.dictionary);
      }
      if (n > size * 3 + 3) { return false; }
    });
    return n + ";inner=" + inner + ";final=" + snapshot(f.dictionary);
  });
  record("layout", prefix + "grow-during-walk", function() {
    var f = filled(size, kind, weak);
    var n = 0;
    walk(f.dictionary, function(key) {
      if (++n === 1) {
        for (var i = size; i < size + 80; i++) {
          var added = makeKey(kind, i);
          f.keys.push(added);
          put(f.dictionary, added, i);
        }
      }
      if (n > (size + 80) * 3) { return false; }
    });
    return n + ";final=" + snapshot(f.dictionary);
  });
}

function lookupSuite(weak) {
  var prefix = (weak ? "weak/" : "strong/") + "lookup/";
  record("stable", prefix + "primitive-aliases", function() {
    var dictionary = makeDictionary(weak);
    var keys = [undefined, null, false, true, NaN, -0, 0, 1, "1", "01", "", "null",
      "undefined", "true", Infinity, -Infinity, 1.5, -2, "268435455", "268435456", "4294967295"];
    for (var i = 0; i < keys.length; i++) { put(dictionary, keys[i], i); }
    return snapshot(dictionary);
  });
  record("stable", prefix + "undefined-and-delete", function() {
    var dictionary = makeDictionary(weak);
    var key = { id: "key" };
    put(dictionary, key, undefined);
    put(dictionary, "undefined", undefined);
    var result = [member(dictionary, key), read(dictionary, key), member(dictionary, {}),
      own(dictionary, "undefined"), remove(dictionary, key), remove(dictionary, key),
      member(dictionary, key), read(dictionary, key)];
    return result.join("|");
  });
  record("stable", prefix + "identity-coercion", function() {
    var dictionary = makeDictionary(weak);
    var events = [];
    var key = { id: "key", toString: function() { events.push("string"); return "named"; } };
    var other = { id: "other", toString: key.toString };
    put(dictionary, key, 3);
    put(dictionary, other, 4);
    put(dictionary, "named", 8);
    var result = [read(dictionary, key), read(dictionary, other), member(dictionary, key),
      own(dictionary, key), enumerable(dictionary, key)];
    remove(dictionary, key);
    result.push(read(dictionary, key), member(dictionary, key));
    return result.join("|") + ";events=" + events.join(",");
  });
  record("stable", prefix + "throwing-coercion", function() {
    var dictionary = makeDictionary(weak);
    var key = { id: "key", toString: function() { throw "coerced"; } };
    put(dictionary, key, 3);
    var result = [read(dictionary, key), member(dictionary, key), remove(dictionary, key), read(dictionary, key)];
    try { member(dictionary, key); } catch (error:*) { result.push("in:" + error); }
    try { own(dictionary, key); } catch (error:*) { result.push("own:" + error); }
    try { enumerable(dictionary, key); } catch (error:*) { result.push("enum:" + error); }
    return result.join("|");
  });
  record("stable", prefix + "callable-and-array-identity", function() {
    var dictionary = makeDictionary(weak);
    var fn = function() { return 7; };
    var a = [1, 2];
    var b = [1, 2];
    put(dictionary, fn, 11);
    put(dictionary, a, 12);
    put(dictionary, b, 13);
    return [read(dictionary, fn), read(dictionary, a), read(dictionary, b), member(dictionary, fn), count(dictionary)].join("|");
  });
  record("stable", prefix + "enumerability", function() {
    var dictionary = makeDictionary(weak);
    var key = { id: "key", toString: function() { return "name"; } };
    put(dictionary, key, 1);
    put(dictionary, "name", 2);
    var result = [enumerable(dictionary, key), enumerable(dictionary, "name")];
    hide(dictionary, "name", false);
    result.push(enumerable(dictionary, "name"), count(dictionary));
    put(dictionary, "name", 3);
    result.push(enumerable(dictionary, "name"), count(dictionary));
    remove(dictionary, "name");
    put(dictionary, "name", 4);
    result.push(enumerable(dictionary, "name"), count(dictionary));
    hide(dictionary, "missing", false);
    put(dictionary, "missing", 5);
    result.push(enumerable(dictionary, "missing"));
    return result.join("|");
  });
  record("stable", prefix + "hide-during-walk", function() {
    var f = filled(32, "string", weak);
    var n = 0;
    walk(f.dictionary, function(key) {
      n++;
      for (var i = 0; i < f.keys.length; i++) { hide(f.dictionary, f.keys[i], false); }
    });
    return n + ";final=" + count(f.dictionary);
  });
  record("stable", prefix + "coercion-reentrancy", function() {
    var dictionary = makeDictionary(weak);
    var calls = 0;
    var key = { id: "key", toString: function() {
      calls++;
      put(dictionary, key, 12);
      return "ordinary";
    } };
    put(dictionary, "ordinary", 1);
    var result = [member(dictionary, key), member(dictionary, key), read(dictionary, key), calls];
    return result.join("|");
  });
  record("stable", prefix + "visibility-coercion", function() {
    var dictionary = makeDictionary(weak);
    var events = [];
    var key = { id: "key", toString: function() { events.push("string"); return "name"; } };
    var angry = { toString: function() { throw "coerced"; } };
    put(dictionary, "name", 1);
    hide(dictionary, key, false);
    try { hide(dictionary, angry, false); } catch (error:*) { events.push("throw:" + error); }
    return events.join(",") + ";enumerable=" + enumerable(dictionary, "name");
  });
}

for (var weakIndex = 0; weakIndex < 2; weakIndex++) {
  var weak = weakIndex === 1;
  lookupSuite(weak);
  var kinds = ["object", "string", "mixed", "number"];
  var sizes = [0, 1, 2, 7, 16, 32, 65, 128];
  for (var kindIndex = 0; kindIndex < kinds.length; kindIndex++) {
    for (var sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
      mutationSuite(sizes[sizeIndex], kinds[kindIndex], weak);
    }
  }
  mutationSuite(1000, "object", weak);
}
emit("total\t" + total);
