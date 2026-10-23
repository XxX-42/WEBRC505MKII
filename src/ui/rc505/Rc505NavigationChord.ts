export type Rc505NavigationKey = 'ENTER' | 'EXIT';

/** Defer individual navigation until release so a simultaneous chord executes once. */
export class Rc505NavigationChord {
  private readonly held = new Set<Rc505NavigationKey>();
  private consumed = false;
  public press(key: Rc505NavigationKey): boolean {
    if (this.held.has(key)) return false;
    this.held.add(key);
    if (this.held.size !== 2 || this.consumed) return false;
    this.consumed = true;
    return true;
  }
  public release(key: Rc505NavigationKey): Rc505NavigationKey | null {
    const existed = this.held.delete(key);
    const action = existed && !this.consumed ? key : null;
    if (this.held.size === 0) this.consumed = false;
    return action;
  }
  public cancel(key?: Rc505NavigationKey): void {
    if (key) this.held.delete(key); else this.held.clear();
    this.consumed = this.held.size > 0;
  }
}
