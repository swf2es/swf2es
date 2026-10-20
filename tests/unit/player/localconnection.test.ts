// LocalConnection's observable behavior, including the VM boundary and unloads.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import type { avm2 } from "@swf2es/runtime";
import { LocalConnections } from "../../../packages/player/dist/localconnection.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { bare } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compileScripts } from "../../player/scripts.ts";
import { movie, play, take } from "./avm1/network.ts";

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const out = fileURLToPath(new URL("../out/localconnection/", import.meta.url));

test("AVM1 connections snapshot arguments, preserve references and cycles, and deliver status before the method", async () => {
  const played = await play(
    `var r=new LocalConnection(); var s=new LocalConnection();
r.take=function(a,b) {trace("take " + a.x + " " + (a==b) + " " + (a.self==a));};
s.onStatus=function(info) {trace("status " + info.level);};
trace(r.connect("_copy") + " " + new LocalConnection().connect("_COPY"));
var a={x:1};a.self=a;trace(s.send("_copy","take",a,a));a.x=2;
trace(s.send("_copy","send") + " " + s.send("", "take") + " " + s.send(3,"take"));`,
  );
  assert.deepEqual(take(played), ["true false", "true", "false false false"]);
  await played.deliver();
  assert.deepEqual(take(played), ["status status", "take 1 true true"]);
  played.player.destroy();
});

test("a receiver must exist at send and delivery, and a replacement receives the queued message", async () => {
  const played = await play(
    `var s=new LocalConnection();s.onStatus=function(i){trace(i.level);};
var a=new LocalConnection();var b=new LocalConnection();b.take=function(){trace("replacement");};
s.send("_late","take");a.connect("_late");
a.close();a.connect("_busy");s.send("_busy","take");a.close();b.connect("_busy");
a.connect("_closed");s.send("_closed","take");a.close();`,
  );
  await played.deliver();
  assert.deepEqual(take(played), ["error", "status", "replacement", "error"]);
  played.player.destroy();
});

test("AVM1 domain callbacks gate cross-domain and insecure delivery", async () => {
  const registry = new LocalConnections();
  const receiver = await play(
    `var r=new LocalConnection();r.connect("_gate");
r.take=function(n){trace("take " + n);};
r.allowDomain=function(domain){trace("domain " + domain);return domain=="other.test";};
r.allowInsecureDomain=function(domain){trace("insecure " + domain);return false;};`,
    { url: "https://receiver.test/a.swf", localConnections: registry },
  );
  const secure = await play(
    `var s=new LocalConnection();s.onStatus=function(i){trace(i.level);};s.send("_gate","take",1);`,
    { url: "https://other.test/b.swf", localConnections: registry },
  );
  await secure.deliver();
  assert.deepEqual(take(secure), ["status"]);
  assert.deepEqual(take(receiver), ["domain other.test", "take 1"]);
  const insecure = await play(
    `var s=new LocalConnection();s.onStatus=function(i){trace(i.level);};s.send("_gate","take",2);`,
    { url: "http://other.test/b.swf", localConnections: registry },
  );
  await insecure.deliver();
  assert.deepEqual(take(insecure), ["status"]);
  assert.deepEqual(take(receiver), ["insecure other.test"]);
  receiver.player.destroy();
  secure.player.destroy();
  insecure.player.destroy();
});

test("destroy unregisters receivers and discards queued messages", async () => {
  const registry = new LocalConnections();
  const first = await play(
    `var r=new LocalConnection();trace(r.connect("_cleanup"));r.take=function(){trace("never");};r.send("_cleanup","take");`,
    { localConnections: registry },
  );
  first.player.destroy();
  await first.deliver();
  assert.deepEqual(take(first), ["true"]);
  const second = await play(`trace(new LocalConnection().connect("_cleanup"));`, {
    localConnections: registry,
  });
  assert.deepEqual(take(second), ["true"]);
  second.player.destroy();
});

test("AVM1 rejects oversized UTF-8 strings and arrays without queueing delivery", async () => {
  const played = await play(`var r=new LocalConnection();r.connect("_limit");
r.take=function(value){trace("take " + value.length);};
r.onStatus=function(info){trace(info.level);};
var huge="x";for(var i=0;i<16;i++){huge+=huge;}
var utf="\u20ac";for(var j=0;j<14;j++){utf+=utf;}
trace(r.send("_limit","take",huge));
trace(r.send("_limit","take",utf));
trace(r.send("_limit","take",new Array(50000)));
trace(r.send("_limit","take",huge.substr(0,10000)));`);
  assert.deepEqual(take(played), ["false", "false", "false", "true"]);
  await played.deliver();
  assert.deepEqual(take(played), ["status", "take 10000"]);
  played.player.destroy();
});

