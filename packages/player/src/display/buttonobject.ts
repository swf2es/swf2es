// A SimpleButton, and the making of its four states from DefineButton's records.
import {
  BUTTON_DOWN,
  BUTTON_HIT_TEST,
  BUTTON_OVER,
  BUTTON_UP,
  type ButtonRecord,
  type Place,
} from "@swf2es/format";
import { Container } from "./container.js";
import {
  BUTTON,
  CHILDREN,
  type DisplayObject,
  NO_CHILDREN,
  pickWork,
  scriptWork,
} from "./displayobject.js";
import { displayFor } from "./instantiate.js";
import type { ButtonCharacter, DisplayCharacter, Library } from "./timeline.js";

/** The state a button shows, as the pointer has it. */
export type ButtonState = "up" | "over" | "down";

/**
 * Which of DefineButtonSound's sounds a change of state plays, by the
 * state before and after, as Ruffle's button events pick them; none is -1.
 * A drag off while pressed, which shows over, and back on, down again,
 * play none either, as Ruffle's DragOut and DragOver: the pointer asks
 * those quietly. A release outside plays over to up's
 * (ButtonObject.releasedOutside).
 */
const BUTTON_SOUNDS: Record<ButtonState, Record<ButtonState, number>> = {
  up: { up: -1, over: 1, down: -1 },
  over: { up: 0, over: -1, down: 2 },
  down: { up: -1, over: 3, down: -1 },
};

/**
 * A button (SimpleButton): four states, each a display object, of which it
 * shows the up, over or down one, as the pointer has it, and hit tests with
 * the fourth. The state it shows is its one child, which it is drawn and
 * bounded by; the others are its own, off the display list, but each has
 * its frames as Flash's do (`frameChildren`). Not a container to a script.
 */
export class ButtonObject extends Container {
  private up: DisplayObject | null = null;
  private over: DisplayObject | null = null;
  private down: DisplayObject | null = null;
  private hitTest: DisplayObject | null = null;
  state: ButtonState = "up";
  private firstOrder = false;
  enabled = true;
  useHandCursor = true;
  trackAsMenu = false;

  constructor() {
    super();
    this.kind = BUTTON;
    this.frameChildren = NO_CHILDREN;
  }

  get upState(): DisplayObject | null {
    return this.up;
  }

  set upState(d: DisplayObject | null) {
    this.up = d;
    this.statesChanged();
  }

  get overState(): DisplayObject | null {
    return this.over;
  }

  set overState(d: DisplayObject | null) {
    this.over = d;
    this.statesChanged();
  }

  get downState(): DisplayObject | null {
    return this.down;
  }

  set downState(d: DisplayObject | null) {
    this.down = d;
    this.statesChanged();
  }

  get hitTestState(): DisplayObject | null {
    return this.hitTest;
  }

  set hitTestState(d: DisplayObject | null) {
    this.hitTest = d;
    // Where it is hit, which no change in the display list tells the pointer.
    pickWork.changes++;
    this.statesChanged();
  }

  /**
   * Its frame children made again from the states it has now, each once,
   * as Ruffle orders them, the hit test state first, whichever it shows: a
   * new list, so that none it let go of stays held.
   */
  private statesChanged(): void {
    // A state that holds the button plays as its parent's child, not as the button's.
    const states = [this.hitTest, this.up, this.down, this.over].filter(
      (o, i, all): o is DisplayObject => o !== null && all.indexOf(o) === i && !o.encloses(this),
    );
    this.frameChildren = states.length > 0 ? states : NO_CHILDREN;
    scriptWork.changes++;
  }

  /**
   * Its frame children but any that has since come to hold it, as a state
   * off the list a script then put the button in: a walk down them would
   * come back to it.
   */
  playingStates(): readonly DisplayObject[] {
    const states = this.frameChildren;
    for (let i = 0; i < states.length; i++) {
      if (states[i].encloses(this)) {
        return states.filter((o) => !o.encloses(this));
      }
    }

    return states;
  }

  /** Its states' next frame scripts run up, over, down, hit: the first, in a SWF after 9 (Scripting.construct). */
  get firstScripts(): boolean {
    return this.firstOrder;
  }

  set firstScripts(first: boolean) {
    if (first !== this.firstOrder) {
      this.firstOrder = first;
      scriptWork.changes++;
    }
  }

  /** The display object of state `state`. */
  stateObject(state: ButtonState): DisplayObject | null {
    return state === "up" ? this.upState : state === "over" ? this.overState : this.downState;
  }

