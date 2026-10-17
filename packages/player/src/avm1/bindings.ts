// Text fields bound to AVM1 variables, as Ruffle's (https://github.com/
// ruffle-rs/ruffle) core/src/display_object/edit_text.rs
// (try_bind_text_field_variable, propagate_text_binding, set_variable) and
// display_object.rs (Avm1TextFieldBinding) have them: MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors. A field's
// variable is a name, or a path and a name, from the clip the field is in.
// Where it names a display object's property, the field is bound: a set of
// the property shows in the field. A field's text set by a script sets the
// variable, wherever its path leads then. A field whose variable has no
// object yet waits, and is tried again as each display object is made.
import { avm1 } from "@swf2es/runtime";
import {
  ButtonObject,
  CONTENT,
  type DisplayObject,
  MovieClip,
  TextObject,
} from "../display/display.js";
import { htmlTextOf, setHtmlText, stateOf } from "./globals/TextField.js";

/** What the bindings need of the movie. */
export interface BindingHost {
  readonly version: number;
  /** `body` run in an activation of `d`, as `d`'s code would run; not where the movie has halted. */
  inActivation(d: DisplayObject, body: (cx: avm1.Activation) => void): void;
}

export class VariableBindings {
  /** The fields bound to each display object's properties, by the property's name. */
  private readonly bound = new WeakMap<DisplayObject, { field: TextObject; name: string }[]>();
  /** What each bound field is bound to. */
  private readonly boundTo = new WeakMap<TextObject, DisplayObject>();
  /** The fields whose variable's object is not there yet. */
  private waiting: TextObject[] = [];
  /** The fields whose text their variable is taking. */
  private readonly propagating = new Set<TextObject>();

  constructor(private readonly host: BindingHost) {}

  /** A field made: bound, taking its variable's value, or waiting. */
  made(field: TextObject): void {
    if (!this.bind(field, true)) {
      this.waiting.push(field);
    }
  }

  /** A display object made: the fields waiting for one tried again. */
  retry(): void {
    if (this.waiting.length > 0) {
      this.waiting = this.waiting.filter((field) => !this.bind(field, false));
    }
  }

  /**
   * A field's text changed by a script: the variable takes it, as HTML,
   * its path resolved again; not again while it is taking it.
   */
  textChanged(field: TextObject): void {
    const variable = stateOf(field).variable;
    const parent = parentOf(field);
    if (variable === null || parent === null || this.propagating.has(field)) {
      return;
    }

    this.propagating.add(field);
    try {
      this.host.inActivation(parent, (cx) => {
        const found = variablePath(cx, parent, variable, this.host.version);
        if (found !== null) {
          avm1.set(found[0], found[1], htmlTextOf(field), this.host.version);
        }
      });
    } finally {
      this.propagating.delete(field);
    }
  }

  /** A field's variable set: its binding cleared, its text its tag's again, and bound where it can be now. */
  variableChanged(field: TextObject): void {
    this.unbindField(field);
    field.model.setText(field.definition?.definition?.text ?? "");
    field.invalidate(CONTENT);
    field.fit();
    this.bind(field, true);
  }

  /** A property of `d`'s AVM1 object set: the fields bound to it by the name show the value. */
  propertyChanged(d: DisplayObject, name: string, value: avm1.Value, version: number): void {
    const list = this.bound.get(d);
    if (list === undefined) {
      return;
    }

    const key = version > 6 ? name : avm1.fold(name);
    for (const { field, name: bound } of [...list]) {
      if ((version > 6 ? bound : avm1.fold(bound)) === key) {
        setHtmlText(field, avm1.stringOf(value, version));
      }
    }
  }

  /**
   * `d` unloaded: a field no longer bound nor waiting, and the fields bound
   * to `d`'s properties waiting again, for an object at its path.
   */
  unloaded(d: DisplayObject): void {
    if (d instanceof TextObject) {
      this.unbindField(d);
    }

    const list = this.bound.get(d);
    if (list !== undefined) {
      this.bound.delete(d);
      for (const { field } of list) {
        this.boundTo.delete(field);
        this.waiting.push(field);
      }
    }
  }

  /**
   * Bind a field to its variable: where `initial`, the field takes the
   * variable's value, or, where it has none, a field with text gives it
   * its text. Whether it is bound, which it is only to a display object's
   * property; a field without a variable is as good as bound.
   */
  private bind(field: TextObject, initial: boolean): boolean {
    const variable = stateOf(field).variable;
    if (variable === null) {
      return true;
    }

    const parent = parentOf(field);
    if (parent === null) {
      return false;
    }

    let bound = false;
    const version = this.host.version;
    this.host.inActivation(parent, (cx) => {
      const found = variablePath(cx, parent, variable, version);
      if (found === null) {
        return;
      }

      const [object, name] = found;
      if (initial) {
        if (avm1.has(object, name, version)) {
          setHtmlText(field, avm1.stringOf(avm1.get(object, name, version), version));
        } else if (field.model.text !== "") {
          avm1.set(object, name, field.model.text, version);
        }
      }

      const target = object.display?.target as DisplayObject | undefined;
      if (target !== undefined) {
        let list = this.bound.get(target);
        if (list === undefined) {
          list = [];
          this.bound.set(target, list);
        }

        list.push({ field, name });
        this.boundTo.set(field, target);
        bound = true;
      }
    });
    return bound;
  }

  /** A field's binding cleared, and the field no longer waiting for one. */
  private unbindField(field: TextObject): void {
    const target = this.boundTo.get(field);
    if (target !== undefined) {
      this.boundTo.delete(field);
      const list = this.bound.get(target);
      if (list !== undefined) {
        this.bound.set(
          target,
          list.filter((b) => b.field !== field),
        );
      }
    }

    const at = this.waiting.indexOf(field);
    if (at >= 0) {
      this.waiting.splice(at, 1);
    }
  }
}

/** The clip a field's variable is resolved from: its parent, past any button. */
function parentOf(field: TextObject): DisplayObject | null {
  let parent: DisplayObject | null = field.parent;
  while (parent instanceof ButtonObject) {
    parent = parent.parent;
  }

  return parent instanceof MovieClip && parent.avm1 !== null ? parent : null;
}

/**
 * A variable's object and name: a path's object, up to its last `.` or
 * `:`, resolved along the scope chain, and the name after it; a name
 * alone is `parent`'s (Ruffle's resolve_variable_path).
 */
function variablePath(
  cx: avm1.Activation,
  parent: DisplayObject,
  path: string,
  version: number,
): [avm1.Avm1Object, string] | null {
  const separator = Math.max(path.lastIndexOf(":"), path.lastIndexOf("."));
  if (separator < 0) {
    return parent.avm1 === null ? null : [parent.avm1, path];
  }

  const name = path.slice(separator + 1);
  for (let s: avm1.Scope | null = cx.scope; s !== null; s = s.parent) {
    const object = avm1.targetPath(cx, s.object, path.slice(0, separator), true, true, version);
    if (object !== null) {
      return [object, name];
    }
  }

  return null;
}
