import * as THREE from 'three';
import { Rng, makeNoise2D } from './Rng.js';
import { EventBus } from './EventBus.js';
import { Input } from './Input.js';

/**
 * Minimal system-registry engine.
 *
 * A "system" is any object with { name, order?, init?(ctx), update?(dt, ctx), postUpdate?(dt, ctx) }.
 * Systems never import each other — they resolve peers at runtime via ctx.get('name') and
 * communicate via ctx.bus. That is what lets several builder agents own disjoint
 * directories without merge conflicts.
 *
 * The loop is fixed-timestep. In ?capture=1 mode the rAF loop never starts and the
 * capture harness drives Game.advance() by hand, so a given seed + a given number of
 * simulated seconds always produces a byte-comparable frame.
 */

export const ORDER = {
  WORLD: 10, SKY: 20, PLAYER: 30, CREATURES: 40, AI: 50,
  INTERACTION: 60,
  // Loadout runs before the things it gates, so a slot change lands on the same frame
  // the player pressed it. Spheres and weapons then read an already-settled hand.
  LOADOUT: 62, SPHERES: 64, WEAPONS: 66,
  UI: 80, AUDIO: 90, POST: 100,
};

export class Game {
  constructor({ container, seed = 20240719, capture = false } = {}) {
    this.container = container;
    this.seed = seed;
    this.captureMode = capture;
    this.systems = [];
    this._byName = new Map();
    this.elapsed = 0;
    this.frame = 0;
    this.running = false;
    this.fixedDt = 1 / 60;
    this._accum = 0;
    this._lastNow = 0;
    this.timeScale = 1;

    this.bus = new EventBus();
    this.rng = new Rng(seed);
    this.noise = makeNoise2D(seed);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 4000);
    this.camera.position.set(0, 6, 12);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // needed so the capture harness can read the framebuffer after a manual render
      preserveDrawingBuffer: capture,
    });
    this.renderer.setPixelRatio(capture ? 1 : Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.input = new Input(this.renderer.domElement);
    if (capture) this.input.setScripted(true);

    this.quality = this._detectQuality();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    /** shared context handed to every system */
    this.ctx = {
      THREE, game: this, scene: this.scene, camera: this.camera, renderer: this.renderer,
      bus: this.bus, rng: this.rng, noise: this.noise, input: this.input,
      quality: this.quality, seed,
      get: (n) => this.get(n),
      elapsed: 0, frame: 0,
    };
  }

  _detectQuality() {
    if (this.captureMode) {
      // Software rasterisation in the critic harness: keep the *look* identical,
      // only trim counts that cost fill-rate, so A/B captures stay honest.
      return { tier: 'capture', shadowMapSize: 2048, grassDensity: 0.55, drawDistance: 900, post: true };
    }
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const soft = /swiftshader|llvmpipe|software|angle \(google/i.test(name);
    if (soft) return { tier: 'low', shadowMapSize: 1024, grassDensity: 0.35, drawDistance: 600, post: false };
    return { tier: 'high', shadowMapSize: 2048, grassDensity: 1.0, drawDistance: 1400, post: true };
  }

  register(system) {
    if (!system?.name) throw new Error('system needs a name');
    system.order = system.order ?? 50;
    this.systems.push(system);
    this._byName.set(system.name, system);
    this.systems.sort((a, b) => a.order - b.order);
    return system;
  }

  get(name) { return this._byName.get(name); }

  async init(onProgress = () => {}) {
    const list = [...this.systems];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      onProgress(i / list.length, s.name);
      if (s.init) await s.init(this.ctx);
    }
    onProgress(1, 'ready');
    this.bus.emit('game:ready');
    return this;
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.bus.emit('resize', { w, h });
  }

  /** one fixed simulation step (no render) */
  step(dt = this.fixedDt) {
    this.ctx.dt = dt;
    this.elapsed += dt;
    this.frame++;
    this.ctx.elapsed = this.elapsed;
    this.ctx.frame = this.frame;
    for (const s of this.systems) if (s.update) s.update(dt, this.ctx);
    for (const s of this.systems) if (s.postUpdate) s.postUpdate(dt, this.ctx);
    this.input.flushTaps();
    this.input.endFrame();
  }

  render() {
    const post = this.get('post');
    if (post?.render) post.render(this.ctx);
    else this.renderer.render(this.scene, this.camera);
  }

  /** deterministic advance used by the capture harness */
  advance(seconds, dt = this.fixedDt) {
    const n = Math.max(1, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) this.step(dt);
    return n;
  }

  start() {
    if (this.captureMode || this.running) return;
    this.running = true;
    this._lastNow = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(tick);
      let delta = Math.min(0.25, (now - this._lastNow) / 1000) * this.timeScale;
      this._lastNow = now;
      this._accum += delta;
      let guard = 0;
      while (this._accum >= this.fixedDt && guard++ < 5) {
        this.step(this.fixedDt);
        this._accum -= this.fixedDt;
      }
      this.render();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf); }
}
