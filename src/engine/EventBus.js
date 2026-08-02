/** Tiny pub/sub. Systems talk through this instead of importing each other. */
export class EventBus {
  constructor() { this._h = new Map(); this.log = []; }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) { const off = this.on(evt, (...a) => { off(); fn(...a); }); return off; }
  off(evt, fn) { this._h.get(evt)?.delete(fn); }
  emit(evt, payload) {
    // keep a short tail for the capture harness / critics to assert on
    this.log.push({ evt, payload, t: performance.now() });
    if (this.log.length > 400) this.log.shift();
    const hs = this._h.get(evt); if (hs) for (const fn of [...hs]) fn(payload, evt);
    const stars = this._h.get('*'); if (stars) for (const fn of [...stars]) fn(payload, evt);
  }
}
