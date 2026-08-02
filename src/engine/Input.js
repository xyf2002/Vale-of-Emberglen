// Input is an *abstract action state*, never raw keycodes, so the capture harness
// can drive the game headlessly with the exact same code path a human uses.

const DEFAULT_BINDINGS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  ShiftLeft: 'sprint', ShiftRight: 'sprint',
  Space: 'jump',
  KeyE: 'interact',
  KeyF: 'offer',
  KeyQ: 'call',
  KeyC: 'crouch',
  KeyR: 'throw',
  KeyJ: 'journal',
  Tab: 'journal',
  KeyM: 'mute',
};

export class Input {
  constructor(el) {
    this.el = el;
    this.actions = Object.create(null);   // action -> bool held
    this.pressed = Object.create(null);   // action -> true for exactly one frame
    this.released = Object.create(null);
    this.look = { dx: 0, dy: 0 };         // consumed each frame
    this.wheel = 0;
    this.pointerLocked = false;
    this.scripted = false;                // true when the harness owns input
    this.bindings = { ...DEFAULT_BINDINGS };
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (this.scripted) return;
      const a = this.bindings[e.code];
      if (!a) return;
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!this.actions[a]) this.pressed[a] = true;
      this.actions[a] = true;
    };
    const ku = (e) => {
      if (this.scripted) return;
      const a = this.bindings[e.code]; if (!a) return;
      this.actions[a] = false; this.released[a] = true;
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.actions = Object.create(null); });

    this.el.addEventListener('click', () => {
      if (this.scripted) return;
      if (!this.pointerLocked) this.el.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.el;
    });
    window.addEventListener('mousemove', (e) => {
      if (this.scripted) return;
      if (this.pointerLocked) { this.look.dx += e.movementX; this.look.dy += e.movementY; }
    });
    window.addEventListener('wheel', (e) => { if (!this.scripted) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('mousedown', (e) => {
      if (this.scripted || !this.pointerLocked) return;
      const a = e.button === 0 ? 'throw' : 'aim';
      if (!this.actions[a]) this.pressed[a] = true;
      this.actions[a] = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (this.scripted || !this.pointerLocked) return;
      const a = e.button === 0 ? 'throw' : 'aim';
      this.actions[a] = false; this.released[a] = true;
    });
  }

  down(a) { return !!this.actions[a]; }
  justPressed(a) { return !!this.pressed[a]; }
  justReleased(a) { return !!this.released[a]; }

  /** movement vector in local space, length <= 1 */
  moveAxis() {
    const x = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    const y = (this.down('forward') ? 1 : 0) - (this.down('back') ? 1 : 0);
    const l = Math.hypot(x, y);
    return l > 1 ? { x: x / l, y: y / l } : { x, y };
  }

  endFrame() {
    this.pressed = Object.create(null);
    this.released = Object.create(null);
    this.look.dx = 0; this.look.dy = 0; this.wheel = 0;
  }

  // ---- scripted-input API used by tools/capture.mjs -------------------------
  setScripted(on) { this.scripted = on; this.actions = Object.create(null); }
  set(a, down) {
    if (down && !this.actions[a]) this.pressed[a] = true;
    if (!down && this.actions[a]) this.released[a] = true;
    this.actions[a] = !!down;
  }
  tap(a) { this.set(a, true); this._pendingRelease = this._pendingRelease || []; this._pendingRelease.push(a); }
  flushTaps() { if (this._pendingRelease) { for (const a of this._pendingRelease) this.actions[a] = false; this._pendingRelease = null; } }
  addLook(dx, dy) { this.look.dx += dx; this.look.dy += dy; }
}
