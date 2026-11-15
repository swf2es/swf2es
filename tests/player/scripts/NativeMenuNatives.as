// AIR's NativeMenu, NativeMenuItem and ContextMenu's menu members, as adl
// has them: defaults, toString, the errors, items in one menu at a time,
// submenus and their parents, clone, the events a script can make, and
// customItems as ContextMenu's items. Played as AIR: Flash Player hides
// all of it but ContextMenu's own members. display waits for a choice in
// adl, so the unit and web tests test it.
package
{
	import flash.display.NativeMenu;
	import flash.display.NativeMenuItem;
	import flash.display.Sprite;
	import flash.events.ContextMenuEvent;
	import flash.events.Event;
	import flash.events.MouseEvent;
	import flash.net.URLRequest;
	import flash.ui.ContextMenu;
	import flash.ui.ContextMenuBuiltInItems;
	import flash.ui.ContextMenuClipboardItems;
	import flash.ui.ContextMenuItem;

	public class NativeMenuNatives extends Sprite
	{
		private function t(label:String, f:Function):void
		{
			try
			{
				trace(label + " " + f());
			}
			catch (e:Error)
			{
				trace(label + " threw " + Object(e).constructor + " " + e.errorID + " " + e.message);
			}
		}

		private static function labels(m:NativeMenu):String
		{
			if (m == null)
			{
				return "null";
			}

			const out:Array = [];
			const items:Array = m.items;
			for (var i:int = 0; i < items.length; i++)
			{
				out.push(items[i] is NativeMenuItem ? items[i].label : String(items[i]));
			}

			return m.numItems + ":[" + out.join(",") + "]";
		}

		private static function item(i:NativeMenuItem):String
		{
			if (i == null)
			{
				return "null";
			}

			return "label=" + i.label + " sep=" + i.isSeparator + " enabled=" + i.enabled + " checked=" + i.checked + " data=" + i.data + " key=" + JSON.stringify(i.keyEquivalent) + " mods=" + JSON.stringify(i.keyEquivalentModifiers) + " mnemonic=" + i.mnemonicIndex + " name=" + JSON.stringify(i.name) + " submenu=" + i.submenu + " menu=" + i.menu;
		}

		private static function bi(b:ContextMenuBuiltInItems):String
		{
			return [b.forwardAndBack, b.loop, b.play, b.print, b.quality, b.rewind, b.save, b.zoom].join(",");
		}

		private static function ci(b:ContextMenuClipboardItems):String
		{
			return [b.clear, b.copy, b.cut, b.paste, b.selectAll].join(",");
		}

		public function NativeMenuNatives()
		{
			items();
			properties();
			contextMenus();
			more();
		}

		private function items():void
		{
			t("NativeMenu.isSupported", function():*
				{
					return NativeMenu.isSupported;
				});
			t("ContextMenu.isSupported", function():*
				{
					return ContextMenu.isSupported;
				});
			const m:NativeMenu = new NativeMenu();
			t("menu", function():*
				{
					return m + " numItems=" + m.numItems + " items=" + m.items + " parent=" + m.parent;
				});
			t("item default", function():*
				{
					return item(new NativeMenuItem());
				});
			t("item toString", function():*
				{
					return new NativeMenuItem("a b").toString();
				});
			t("item sep", function():*
				{
					return item(new NativeMenuItem("s", true));
				});
			t("item sep toString", function():*
				{
					return new NativeMenuItem("s", true).toString();
				});
			t("cmitem", function():*
				{
					const c:ContextMenuItem = new ContextMenuItem("cap");
					return item(c) + " caption=" + c.caption + " toString=" + c;
				});
			t("cmitem sep", function():*
				{
					const c:ContextMenuItem = new ContextMenuItem("cap", true, false, false);
					return item(c) + " sepBefore=" + c.separatorBefore + " visible=" + c.visible;
				});
			t("label set", function():*
				{
					const c:ContextMenuItem = new ContextMenuItem("cap");
					c.label = "lab";
					const before:String = c.caption;
					c.caption = "cap2";
					return before + " " + c.label;
				});
			t("label null", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.label = null;
					return JSON.stringify(i.label);
				});
			t("name null", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.name = null;
					return JSON.stringify(i.name);
				});
			t("key K", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalent = "K";
					return JSON.stringify(i.keyEquivalent) + " " + JSON.stringify(i.keyEquivalentModifiers);
				});
			t("key null", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalent = null;
					return JSON.stringify(i.keyEquivalent);
				});
			t("key long", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalent = "abc";
					return JSON.stringify(i.keyEquivalent);
				});
			t("mods null", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalentModifiers = null;
					return JSON.stringify(i.keyEquivalentModifiers);
				});
			t("mods copy", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					const a:Array = [1, "b"];
					i.keyEquivalentModifiers = a;
					a.push(3);
					return JSON.stringify(i.keyEquivalentModifiers) + " " + (i.keyEquivalentModifiers == a) + " " + (i.keyEquivalentModifiers == i.keyEquivalentModifiers);
				});
			t("mnemonic", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("abc");
					i.mnemonicIndex = 7;
					const a:int = i.mnemonicIndex;
					i.mnemonicIndex = -3;
					return a + " " + i.mnemonicIndex;
				});
			t("checked sep", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("s", true);
					i.checked = true;
					i.enabled = false;
					return i.checked + " " + i.enabled;
				});
			t("submenu set", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("s");
					const sub:NativeMenu = new NativeMenu();
					i.submenu = sub;
					const p:* = sub.parent;
					i.submenu = null;
					return p + " " + sub.parent + " " + i.submenu;
				});

			// Bookkeeping.
			t("bad index", function():*
				{
					return new NativeMenu().getItemAt(0);
				});
			t("bad index -1", function():*
				{
					return new NativeMenu().getItemAt(-1);
				});
			t("addItemAt -1", function():*
				{
					return new NativeMenu().addItemAt(new NativeMenuItem("a"), -1);
				});
			t("addItemAt 1", function():*
				{
					return new NativeMenu().addItemAt(new NativeMenuItem("a"), 1);
				});
			t("addItem null", function():*
				{
					return new NativeMenu().addItem(null);
				});
			t("addItemAt null 5", function():*
				{
					return new NativeMenu().addItemAt(null, 5);
				});
			t("removeItemAt -1", function():*
				{
					return new NativeMenu().removeItemAt(-1);
				});
			t("removeItemAt 0", function():*
				{
					return new NativeMenu().removeItemAt(0);
				});
			t("removeItem absent", function():*
				{
					return new NativeMenu().removeItem(new NativeMenuItem("a"));
				});
			t("removeItem null", function():*
				{
					return new NativeMenu().removeItem(null);
				});
			t("getItemIndex null", function():*
				{
					return new NativeMenu().getItemIndex(null);
				});
			t("getItemIndex absent", function():*
				{
					return new NativeMenu().getItemIndex(new NativeMenuItem("a"));
				});
			t("containsItem null", function():*
				{
					return new NativeMenu().containsItem(null);
				});
			t("getItemByName null", function():*
				{
					return new NativeMenu().getItemByName(null);
				});
			t("getItemByName", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					const b:NativeMenuItem = n.addItem(new NativeMenuItem("b"));
					const c:NativeMenuItem = n.addItem(new NativeMenuItem("c"));
					a.name = "x";
					c.name = "x";
					return n.getItemByName("x").label + " " + n.getItemByName("") + " " + n.getItemByName("y");
				});
			t("add returns", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					return (n.addItem(a) == a) + " " + (a.menu == n) + " " + labels(n) + " " + n.containsItem(a) + " " + n.getItemIndex(a);
				});
			t("add twice", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					n.addItem(a);
					n.addItem(new NativeMenuItem("b"));
					n.addItem(a);
					return labels(n);
				});
			t("add twice at 0", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					n.addItem(new NativeMenuItem("b"));
					n.addItem(a);
					n.addItemAt(a, 0);
					return labels(n);
				});
			t("add twice at end", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					n.addItem(a);
					n.addItem(new NativeMenuItem("b"));
					n.addItemAt(a, 2);
					return labels(n);
				});
			t("add other menu", function():*
				{
					const n1:NativeMenu = new NativeMenu();
					const n2:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					n1.addItem(a);
					n2.addItem(a);
					return labels(n1) + " " + labels(n2) + " " + (a.menu == n1) + " " + (a.menu == n2);
				});
			t("remove", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					const r:NativeMenuItem = n.removeItem(a);
					return (r == a) + " " + a.menu + " " + labels(n);
				});
			t("removeItemAt", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					return n.removeItemAt(1).label + " " + labels(n);
				});
			t("removeAll", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.removeAllItems();
					return a.menu + " " + labels(n);
				});
			t("setItemIndex", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					n.addItem(new NativeMenuItem("c"));
					n.setItemIndex(a, 2);
					const s1:String = labels(n);
					n.setItemIndex(a, 0);
					return s1 + " " + labels(n);
				});
			t("setItemIndex 1", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					n.addItem(new NativeMenuItem("c"));
					n.setItemIndex(a, 1);
					return labels(n);
				});
			t("setItemIndex 3", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					n.setItemIndex(a, 2);
					return labels(n);
				});
			t("setItemIndex 9", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					n.setItemIndex(a, 9);
					return labels(n);
				});
			t("setItemIndex -1", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					n.setItemIndex(a, -1);
					return labels(n);
				});
			t("setItemIndex absent", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("b"));
					n.setItemIndex(new NativeMenuItem("a"), 0);
					return labels(n);
				});
			t("setItemIndex null", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("b"));
					n.setItemIndex(null, 0);
					return labels(n);
				});
			t("items set", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const old:NativeMenuItem = n.addItem(new NativeMenuItem("old"));
					const arr:Array = [new NativeMenuItem("a"), new NativeMenuItem("b")];
					n.items = arr;
					arr.push(new NativeMenuItem("c"));
					const got:Array = n.items;
					got.push(1);
					return labels(n) + " " + old.menu + " " + (n.items == n.items) + " " + (arr[0].menu == n);
				});
			t("items set null", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("a"));
					n.items = null;
					return labels(n);
				});
			t("items set bad", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("a"));
					n.items = [new NativeMenuItem("b"), 5, null];
					return labels(n);
				});
			t("addSubmenu", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					sub.addItem(new NativeMenuItem("inner"));
					const i:NativeMenuItem = n.addSubmenu(sub, "S");
					return item(i) + " | " + (i.submenu == sub) + " " + (sub.parent == n) + " " + (i.menu == n) + " " + labels(n);
				});
			t("addSubmenuAt", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("a"));
					const sub:NativeMenu = new NativeMenu();
					n.addSubmenuAt(sub, 0, "S");
					return labels(n);
				});
			t("addSubmenuAt bad", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					return n.addSubmenuAt(sub, 3, "S") + " " + sub.parent;
				});
			t("addSubmenu null", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = n.addSubmenu(null, "S");
					return item(i) + " " + labels(n);
				});
			t("addSubmenu null label", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = n.addSubmenu(new NativeMenu(), null);
					return JSON.stringify(i.label);
				});
			t("addSubmenu self", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addSubmenu(n, "S");
					return labels(n) + " " + (n.parent == n);
				});
			t("addSubmenu ancestor", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					a.addSubmenu(b, "B");
					b.addSubmenu(a, "A");
					return labels(a) + " " + labels(b) + " " + (a.parent == b) + " " + (b.parent == a);
				});
			t("submenu ancestor set", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					a.addSubmenu(b, "B");
					const i:NativeMenuItem = b.addItem(new NativeMenuItem("x"));
					i.submenu = a;
					return labels(b) + " " + (i.submenu == a) + " " + (a.parent == b);
				});
			t("submenu twice", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					const i1:NativeMenuItem = a.addSubmenu(sub, "1");
					const i2:NativeMenuItem = b.addSubmenu(sub, "2");
					return labels(a) + " " + labels(b) + " " + (sub.parent == a) + " " + (sub.parent == b) + " " + (i1.submenu == sub);
				});
			t("submenu remove", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = a.addSubmenu(sub, "1");
					a.removeItem(i);
					return sub.parent + " " + (i.submenu == sub);
				});
			t("submenu before add", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.submenu = sub;
					const p0:* = sub.parent;
					a.addItem(i);
					return p0 + " " + (sub.parent == a);
				});

			// clone.
			t("clone item", function():*
				{
					const d:Object = {k: 1};
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.data = d;
					i.name = "nm";
					i.checked = true;
					i.enabled = false;
					i.keyEquivalent = "q";
					i.keyEquivalentModifiers = [5];
					i.mnemonicIndex = 0;
					const sub:NativeMenu = new NativeMenu();
					sub.addItem(new NativeMenuItem("in"));
					i.submenu = sub;
					var heard:int = 0;
					i.addEventListener(Event.SELECT, function(e:Event):void
					{
						heard++;
					});
					const m2:NativeMenu = new NativeMenu();
					m2.addItem(i);
					const c:NativeMenuItem = i.clone();
					c.dispatchEvent(new Event(Event.SELECT));
					return item(c) + " | data same " + (c.data == d) + " sub same " + (c.submenu == sub) + " sub " + labels(c.submenu) + " heard " + heard + " mods same " + (c.keyEquivalentModifiers == i.keyEquivalentModifiers) + " " + c;
				});
			t("clone cmitem", function():*
				{
					const i:ContextMenuItem = new ContextMenuItem("x", true, false, false);
					i.data = 3;
					i.name = "nm";
					const c:* = i.clone();
					return c + " " + item(c) + " " + c.caption + " " + c.separatorBefore + " " + c.visible;
				});
			t("clone menu", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const d:Object = {};
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					a.data = d;
					const sub:NativeMenu = new NativeMenu();
					sub.addItem(new NativeMenuItem("in"));
					n.addSubmenu(sub, "S");
					var heard:int = 0;
					n.addEventListener(Event.SELECT, function(e:Event):void
					{
						heard++;
					});
					const c:NativeMenu = n.clone();
					c.dispatchEvent(new Event(Event.SELECT));
					return labels(c) + " item same " + (c.getItemAt(0) == a) + " data same " + (c.getItemAt(0).data == d) + " sub same " + (c.getItemAt(1).submenu == sub) + " sub " + labels(c.getItemAt(1).submenu) + " subparent " + (c.getItemAt(1).submenu.parent == c) + " heard " + heard + " parent " + c.parent + " " + c;
				});

			// Events.
			t("select bubbles", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					a.addSubmenu(sub, "S");
					const i:NativeMenuItem = sub.addItem(new NativeMenuItem("x"));
					const log:Array = [];
					const f:Function = function(name:String):Function
					{
						return function(e:Event):void
						{
							log.push(name + ":" + e.eventPhase + ":" + (e.target == i) + ":" + (e.currentTarget == i));
						};
					};
					i.addEventListener(Event.SELECT, f("item"));
					sub.addEventListener(Event.SELECT, f("sub"));
					a.addEventListener(Event.SELECT, f("top"));
					a.addEventListener(Event.SELECT, f("topcap"), true);
					i.dispatchEvent(new Event(Event.SELECT, true));
					i.dispatchEvent(new Event(Event.SELECT, false));
					return log.join(" ");
				});
			t("dispatchContextMenuSelect", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const log:Array = [];
					cm.addEventListener(ContextMenuEvent.MENU_SELECT, function(e:ContextMenuEvent):void
					{
						log.push(e.type + " " + e.mouseTarget + " " + e.contextMenuOwner + " " + e.bubbles);
					});
					cm.addEventListener(Event.DISPLAYING, function(e:Event):void
					{
						log.push(e.type);
					});
					cm.addEventListener(Event.PREPARING, function(e:Event):void
					{
						log.push(e.type);
					});
					const r:* = cm.dispatchContextMenuSelect(new MouseEvent(MouseEvent.RIGHT_CLICK));
					return r + " " + log.join(" | ");
				});
			t("nm dispatchContextMenuSelect", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const log:Array = [];
					n.addEventListener(ContextMenuEvent.MENU_SELECT, function(e:Event):void
					{
						log.push(e.type + " " + e);
					});
					n.addEventListener(Event.DISPLAYING, function(e:Event):void
					{
						log.push(e.type);
					});
					n.addEventListener(Event.PREPARING, function(e:Event):void
					{
						log.push(e.type);
					});
					const r:* = n.dispatchContextMenuSelect(new MouseEvent(MouseEvent.RIGHT_CLICK));
					return r + " " + log.join(" | ");
				});

			// ContextMenu.
			t("cm default", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					return labels(cm) + " custom=" + cm.customItems.length + " parent=" + cm.parent + " link=" + cm.link + " clipboardMenu=" + cm.clipboardMenu + " " + cm;
				});
			t("cm custom", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems.push(a);
					return labels(cm) + " contains=" + cm.containsItem(a) + " index=" + cm.getItemIndex(a) + " menu=" + (a.menu == cm);
				});
			t("cm custom set", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					const arr:Array = [a, new ContextMenuItem("b")];
					cm.customItems = arr;
					arr.push(new ContextMenuItem("c"));
					return labels(cm) + " same=" + (cm.customItems == arr) + " menu=" + (a.menu == cm);
				});
			t("cm addItem", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					const r:* = cm.addItem(a);
					return (r == a) + " " + labels(cm) + " custom=" + cm.customItems.length + " " + (cm.customItems[0] == a) + " menu=" + (a.menu == cm);
				});
			t("cm addItem native", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					const r:* = cm.addItem(a);
					return (r == a) + " " + labels(cm) + " custom=" + cm.customItems.length;
				});
			t("cm addItemAt bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					return cm.addItemAt(new ContextMenuItem("a"), 3);
				});
			t("cm addItem null", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					return cm.addItem(null);
				});
			t("cm getItemAt bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					return cm.getItemAt(0);
				});
			t("cm removeItemAt bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					return cm.removeItemAt(0);
				});
			t("cm remove", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const arr:Array = [new ContextMenuItem("a"), new ContextMenuItem("b")];
					cm.customItems = arr;
					const r:NativeMenuItem = cm.removeItemAt(0);
					return r.label + " " + labels(cm) + " arr=" + arr.length + " custom=" + cm.customItems.length + " " + (cm.customItems == arr);
				});
			t("cm removeItem", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a, new ContextMenuItem("b")];
					return cm.removeItem(a).label + " " + labels(cm);
				});
			t("cm removeAll", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const arr:Array = [new ContextMenuItem("a"), new ContextMenuItem("b")];
					cm.customItems = arr;
					cm.removeAllItems();
					return labels(cm) + " arr=" + arr.length + " " + (cm.customItems == arr);
				});
			t("cm items set", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const arr:Array = [new ContextMenuItem("a"), new ContextMenuItem("b")];
					cm.items = arr;
					return labels(cm) + " " + (cm.customItems == arr) + " custom=" + cm.customItems.length;
				});
			t("cm custom bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = [new ContextMenuItem("a"), 5, null, new NativeMenuItem("n"), "s"];
					return labels(cm);
				});
			t("cm custom null", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = null;
					return cm.customItems + " " + labels(cm);
				});
			t("cm setItemIndex", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a, new ContextMenuItem("b"), new ContextMenuItem("c")];
					cm.setItemIndex(a, 2);
					return labels(cm);
				});
			t("cm getItemByName", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					a.name = "n";
					cm.customItems = [a];
					return cm.getItemByName("n");
				});
			t("cm addSubmenu", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const sub:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = cm.addSubmenu(sub, "S");
					return i + " " + labels(cm) + " custom=" + cm.customItems.length + " " + (sub.parent == cm);
				});
			t("cm item in two", function():*
				{
					const cm1:ContextMenu = new ContextMenu();
					const cm2:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm1.customItems.push(a);
					cm2.customItems.push(a);
					return labels(cm1) + " " + labels(cm2) + " " + (a.menu == cm1) + " " + (a.menu == cm2);
				});
			t("cm addItem in two", function():*
				{
					const cm1:ContextMenu = new ContextMenu();
					const cm2:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm1.addItem(a);
					cm2.addItem(a);
					return labels(cm1) + " " + labels(cm2) + " " + (a.menu == cm1) + " " + (a.menu == cm2);
				});
			t("cm clone", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					a.data = {};
					cm.customItems = [a];
					cm.hideBuiltInItems();
					cm.clipboardMenu = true;
					cm.builtInItems.print = true;
					const c:ContextMenu = ContextMenu(cm.clone());
					return labels(c) + " same=" + (c.customItems[0] == a) + " arr same=" + (c.customItems == cm.customItems) + " data same=" + (c.customItems[0].data == a.data) + " print=" + c.builtInItems.print + " zoom=" + c.builtInItems.zoom + " bi same=" + (c.builtInItems == cm.builtInItems) + " clip=" + c.clipboardMenu + " cbi same=" + (c.clipboardItems == cm.clipboardItems) + " " + c;
				});
			t("cm items get copy", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = [new ContextMenuItem("a")];
					return (cm.items == cm.customItems) + " " + (cm.items == cm.items);
				});
		}

		private function properties():void
		{
			const lens:Array = [-2, -1, 0, 1, 2, 3, 4];
			for (var k:int = 0; k < lens.length; k++)
			{
				const v:int = lens[k];
				t("mnemonic abc " + v, function():*
					{
						const i:NativeMenuItem = new NativeMenuItem("abc");
						i.mnemonicIndex = v;
						return i.mnemonicIndex;
					});
			}

			t("mnemonic then label", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("abc");
					i.mnemonicIndex = 2;
					i.label = "a";
					return i.mnemonicIndex + " " + i;
				});
			t("mnemonic empty -1", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("");
					i.mnemonicIndex = -1;
					return i.mnemonicIndex;
				});
			t("mnemonic empty 0", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("");
					i.mnemonicIndex = 0;
					return i.mnemonicIndex;
				});
			const modsets:Array = [[], [15], [16], [17], [18], [19], [20], [1, 16], [17, 16], [16, 16], ["16"], [16.5], [null], [15, 16, 17, 18]];
			for (k = 0; k < modsets.length; k++)
			{
				const ms:Array = modsets[k];
				t("mods " + JSON.stringify(ms), function():*
					{
						const i:NativeMenuItem = new NativeMenuItem("x");
						i.keyEquivalentModifiers = ms;
						return JSON.stringify(i.keyEquivalentModifiers) + " " + i;
					});
			}

			const keys:Array = ["q", "Q", "", "1", "abc", "ABC", "é", "É", " ", "F1", "\t"];
			for (k = 0; k < keys.length; k++)
			{
				const key:String = keys[k];
				t("key " + JSON.stringify(key), function():*
					{
						const i:NativeMenuItem = new NativeMenuItem("x");
						i.keyEquivalent = key;
						return JSON.stringify(i.keyEquivalent) + " " + JSON.stringify(i.keyEquivalentModifiers) + " " + i;
					});
			}

			t("key Q then q", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalent = "Q";
					i.keyEquivalent = "q";
					return JSON.stringify(i.keyEquivalentModifiers);
				});
			t("key Q then mods", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalent = "Q";
					i.keyEquivalentModifiers = [18];
					return JSON.stringify(i.keyEquivalentModifiers) + " " + i;
				});
			t("mods then key Q", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalentModifiers = [18];
					i.keyEquivalent = "Q";
					return JSON.stringify(i.keyEquivalentModifiers) + " " + i;
				});
			t("mods [] then key Q", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalentModifiers = [];
					i.keyEquivalent = "Q";
					const a:String = JSON.stringify(i.keyEquivalentModifiers);
					i.keyEquivalent = null;
					return a + " " + JSON.stringify(i.keyEquivalentModifiers);
				});
			t("label quote toString", function():*
				{
					return new NativeMenuItem('a"b\nc');
				});
			t("label null toString", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem(null);
					return JSON.stringify(i.label) + " " + i;
				});
			t("ctor sep label", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("lab", true);
					return JSON.stringify(i.label);
				});

			// clone
			t("clone item", function():*
				{
					const d:Object = {k: 1};
					const i:NativeMenuItem = new NativeMenuItem("xyz");
					i.data = d;
					i.name = "nm";
					i.checked = true;
					i.enabled = false;
					i.keyEquivalent = "q";
					i.keyEquivalentModifiers = [18];
					i.mnemonicIndex = 1;
					const sub:NativeMenu = new NativeMenu();
					sub.addItem(new NativeMenuItem("in"));
					i.submenu = sub;
					var heard:int = 0;
					i.addEventListener(Event.SELECT, function(e:Event):void
					{
						heard++;
					});
					const m2:NativeMenu = new NativeMenu();
					m2.addItem(i);
					const c:NativeMenuItem = i.clone();
					c.dispatchEvent(new Event(Event.SELECT));
					return c.label + " " + c.enabled + " " + c.checked + " " + c.data + " " + c.name + " " + c.keyEquivalent + " " + JSON.stringify(c.keyEquivalentModifiers) + " " + c.mnemonicIndex + " menu=" + c.menu + " sub same=" + (c.submenu == sub) + " sub=" + (c.submenu ? labels(c.submenu) + " subparent=" + c.submenu.parent : "null") + " heard=" + heard + " " + c;
				});
			t("clone data prim", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.data = 5;
					return i.clone().data;
				});
			t("clone data str", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.data = "s";
					return i.clone().data;
				});
			t("clone sep", function():*
				{
					return new NativeMenuItem("x", true).clone().isSeparator;
				});
			t("clone cmitem class", function():*
				{
					const i:ContextMenuItem = new ContextMenuItem("x");
					const c:* = i.clone();
					return (c is ContextMenuItem) + " " + Object(c).constructor + " " + i;
				});
			t("clone menu data", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					a.data = 7;
					a.name = "n";
					return n.clone().getItemAt(0).data + " " + n.clone().getItemAt(0).name;
				});
			t("clone menu of cmitems", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new ContextMenuItem("a"));
					return Object(n.clone().getItemAt(0)).constructor;
				});
			t("clone menu sub", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.submenu = new NativeMenu();
					i.submenu.addItem(new NativeMenuItem("deep"));
					n.addItem(i);
					const c:NativeMenu = n.clone();
					return labels(c.getItemAt(0).submenu) + " " + (c.getItemAt(0).submenu.parent == c) + " " + (c.getItemAt(0).menu == c);
				});

			// items set partial
			t("items set partial", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("old"));
					try
					{
						n.items = [new NativeMenuItem("b"), 5, new NativeMenuItem("c")];
					}
					catch (e:Error)
					{
						return labels(n) + " " + e.errorID;
					}

					return labels(n);
				});
			t("items set dup", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = new NativeMenuItem("a");
					try
					{
						n.items = [a, a];
					}
					catch (e:Error)
					{
						return labels(n) + " " + e.errorID;
					}

					return labels(n);
				});
			t("items set own", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					n.items = n.items.reverse();
					return labels(n);
				});
			t("addSubmenu ancestor ret", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					a.addSubmenu(b, "B");
					const r:NativeMenuItem = b.addSubmenu(a, "A");
					return r + " " + (r ? r.menu + " " + r.submenu : "");
				});
			t("addSubmenu self ret", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const r:NativeMenuItem = a.addSubmenu(a, "A");
					return r + " " + (r ? r.menu + " " + r.submenu : "");
				});
			t("addSubmenu deep ancestor", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					const c:NativeMenu = new NativeMenu();
					a.addSubmenu(b, "B");
					b.addSubmenu(c, "C");
					const r:NativeMenuItem = c.addSubmenu(a, "A");
					return r + " " + labels(c);
				});
			t("addItem with ancestor sub", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					a.addSubmenu(b, "B");
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.submenu = a;
					b.addItem(i);
					return labels(b) + " " + (a.parent == b);
				});
			t("submenu reassign", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const s1:NativeMenu = new NativeMenu();
					const s2:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = a.addSubmenu(s1, "S");
					i.submenu = s2;
					return s1.parent + " " + (s2.parent == a);
				});
			t("submenu steal by set", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					const i1:NativeMenuItem = a.addSubmenu(sub, "1");
					const i2:NativeMenuItem = a.addItem(new NativeMenuItem("2"));
					i2.submenu = sub;
					return i1.submenu + " " + (i2.submenu == sub) + " " + (sub.parent == a);
				});
			t("submenu steal unattached", function():*
				{
					const sub:NativeMenu = new NativeMenu();
					const i1:NativeMenuItem = new NativeMenuItem("1");
					const i2:NativeMenuItem = new NativeMenuItem("2");
					i1.submenu = sub;
					i2.submenu = sub;
					return i1.submenu + " " + (i2.submenu == sub);
				});
			t("remove item with sub then parent", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const sub:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = a.addSubmenu(sub, "1");
					a.removeAllItems();
					return sub.parent + " " + (i.submenu == sub);
				});

			// ContextMenu
			t("cm builtIn identity", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const b:ContextMenuBuiltInItems = cm.builtInItems;
					b.print = false;
					return (cm.builtInItems == b) + " " + cm.builtInItems.print + " " + cm.builtInItems.zoom;
				});
			t("cm hide", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.hideBuiltInItems();
					const b:ContextMenuBuiltInItems = cm.builtInItems;
					return b.print + " " + b.zoom + " " + b.quality + " " + b.save + " " + b.loop + " " + b.play + " " + b.rewind + " " + b.forwardAndBack;
				});
			t("cm clone builtIn", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.hideBuiltInItems();
					cm.builtInItems.zoom = true;
					const c:ContextMenu = ContextMenu(cm.clone());
					return c.builtInItems.zoom + " " + c.builtInItems.print + " " + c.builtInItems.quality;
				});
			t("cm clone builtIn default", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const c:ContextMenu = ContextMenu(cm.clone());
					return c.builtInItems.zoom + " " + c.builtInItems.print + " " + c.builtInItems.quality;
				});
			t("cm clone clip", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.clipboardItems.copy = true;
					cm.clipboardItems.selectAll = false;
					const c:ContextMenu = ContextMenu(cm.clone());
					return cm.clipboardItems.copy + " " + c.clipboardItems.copy + " " + c.clipboardItems.selectAll + " " + c.clipboardItems.paste;
				});
			t("cm clone items", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a", true, false, false);
					cm.customItems = [a, new NativeMenuItem("n")];
					const c:ContextMenu = ContextMenu(cm.clone());
					const ci:* = c.customItems[0];
					return labels(c) + " " + Object(ci).constructor + " " + ci.separatorBefore + " " + ci.enabled + " " + ci.visible + " menu=" + (ci.menu == c) + " " + Object(c.customItems[1]).constructor;
				});
			t("cm custom bad where", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					try
					{
						cm.customItems = [new ContextMenuItem("a"), 5];
					}
					catch (e:Error)
					{
						return "setter " + e.errorID + " " + cm.customItems.length;
					}

					return "ok " + cm.numItems;
				});
			t("cm custom push bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), 5, null);
					return cm.numItems + " " + cm.items.length + " " + cm.getItemAt(1) + " " + cm.getItemAt(2);
				});
			t("cm custom set menu", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					const m1:Boolean = a.menu == cm;
					cm.customItems = [];
					const m2:* = a.menu;
					return m1 + " " + m2;
				});
			t("cm custom set other", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = [a];
					return labels(n) + " " + labels(cm) + " " + (a.menu == cm) + " " + (a.menu == n);
				});
			t("cm custom in native", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					const n:NativeMenu = new NativeMenu();
					n.addItem(a);
					return labels(n) + " " + labels(cm) + " " + (a.menu == cm) + " " + (a.menu == n);
				});
			t("cm custom dup", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a, a];
					return labels(cm);
				});
			t("cm addItemAt 0", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = [new ContextMenuItem("a")];
					cm.addItemAt(new ContextMenuItem("b"), 0);
					return labels(cm);
				});
			t("cm addItem dup", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.addItem(a);
					cm.addItem(a);
					return labels(cm);
				});
			t("cm null args", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const out:Array = [];
					try
					{
						out.push(cm.containsItem(null));
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					try
					{
						out.push(cm.getItemIndex(null));
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					try
					{
						out.push(cm.removeItem(null));
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					try
					{
						out.push(cm.removeItem(new ContextMenuItem("z")));
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					try
					{
						out.push(cm.getItemAt(-1));
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					try
					{
						out.push(cm.getItemByName(null));
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					try
					{
						cm.items = null;
						out.push("items null ok " + cm.customItems);
					}
					catch (e:Error)
					{
						out.push(e.errorID);
					}

					return out.join(" ");
				});
			t("cm clone dataflow", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					a.data = 3;
					a.name = "nm";
					cm.customItems = [a];
					const c:ContextMenu = ContextMenu(cm.clone());
					return c.customItems[0].data + " " + c.customItems[0].name;
				});
			t("cm sub parent", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const sub:NativeMenu = new NativeMenu();
					const i:ContextMenuItem = new ContextMenuItem("s");
					i.submenu = sub;
					cm.customItems = [i];
					return sub.parent + " " + (i.menu == cm);
				});
			t("cm in submenu", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const cm:ContextMenu = new ContextMenu();
					n.addSubmenu(cm, "cm");
					return (cm.parent == n) + " " + labels(n);
				});
			t("cm parent", function():*
				{
					return new ContextMenu().parent;
				});
		}

		private function contextMenus():void
		{
			t("bi new", function():*
				{
					return bi(new ContextMenuBuiltInItems());
				});
			t("ci new", function():*
				{
					return ci(new ContextMenuClipboardItems());
				});
			t("cm bi", function():*
				{
					return bi(new ContextMenu().builtInItems);
				});
			t("cm ci", function():*
				{
					return ci(new ContextMenu().clipboardItems);
				});
			t("cm bi set sticks", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.builtInItems.zoom = true;
					cm.builtInItems.print = true;
					return bi(cm.builtInItems) + " " + (cm.builtInItems == cm.builtInItems);
				});
			t("cm bi assign", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const b:ContextMenuBuiltInItems = new ContextMenuBuiltInItems();
					b.zoom = true;
					cm.builtInItems = b;
					return (cm.builtInItems == b) + " " + bi(cm.builtInItems);
				});
			t("cm bi null", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.builtInItems = null;
					return cm.builtInItems;
				});
			t("cm ci assign", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const b:ContextMenuClipboardItems = new ContextMenuClipboardItems();
					cm.clipboardItems = b;
					return (cm.clipboardItems == b) + " " + ci(cm.clipboardItems);
				});
			t("cm ci null", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.clipboardItems = null;
					return cm.clipboardItems;
				});
			t("cm hide then clone", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.builtInItems.zoom = true;
					const c:ContextMenu = ContextMenu(cm.clone());
					return bi(c.builtInItems) + " " + ci(c.clipboardItems);
				});
			t("cm clone link", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const r:URLRequest = new URLRequest("http://a/");
					cm.link = r;
					const c:ContextMenu = ContextMenu(cm.clone());
					return (c.link ? c.link.url : null) + " " + (c.link == r);
				});
			t("cm custom fail keeps", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					const old:Array = [a];
					cm.customItems = old;
					const b:ContextMenuItem = new ContextMenuItem("b");
					try
					{
						cm.customItems = [b, 5];
					}
					catch (e:Error)
					{
						return "threw " + e.errorID + " same=" + (cm.customItems == old) + " " + labels(cm) + " a.menu=" + (a.menu == cm) + " b.menu=" + b.menu;
					}

					return "ok";
				});
			t("cm custom dup fail keeps", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					const old:Array = [a];
					cm.customItems = old;
					const b:ContextMenuItem = new ContextMenuItem("b");
					try
					{
						cm.customItems = [b, b];
					}
					catch (e:Error)
					{
						return "threw " + e.errorID + " same=" + (cm.customItems == old) + " " + labels(cm) + " a.menu=" + (a.menu == cm) + " b.menu=" + (b.menu == cm);
					}

					return "ok";
				});
			t("cm custom same twice", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					cm.customItems = [a];
					return labels(cm) + " " + (a.menu == cm);
				});
			t("cm custom same array", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					const arr:Array = [a];
					cm.customItems = arr;
					cm.customItems = arr;
					return labels(cm) + " " + (a.menu == cm);
				});
			t("cm custom other cm", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const cm2:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					cm2.customItems = [a];
					return "ok";
				});
			t("cm push null", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), null);
					return cm.numItems;
				});
			t("cm push null items", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), null);
					return cm.items.length;
				});
			t("cm push bad getItemAt", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), 5);
					return cm.getItemAt(0);
				});
			t("cm push bad items", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), 5);
					return cm.items.length;
				});
			t("cm push bad custom", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), 5);
					return cm.customItems.length;
				});
			t("cm push bad contains", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems.push(a, 5);
					return cm.containsItem(a);
				});
			t("cm push bad addItem", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(5);
					return cm.addItem(new ContextMenuItem("b"));
				});
			t("cm addItem in native", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					const cm:ContextMenu = new ContextMenu();
					cm.addItem(a);
					return labels(cm) + " " + labels(n) + " " + (a.menu == n);
				});
			t("cm removeItemAt menu", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					cm.removeItemAt(0);
					return a.menu;
				});
			t("cm removeAll menu", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					cm.removeAllItems();
					return a.menu;
				});
			t("cm items set in native", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					const cm:ContextMenu = new ContextMenu();
					cm.items = [a];
					return "ok";
				});
			t("cm addSubmenu ancestor", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					return cm.addSubmenu(cm, "self");
				});
			t("cm addSubmenu parent", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const sub:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = cm.addSubmenu(sub, "S");
					return (i.menu == cm) + " " + sub.parent;
				});
			t("cm clone subs", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const i:ContextMenuItem = new ContextMenuItem("s");
					const sub:NativeMenu = new NativeMenu();
					sub.addItem(new NativeMenuItem("deep"));
					i.submenu = sub;
					cm.customItems = [i];
					const c:ContextMenu = ContextMenu(cm.clone());
					const ci:NativeMenuItem = c.customItems[0];
					return (ci.submenu == sub) + " " + labels(ci.submenu) + " " + (ci.submenu.parent == c) + " " + ci.menu;
				});
			const mods:Array = [];
			for (var k:int = 0; k < 300; k++)
			{
				const i:NativeMenuItem = new NativeMenuItem("x");
				i.keyEquivalentModifiers = [k];
				if (i.keyEquivalentModifiers.length > 0)
				{
					mods.push(k + "=" + i.keyEquivalentModifiers);
				}
			}

			trace("valid mods " + mods.join(" "));
			t("mods neg", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalentModifiers = [-1, 4294967313, 273];
					return JSON.stringify(i.keyEquivalentModifiers);
				});
			t("mods objects", function():*
				{
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.keyEquivalentModifiers = [true, {valueOf: function():*
							{
								return 18;
							}}];
					return JSON.stringify(i.keyEquivalentModifiers);
				});
		}

		private function more():void
		{
			t("clone menu sep", function():*
				{
					const n:NativeMenu = new NativeMenu();
					n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("s", true));
					const c:NativeMenu = n.clone();
					return labels(c) + " " + c.getItemAt(1).isSeparator;
				});
			t("cm clone sep", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = [new ContextMenuItem("a"), new NativeMenuItem("s", true)];
					const c:ContextMenu = ContextMenu(cm.clone());
					return labels(c) + " " + c.customItems[1].isSeparator;
				});
			const s:Sprite = new Sprite();
			addChild(s);
			s.addEventListener(MouseEvent.CLICK, function(e:MouseEvent):void
			{
				t("dcms target", function():*
					{
						const cm:ContextMenu = new ContextMenu();
						var r:String = "";
						cm.addEventListener(ContextMenuEvent.MENU_SELECT, function(ev:ContextMenuEvent):void
						{
							r = (ev.mouseTarget == s) + " " + (ev.contextMenuOwner == s) + " " + ev.mouseTarget + " " + ev.contextMenuOwner + " " + ev.isMouseTargetInaccessible;
						});
						cm.dispatchContextMenuSelect(e);
						return r;
					});
			});
			s.dispatchEvent(new MouseEvent(MouseEvent.CLICK));
			t("cm custom null element", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems = [new ContextMenuItem("a"), null];
					return labels(cm);
				});
			t("cm addItem own", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems = [a];
					cm.addItem(a);
					return labels(cm);
				});
			t("cm numItems bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), 5);
					return cm.numItems;
				});
			t("cm getItemAt bad elem", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(new ContextMenuItem("a"), 5);
					return cm.getItemAt(1);
				});
			t("cm getItemIndex bad", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const a:ContextMenuItem = new ContextMenuItem("a");
					cm.customItems.push(5, a);
					return cm.getItemIndex(a);
				});
			t("cm removeItemAt bad elem", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					cm.customItems.push(5);
					return cm.removeItemAt(0);
				});
			t("setItemIndex range state", function():*
				{
					const n:NativeMenu = new NativeMenu();
					const a:NativeMenuItem = n.addItem(new NativeMenuItem("a"));
					n.addItem(new NativeMenuItem("b"));
					try
					{
						n.setItemIndex(a, 2);
					}
					catch (e:Error)
					{
						return e.errorID + " " + labels(n) + " " + a.menu;
					}

					return "ok";
				});
			t("addItemAt ancestor ret", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const b:NativeMenu = new NativeMenu();
					a.addSubmenu(b, "B");
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.submenu = a;
					const r:* = b.addItemAt(i, 0);
					return r + " " + i.menu;
				});
			t("addItemAt ancestor bad index", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.submenu = a;
					return a.addItemAt(i, 5);
				});
			t("addItemAt ancestor in menu", function():*
				{
					const a:NativeMenu = new NativeMenu();
					const other:NativeMenu = new NativeMenu();
					const i:NativeMenuItem = other.addItem(new NativeMenuItem("x"));
					i.submenu = a;
					return a.addItemAt(i, 0);
				});
			t("select event", function():*
				{
					return new NativeMenuItem("x").hasEventListener("select");
				});
			t("cmitem caption null", function():*
				{
					const c:ContextMenuItem = new ContextMenuItem(null);
					return JSON.stringify(c.caption) + " " + JSON.stringify(c.label);
				});
			t("nm item in cm via addSubmenu cycle", function():*
				{
					const cm:ContextMenu = new ContextMenu();
					const n:NativeMenu = new NativeMenu();
					n.addSubmenu(cm, "cm");
					cm.customItems = [];
					const i:NativeMenuItem = new NativeMenuItem("x");
					i.submenu = n;
					cm.customItems = [i];
					return labels(cm) + " " + i.menu + " " + n.parent;
				});
		}
	}
}