test("AS3 allow lists admit only permitted domains and protocols from AVM1", async () => {
  const registry = new LocalConnections();
  const lines: number[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    url: "https://receiver.test/main.swf",
    localConnections: registry,
    audio: null,
    realTime: null,
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const receiver = s.rt.construct(s.rt.classNamed("flash.net::LocalConnection"));
  s.rt.setProperty(
    receiver,
    s.rt.publicName("client"),
    s.rt.newObject(["take", s.rt.newFunctionObject((n: number) => lines.push(n), null)]),
  );
  s.rt.callProperty(receiver, s.rt.publicName("connect"), "_domains");
  const send = async (url: string, n: number) => {
    const played = await play(`var s=new LocalConnection();s.send("_domains","take",${n});`, {
      url,
      localConnections: registry,
    });
    await played.deliver();
    assert.deepEqual(played.errors, []);
    played.player.destroy();
  };
  await send("https://receiver.test/a.swf", 1);
  await send("https://other.test/a.swf", 2);
  s.rt.callProperty(receiver, s.rt.publicName("allowDomain"), "other.test");
  await send("https://other.test/a.swf", 3);
  await send("http://other.test/a.swf", 4);
  s.rt.callProperty(receiver, s.rt.publicName("allowInsecureDomain"), "other.test");
  await send("http://other.test/a.swf", 5);
  await send("https://unrelated.test/a.swf", 6);
  assert.deepEqual(lines, [1, 3, 5]);
  s.destroy();
});

test("AS3 copies messages and reports size, status and receiver errors through the public API", async () => {
  const source = `package {
import flash.display.Sprite;import flash.net.LocalConnection;import flash.net.registerClassAlias;import flash.events.StatusEvent;import flash.events.AsyncErrorEvent;
import flash.utils.ByteArray;import flash.utils.IExternalizable;import flash.utils.IDataInput;import flash.utils.IDataOutput;
public class LocalRules extends Sprite {
 public function LocalRules() {
  var r:LocalConnection=new LocalConnection();var s:LocalConnection=new LocalConnection();
  r.client={take:function(o:Object):void{trace("copy " + o.x + " " + (o.self==o));},bad:function():void{throw new Error("receiver");},
   modern:function(b:ByteArray,xml:XML):void{trace("modern " + b.readUnsignedByte() + " " + xml.localName());},
   external:function(v:Stored):void{trace("external " + v.n);}};
  r.connect("_rules");
  r.addEventListener(AsyncErrorEvent.ASYNC_ERROR,function(e:AsyncErrorEvent):void{trace("async " + e.error.message);});
  s.addEventListener(StatusEvent.STATUS,function(e:StatusEvent):void{trace("status " + e.level);});
  var o:Object={x:1};o.self=o;s.send("_rules","take",o);o.x=2;
  s.send("_rules","bad");s.send("_missing","take");
  try {s.send("_rules","take",new Array(50001).join("x"));}catch(e:Error){trace("size " + e.errorID);}
  try {s.isPerUser=true;}catch(e:Error){trace("locked " + e.errorID);}
  var bytes:ByteArray=new ByteArray();bytes.writeByte(42);s.send("_rules","modern",bytes,new XML("<root/>"));bytes[0]=43;
  registerClassAlias("swf2es.Stored",Stored);s.send("_rules","external",new Stored());try{Stored.saved.writeInt(99);}catch(expired:Error){}
  s.send("_rules","take",{x:3});
 }
}
class Stored implements IExternalizable {
 public static var saved:IDataOutput;public var n:int=7;
 public function writeExternal(output:IDataOutput):void{saved=output;output.writeInt(n);}
 public function readExternal(input:IDataInput):void{n=input.readInt();}
}
}`;
  const abc = compileScripts([{ name: "LocalRules", source }], out).get("LocalRules") as Uint8Array;
  const lines: string[] = [],
    errors: unknown[] = [];
  const s = new Scripting(await createCodegen(wasm), {
    url: "file:///test.swf",
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    audio: null,
    realTime: null,
  });
  await s.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "LocalRules"), s);
  await player.start();
  player.tick();
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, [
    "size 2084",
    "locked 3316",
    "status status",
    "copy 1 true",
    "status status",
    "async receiver",
    "status error",
    "status status",
    "modern 42 root",
    "status status",
    "external 7",
    "status status",
    "copy 3 false",
  ]);
  player.destroy();
});