  /** Show state `state`, with the sound DefineButtonSound gives the change. */
  setState(state: ButtonState, sound = true): void {
    if (sound) {
      this.playSound(BUTTON_SOUNDS[this.state][state]);
    }

    this.state = state;
    this.show();
  }

  /** A press on it released elsewhere: up, with over to up's sound, as Ruffle's ReleaseOutside plays. */
  releasedOutside(): void {
    this.playSound(0);
    this.setState("up", false);
  }

  /** DefineButtonSound's sound `index`, if it has one. */
  private playSound(index: number): void {
    const sounds = this.character?.type === "button" ? this.character.sounds : null;
    const sound = sounds?.[index];
    const library = this.library;
    if (sound && library) {
      library.sounds?.start(this, library, sound.id, sound.info);
    }
  }

  /**
   * Have the state it is in be its one child, as it is now. The states it
   * does not show are parented to nothing, as Flash has them once made.
   */
  show(): void {
    const current = this.stateObject(this.state);
    for (const child of [...this.children]) {
      if (child !== current) {
        this.removeChild(child);
      }
    }

    for (const state of [this.upState, this.overState, this.downState, this.hitTestState]) {
      if (state && state !== current && state.parent === this && !this.children.includes(state)) {
        state.parent = null;
      }
    }

    // One that holds the button cannot be its child, as Flash refuses it (#2150): the button
    // shows nothing, and it stays where it is.
    if (current && !this.children.includes(current) && !current.encloses(this)) {
      if (current.parent !== this) {
        current.parent?.removeChild(current);
      }

      this.children.splice(0, 0, current);
      this.puts++;
      current.parent = this;
      this.relist(current);
      this.invalidate(CHILDREN);
      scriptWork.changes++;
    }
  }
}

/**
 * Make a button's states from its records, as Flash does when the button
 * is made, up, over, down, then hit test: each state the one character it
 * shows, else a container of its characters by depth, one for none too. A
 * character in several states is made once for each. `made` brings a
 * character to life once placed, and `holderMade` each container, once all
 * four states' characters are, as Flash names them after those; the hit
 * test state takes only the records' transforms.
 */
export function buttonStates(
  button: ButtonObject,
  character: ButtonCharacter,
  library: Library,
  made: (display: DisplayObject, character: DisplayCharacter) => void,
  holderMade: (holder: Container) => void,
): void {
  const holders: Container[] = [];
  const state = (flag: number): DisplayObject => {
    const parts: { display: DisplayObject; character: DisplayCharacter; record: ButtonRecord }[] =
      [];
    for (const record of character.records) {
      const c = record.states & flag ? library.characters.get(record.character) : undefined;
      if (
        c &&
        c.type !== "binary" &&
        c.type !== "font" &&
        c.type !== "fontCff" &&
        c.type !== "sound"
      ) {
        const display = displayFor(c, library);
        display.applyPlace(recordPlace(record, flag !== BUTTON_HIT_TEST));
        parts.push({ display, character: c, record });
      }
    }

    // Made as the button's, under it, though in no container's list: a
    // script sees the stage from them, and no parent above them.
    if (parts.length === 1) {
      parts[0].display.parent = button;
      made(parts[0].display, parts[0].character);
      return parts[0].display;
    }

    const holder = new Container();
    holder.parent = button;
    for (const part of parts) {
      holder.placeAtDepth(part.display, part.record.depth);
      made(part.display, part.character);
    }

    holders.push(holder);
    return holder;
  };

  button.upState = state(BUTTON_UP);
  button.overState = state(BUTTON_OVER);
  button.downState = state(BUTTON_DOWN);
  button.hitTestState = state(BUTTON_HIT_TEST);
  for (const holder of holders) {
    holderMade(holder);
  }

  button.show();
}

/** A button record as a place of its character: its transform, and, but in the hit test state, its look. */
function recordPlace(record: ButtonRecord, look: boolean): Place {
  return {
    depth: record.depth,
    move: false,
    character: record.character,
    matrix: record.matrix,
    colorTransform: look ? record.colorTransform : null,
    ratio: null,
    name: null,
    clipDepth: null,
    className: null,
    hasImage: false,
    blendMode: look ? record.blendMode : null,
    cacheAsBitmap: null,
    visible: null,
    opaqueBackground: null,
    filters: look ? record.filters : null,
    actions: null,
    corrupt: 0,
  };
}
