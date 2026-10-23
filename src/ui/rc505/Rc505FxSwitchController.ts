import type { Rc505FxSlot } from './Rc505FxControlStateMachine';

export type Rc505FxSwitchMode = 'TOGGLE' | 'MOMENT';
export type Rc505FxBankMode = 'SINGLE' | 'MULTI';
export interface Rc505FxSwitchSettings {
  mode: Rc505FxBankMode;
  switchModes: Record<Rc505FxSlot, Rc505FxSwitchMode>;
}
export interface Rc505FxSwitchWrite { slot: Rc505FxSlot; active: boolean }
const slots: Rc505FxSlot[] = ['A', 'B', 'C', 'D'];

export function defaultRc505FxSwitchSettings(): Rc505FxSwitchSettings {
  // Preserve the existing software bank's multi-effect behavior on migration.
  return { mode: 'MULTI', switchModes: { A: 'TOGGLE', B: 'TOGGLE', C: 'TOGGLE', D: 'TOGGLE' } };
}

/** Physical holds are intent only. The runtime readback alone drives LEDs. */
export class Rc505FxSwitchController {
  private readonly held = new Set<Rc505FxSlot>();
  public get isHeld(): boolean { return this.held.size !== 0; }

  public press(slot: Rc505FxSlot, settings: Rc505FxSwitchSettings,
    active: Readonly<Record<Rc505FxSlot, boolean>>): { writes: Rc505FxSwitchWrite[]; reason?: string } {
    if (this.held.has(slot)) return { writes: [] };
    if (settings.mode === 'SINGLE' && this.held.size > 0) {
      return { writes: [], reason: 'Overlapping SINGLE/MOMENT holds require hardware verification.' };
    }
    const moment = settings.switchModes[slot] === 'MOMENT';
    const next = moment || !active[slot];
    const writes: Rc505FxSwitchWrite[] = [];
    if (next && settings.mode === 'SINGLE') {
      for (const other of slots) if (other !== slot && active[other]) writes.push({ slot: other, active: false });
    }
    if (moment) this.held.add(slot);
    writes.push({ slot, active: next });
    return { writes };
  }

  public release(slot: Rc505FxSlot): Rc505FxSwitchWrite[] {
    return this.held.delete(slot) ? [{ slot, active: false }] : [];
  }

  public cancel(): Rc505FxSwitchWrite[] {
    const writes = [...this.held].map((slot) => ({ slot, active: false }));
    this.held.clear();
    return writes;
  }
}