for (const fromBytes of [true, false]) {
  test(`an AS3 Loader's ${fromBytes ? "loadBytes" : "load"} runs AVM1 scripts and unload closes its connections`, async () => {
    const name = fromBytes ? "LocalMixed" : "LocalMixedURL";
    const child = movie(
      `var r=new LocalConnection();r.connect("_as1");
r.take=function(a,b,list) {trace("as1 " + a.x + " " + (a==b) + " " + (a.self==a) + " " + list.label + " " + list.length + " " + (list[0]==a));
 var reply=new LocalConnection();var arr=[a];arr.label="reply";reply.send("_as3","answer",new Date(123),new XML("<root/>"),arr);};`,
    );
    const source = `package {
import flash.display.Sprite;import flash.display.Loader;import flash.events.Event;import flash.events.StatusEvent;
import flash.net.LocalConnection;import flash.net.URLRequest;import flash.utils.ByteArray;import flash.system.LoaderContext;import flash.xml.XMLDocument;
public class ${name} extends Sprite {
 private var frames:int=0;
 public var loader:Loader=new Loader(); public var receiver:LocalConnection=new LocalConnection(); public var sender:LocalConnection=new LocalConnection();
 public function ${name}() {
  receiver.client=this;receiver.connect("_as3"); sender.addEventListener(StatusEvent.STATUS,function(e:StatusEvent):void{trace("as3 status " + e.level);});
  loader.contentLoaderInfo.addEventListener(Event.COMPLETE,function(e:Event):void {addEventListener(Event.ENTER_FRAME,sendOnce);});
  addChild(loader);var bytes:ByteArray=new ByteArray();var values:Array=[${[...child].join(",")}];for each(var value:uint in values){bytes.writeByte(value);}bytes.position=0;
  var context:LoaderContext=new LoaderContext();context.allowCodeImport=true;${fromBytes ? "loader.loadBytes(bytes,context);" : 'loader.load(new URLRequest("child.swf"),context);'}
 }
 private function sendOnce(e:Event):void {if(++frames<2){return;}removeEventListener(Event.ENTER_FRAME,sendOnce);var a:Object={x:1};a.self=a;var list:Array=[a];list.label="hello";sender.send("_as1","take",a,a,list);a.x=2;}
 public function answer(date:Date,xml:XMLDocument,list:Array):void {trace("as3 answer " + date.getTime() + " " + xml.firstChild.nodeName + " " + list.label + " " + list.length + " " + (list[0].self==list[0]));}
}}
`;
    const abc = compileScripts([{ name, source }], out).get(name) as Uint8Array;
    const lines: string[] = [],
      errors: unknown[] = [];
    let audioClosed = 0;
    const s = new Scripting(await createCodegen(wasm), {
      url: "https://example.test/main.swf",
      fetch: async () => ({ bytes: child, status: 200, headers: [] }),
      print: (line) => lines.push(line),
      onUncaught: (error) => errors.push(error),
      realTime: null,
      audio: { decode: () => Promise.reject(new Error("no device")), close: () => audioClosed++ },
    });
    await s.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bare(abc, 1, name), s);
    await player.start();
    await s.settled();
    for (let i = 0; i < 5; i++) {
      player.tick();
      await s.settled();
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(lines, [
      "as3 status status",
      "as1 1 true true hello 1 true",
      "as3 answer 123 root reply 1 true",
    ]);
    const root = player.root.object as avm2.AsObject;
    const loader = s.rt.getProperty(root, s.rt.publicName("loader"));
    s.rt.callProperty(loader, s.rt.publicName("unloadAndStop"));
    assert.equal(audioClosed, 0);
    const sender = s.rt.getProperty(root, s.rt.publicName("sender"));
    s.rt.callProperty(sender, s.rt.publicName("send"), "_as1", "take");
    player.tick();
    assert.equal(lines.at(-1), "as3 status error");
    player.destroy();
    assert.equal(audioClosed, 1);
  });
}
