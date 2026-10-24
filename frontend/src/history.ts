/** Undo/redo over immutable values. */
export class History<T> {
  #past: T[] = [];
  #future: T[] = [];
  #present: T;
  readonly #limit: number;

  constructor(present: T, limit = 200) {
    this.#present = present;
    this.#limit = limit;
  }

  get present(): T {
    return this.#present;
  }

  get canUndo(): boolean {
    return this.#past.length > 0;
  }

  get canRedo(): boolean {
    return this.#future.length > 0;
  }

  /** Make `next` the present; it can be undone. A value identical to the present is ignored. */
  commit(next: T): boolean {
    if (next === this.#present) return false;
    this.#past.push(this.#present);
    if (this.#past.length > this.#limit) this.#past.shift();
    this.#present = next;
    this.#future = [];
    return true;
  }

  undo(): T | undefined {
    const prev = this.#past.pop();
    if (prev === undefined) return undefined;
    this.#future.push(this.#present);
    this.#present = prev;
    return prev;
  }

  redo(): T | undefined {
    const next = this.#future.pop();
    if (next === undefined) return undefined;
    this.#past.push(this.#present);
    this.#present = next;
    return next;
  }

  /** Start over from `present`, forgetting the history (another plan was loaded). */
  reset(present: T): void {
    this.#past = [];
    this.#future = [];
    this.#present = present;
  }
}
