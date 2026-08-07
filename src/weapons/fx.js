import * as THREE from 'three';

/**
 * WEAPON FX — the evidence a shot happened.
 *
 * The thing GTA gets right that most third-person shooters do not is that a single
 * trigger pull produces FOUR separate pieces of evidence, each on its own clock:
 *
 *   0.00-0.06 s  muzzle flash + a stab of light on the world
 *   0.00-0.15 s  a tracer streak leaving the barrel and travelling
 *   0.05-1.20 s  a brass case tumbling out of the port and landing
 *   on arrival    a surface-aware impact: dust, chips, a puff of turf
 *
 * If any one of those is missing the shot reads as a UI event rather than a physical
 * one. So all four are here, all four are pooled and allocated exactly once, and all
 * four are driven off the simulation's dt so a headless capture of the same seed and
 * the same simulated seconds reproduces them frame for frame.
 *
 * Budget: five draw calls total when everything is live (flash, tracers, cases, two
 * particle pools), and every one of them sets `visible = false` when its pool is empty,
 * so a player with a sphere in hand pays nothing at all.
 */

const POINT_VS = /* glsl */`
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vCol;
varying float vAlpha;
void main() {
  vCol = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (520.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FS = /* glsl */`
varying vec3 vCol;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  if (vAlpha <= 0.002) discard;
  float a = smoothstep(0.25, 0.03, r2);
  gl_FragColor = vec4(vCol, a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** fixed-size CPU particle pool, one THREE.Points draw call */
class Pool {
  constructor(scene, count, { additive = false, order = 11 } = {}) {
    this.count = count; this.head = 0; this.live = 0;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) pos[i * 3 + 1] = -9999;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(count), 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VS, fragmentShader: POINT_FS,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = order;
    this.points.visible = false;
    this.points.name = additive ? 'weapon_sparks' : 'weapon_debris';
    scene.add(this.points);
    this.geo = geo;
    this.pos = pos;
    this.col = geo.attributes.aColor.array;
    this.size = geo.attributes.aSize.array;
    this.alpha = geo.attributes.aAlpha.array;
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.base = new Float32Array(count);
    this.grav = new Float32Array(count);
    this.drag = new Float32Array(count);
  }

  emit(x, y, z, vx, vy, vz, r, g, b, size, life, gravity = -9.0, drag = 1.6) {
    const i = this.head; this.head = (this.head + 1) % this.count;
    if (this.life[i] <= 0) this.live++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.base[i] = size; this.size[i] = size; this.alpha[i] = 1;
    this.life[i] = life; this.maxLife[i] = life;
    this.grav[i] = gravity; this.drag[i] = drag;
  }

  update(dt) {
    if (this.live <= 0) { if (this.points.visible) this.points.visible = false; return; }
    let live = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; this.pos[i * 3 + 1] = -9999; continue; }
      live++;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k + this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.alpha[i] = t * t;
      this.size[i] = this.base[i] * (0.55 + 0.45 * t);
    }
    this.live = live;
    this.points.visible = live > 0;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }
}

/**
 * SURFACE RESPONSE TABLE.
 *
 * "Surface-aware" has to mean the player can tell what they hit with the sound off and
 * the crosshair somewhere else. Dirt throws a slow brown clod that arcs; stone throws
 * fast pale chips and a spray of sparks; turf throws green flecks that barely leave the
 * ground; water throws a white crown with no sparks at all.
 *
 * `creature` used to be the odd one out: a warm pale bloom and a few motes of shed
 * fluff, nothing red, because a gun here only tired an animal out. r15 changed the
 * brief — the owner asked for a visible spray on a hit and for creatures that can die —
 * so this surface now throws a proper burst: more particles, faster, with a deep red
 * core under the warm fluff. It is still a stylised spray and not gore; the palette is
 * two reds and the same shed-fur cream, and it is gone in under half a second.
 */
const SURFACES = {
  dirt:     { dust: [0.34, 0.28, 0.20], chips: [0.26, 0.21, 0.15], n: 14, sparks: 0, speed: 3.4, size: 0.22, life: 0.75, gravity: -9.5 },
  grass:    { dust: [0.30, 0.31, 0.18], chips: [0.32, 0.42, 0.16], n: 12, sparks: 0, speed: 3.0, size: 0.19, life: 0.62, gravity: -9.0 },
  sand:     { dust: [0.62, 0.55, 0.40], chips: [0.55, 0.48, 0.34], n: 16, sparks: 0, speed: 3.2, size: 0.26, life: 0.85, gravity: -7.5 },
  stone:    { dust: [0.52, 0.52, 0.50], chips: [0.40, 0.40, 0.39], n: 10, sparks: 7, speed: 5.0, size: 0.16, life: 0.55, gravity: -11.0 },
  wood:     { dust: [0.36, 0.27, 0.17], chips: [0.30, 0.22, 0.13], n: 11, sparks: 0, speed: 3.6, size: 0.17, life: 0.60, gravity: -9.5 },
  water:    { dust: [0.72, 0.80, 0.82], chips: [0.62, 0.72, 0.76], n: 16, sparks: 0, speed: 3.8, size: 0.22, life: 0.55, gravity: -12.0 },
  creature: { dust: [0.62, 0.10, 0.08], chips: [0.95, 0.78, 0.52], n: 22, sparks: 14, speed: 4.2, size: 0.16, life: 0.52, gravity: -8.0 },
  air:      { dust: [0, 0, 0], chips: [0, 0, 0], n: 0, sparks: 0, speed: 0, size: 0, life: 0, gravity: 0 },
};

/**
 * A note on the sizes above, because they were wrong once and it was invisible.
 *
 * These are METRES, and the point sprite covers `size * 520 / distance` pixels. The
 * first pass used 5-8 cm particles, which is roughly a real clod of earth and roughly
 * two pixels at the 30 m a rifle is actually fired over — so a shot into a hillside
 * produced a perfectly correct, perfectly invisible puff. A dust plume from a round
 * striking dirt is 30-80 cm across, not 8, and that is what reads at range.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const SIDE = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const FORWARD = new THREE.Vector3(0, 0, -1);
const UP = new THREE.Vector3(0, 1, 0);

const TRACERS = 20;
const CASES = 14;

/**
 * An orthonormal pair perpendicular to `n`, into _t1/_t2.
 *
 * The obvious shortcut — swizzling the normal's components — is only perpendicular for
 * some normals. It silently collapses to a parallel vector on a wall facing +Z, which
 * made every impact on one side of the crag emit its debris in a single straight line.
 */
function basis(n) {
  _t1.crossVectors(n, Math.abs(n.y) < 0.9 ? UP : SIDE).normalize();
  _t2.crossVectors(n, _t1).normalize();
}

export function createFX(scene, rng, { debris = 128, sparks = 72 } = {}) {
  // ---------------------------------------------------------------- flash
  // Three crossed quads: a bright core disc, a long horizontal star and a short
  // vertical one. Additive, fog off, no depth write. Scaled per shot by the weapon's
  // fireHeat and by a per-shot random so a burst never strobes identically.
  const flashGeo = (() => {
    const q = [];
    const mk = (w, h, rz) => { const g = new THREE.PlaneGeometry(w, h); g.rotateZ(rz); return g; };
    // Sizes are METRES at the muzzle, and the muzzle is ~2.4 m from a third-person
    // camera — so a 1 m star is a third of the frame. Measured: the long arm reads as
    // roughly 11% of frame height at 0.36 m, which is about where a muzzle flash sits in
    // the reference. It looked "obviously right" three times at three different sizes,
    // which is why this is written down rather than eyeballed again.
    q.push(mk(0.09, 0.09, 0));          // hot core, doubled for a bright centre
    q.push(mk(0.16, 0.16, 0));
    q.push(mk(0.36, 0.055, 0));
    q.push(mk(0.055, 0.26, 0));
    q.push(mk(0.22, 0.045, Math.PI / 4));
    q.push(mk(0.22, 0.045, -Math.PI / 4));
    const merged = new THREE.BufferGeometry();
    // hand-merge: PlaneGeometry all share (position, normal, uv) and an index
    let vc = 0, ic = 0;
    for (const g of q) { vc += g.attributes.position.count; ic += g.index.count; }
    const pos = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), idx = new Uint16Array(ic);
    let vo = 0, io = 0;
    for (const g of q) {
      pos.set(g.attributes.position.array, vo * 3);
      uv.set(g.attributes.uv.array, vo * 2);
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
      vo += g.attributes.position.count; io += g.index.count;
      g.dispose();
    }
    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    merged.setIndex(new THREE.BufferAttribute(idx, 1));
    return merged;
  })();

  // toneMapped:false is doing real work here. ACES compresses the top of the range hard,
  // so an additive flash laid over sunlit grass gets folded almost entirely back into the
  // background — measured, the star's thin arms simply vanished and only the overlapping
  // core survived as a ~20 px smudge. A muzzle flash is a light source, not a surface;
  // exempting it from the tonemap is what makes it read as one.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffe3b4, transparent: true, opacity: 1, fog: false, toneMapped: false,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const flash = new THREE.Mesh(flashGeo, flashMat);
  flash.frustumCulled = false;
  flash.renderOrder = 14;
  flash.visible = false;
  flash.name = 'weapon_flash';
  scene.add(flash);

  // The stab of light the flash throws on the world. Added at intensity 0 during init
  // so every material in the scene compiles ONCE, with a point light already in its
  // light budget — switching a light on at the moment of the first shot would recompile
  // every program in the scene and hitch the frame the player most wants to feel.
  const flashLight = new THREE.PointLight(0xffcf94, 0, 14, 2);
  flashLight.castShadow = false;
  flashLight.name = 'weapon_flashlight';
  scene.add(flashLight);

  let flashT = 0, flashDur = 0.001, flashScale = 1, flashSpin = 0;

  // ---------------------------------------------------------------- tracers
  const tracerGeo = new THREE.BoxGeometry(0.075, 0.075, 1);
  // +Z, NOT -Z. The instance quaternion maps -Z onto the direction of travel, so a body
  // authored along -Z extends FORWARD of the streak's head — five metres past it, which
  // for a 12 m shot means the entire tracer is drawn inside the thing it just hit. It
  // was invisible in every still and the object counts said it was alive and correct;
  // an A/B pixel diff was what proved it owned exactly zero pixels of the frame.
  tracerGeo.translate(0, 0, 0.5);
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffc477, transparent: true, opacity: 1.0, toneMapped: false,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const tracers = new THREE.InstancedMesh(tracerGeo, tracerMat, TRACERS);
  tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tracers.frustumCulled = false;
  tracers.renderOrder = 13;
  tracers.visible = false;
  tracers.name = 'weapon_tracers';
  tracers.count = 0;
  scene.add(tracers);
  const tr = [];
  for (let i = 0; i < TRACERS; i++) {
    tr.push({ live: false, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1, dist: 0, travel: 0, speed: 460, len: 7 });
  }

  // ---------------------------------------------------------------- cases
  const caseGeo = new THREE.CylinderGeometry(0.0052, 0.0058, 0.024, 6);
  const caseMat = new THREE.MeshStandardMaterial({ color: 0xb8863a, roughness: 0.35, metalness: 0.8 });
  const cases = new THREE.InstancedMesh(caseGeo, caseMat, CASES);
  cases.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  cases.frustumCulled = false;
  cases.visible = false;
  cases.name = 'weapon_cases';
  cases.count = 0;
  scene.add(cases);
  const cs = [];
  for (let i = 0; i < CASES; i++) {
    cs.push({ live: false, p: new THREE.Vector3(), v: new THREE.Vector3(), spin: new THREE.Vector3(), rot: new THREE.Euler(), t: 0, rest: false });
  }

  // ---------------------------------------------------------------- pools
  const debrisPool = new Pool(scene, debris, { additive: false, order: 11 });
  const sparkPool = new Pool(scene, sparks, { additive: true, order: 12 });

  let head = 0, caseHead = 0;
  let groundAt = null;

  const api = {
    setGround(fn) { groundAt = fn; },

    /** the bright end of the barrel, for `duration` seconds */
    muzzleFlash(pos, dir, scale = 1) {
      flash.position.copy(pos).addScaledVector(dir, 0.08);
      _q.setFromUnitVectors(FORWARD, _v.copy(dir).normalize());
      flash.quaternion.copy(_q);
      flashSpin = rng.range(0, Math.PI * 2);
      flash.rotateZ(flashSpin);
      flashScale = scale * rng.range(0.85, 1.18);
      flashT = flashDur = 0.055;
      flash.visible = true;
      flashLight.position.copy(pos).addScaledVector(dir, 0.35);
      // a little smoke off the muzzle, drifting up and forward
      for (let i = 0; i < 3; i++) {
        debrisPool.emit(
          pos.x + rng.range(-0.02, 0.02), pos.y + rng.range(-0.02, 0.02), pos.z + rng.range(-0.02, 0.02),
          dir.x * rng.range(0.6, 2.2) + rng.range(-0.3, 0.3),
          dir.y * rng.range(0.6, 2.2) + rng.range(0.15, 0.55),
          dir.z * rng.range(0.6, 2.2) + rng.range(-0.3, 0.3),
          0.55, 0.53, 0.50, rng.range(0.07, 0.13) * scale, rng.range(0.30, 0.55), -0.4, 2.4);
      }
    },

    /** a streak leaving `from` toward `to`; it travels, it does not just appear */
    tracer(from, to, speed = 460) {
      const t = tr[head]; head = (head + 1) % TRACERS;
      _v.subVectors(to, from);
      const d = _v.length();
      if (d < 0.05) return;
      _v.divideScalar(d);
      t.live = true;
      t.ox = from.x; t.oy = from.y; t.oz = from.z;
      t.dx = _v.x; t.dy = _v.y; t.dz = _v.z;
      t.dist = d; t.travel = 0; t.speed = speed;
      t.len = Math.min(7.5, Math.max(1.6, d * 0.42));
    },

    /** brass out of the ejection port, tumbling and landing where it lands */
    ejectCase(pos, right, up) {
      const c = cs[caseHead]; caseHead = (caseHead + 1) % CASES;
      c.live = true; c.rest = false; c.t = 0;
      c.p.copy(pos);
      c.v.copy(right).multiplyScalar(rng.range(1.5, 2.6))
        .addScaledVector(up, rng.range(1.1, 2.0));
      c.spin.set(rng.range(-22, 22), rng.range(-22, 22), rng.range(-22, 22));
      c.rot.set(rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0, 6.28));
      cases.visible = true;
    },

    /**
     * The far end of the shot. `energy` scales the burst so a graze reads smaller than
     * a square hit, and `normal` steers the cone off the surface rather than straight up.
     */
    impact(point, normal, surface, energy = 1) {
      const s = SURFACES[surface] ?? SURFACES.dirt;
      if (!s.n) return;
      const n = Math.max(2, Math.round(s.n * energy));
      basis(normal);
      for (let i = 0; i < n; i++) {
        // cone about the surface normal, widened toward the tangent plane
        const a = rng.range(0, Math.PI * 2);
        const spread = rng.range(0.25, 1.0);
        _v.copy(normal).multiplyScalar(rng.range(0.55, 1.0));
        _v.addScaledVector(_t1, Math.cos(a) * spread);
        _v.addScaledVector(_t2, Math.sin(a) * spread);
        _v.normalize().multiplyScalar(s.speed * rng.range(0.35, 1.25) * energy);
        const dusty = i < n * 0.45;
        const col = dusty ? s.dust : s.chips;
        debrisPool.emit(
          point.x, point.y, point.z, _v.x, _v.y, _v.z,
          col[0] * rng.range(0.82, 1.18), col[1] * rng.range(0.82, 1.18), col[2] * rng.range(0.82, 1.18),
          s.size * rng.range(0.6, 1.5) * (dusty ? 1.6 : 1.0),
          s.life * rng.range(0.6, 1.4),
          dusty ? s.gravity * 0.22 : s.gravity,
          dusty ? 2.9 : 1.2);
      }
      for (let i = 0; i < s.sparks; i++) {
        const a = rng.range(0, Math.PI * 2);
        const spread = rng.range(0.2, 1.1);
        _v.copy(normal).multiplyScalar(rng.range(0.6, 1.0));
        _v.addScaledVector(_t1, Math.cos(a) * spread);
        _v.addScaledVector(_t2, Math.sin(a) * spread);
        _v.normalize().multiplyScalar(rng.range(2.5, 8.0) * energy);
        const warm = surface === 'creature';
        sparkPool.emit(point.x, point.y, point.z, _v.x, _v.y, _v.z,
          warm ? 1.0 : 1.0, warm ? 0.88 : 0.72, warm ? 0.55 : 0.34,
          warm ? 0.055 : 0.035, warm ? rng.range(0.30, 0.55) : rng.range(0.12, 0.30),
          warm ? -1.2 : -12.0, warm ? 2.2 : 0.8);
      }
    },

    update(dt) {
      // ---- flash -------------------------------------------------------
      if (flashT > 0) {
        flashT -= dt;
        const k = Math.max(0, flashT / flashDur);
        if (k <= 0) { flash.visible = false; flashLight.intensity = 0; }
        else {
          // a hard front and a fast fall: full size on the first frame, then collapse
          const s = flashScale * (0.55 + 0.45 * k);
          flash.scale.set(s, s, s);
          // not 1.0: additive + untonemapped at full strength clips every arm to white,
          // which loses the warm colour that says "burning propellant"
          flashMat.opacity = 0.72 * Math.pow(k, 0.7);
          // candela: the sun in this scene runs at ~2-3, so 5 at one metre is a stab of
          // light on the nearby ground rather than a white-out
          flashLight.intensity = 5.0 * k * k * flashScale;
        }
      } else if (flashLight.intensity !== 0) { flashLight.intensity = 0; }

      // ---- tracers -----------------------------------------------------
      let live = 0;
      for (let i = 0; i < TRACERS; i++) {
        const t = tr[i];
        if (!t.live) continue;
        t.travel += t.speed * dt;
        const tail = t.travel - t.len;
        if (tail > t.dist) { t.live = false; continue; }
        const headD = Math.min(t.travel, t.dist);
        const len = Math.max(0.15, headD - Math.max(0, tail));
        _v.set(t.ox + t.dx * headD, t.oy + t.dy * headD, t.oz + t.dz * headD);
        _v2.set(t.dx, t.dy, t.dz);
        _q.setFromUnitVectors(FORWARD, _v2);
        _s.set(1, 1, len);
        _m.compose(_v, _q, _s);
        tracers.setMatrixAt(live, _m);
        // fade the streak out as it stretches away from the muzzle
        const f = Math.max(0.15, 1 - t.travel / (t.dist + t.len));
        _c.setRGB(f, f * 0.78, f * 0.46);
        tracers.setColorAt(live, _c);
        live++;
      }
      tracers.count = live;
      tracers.visible = live > 0;
      if (live > 0) {
        tracers.instanceMatrix.needsUpdate = true;
        if (tracers.instanceColor) tracers.instanceColor.needsUpdate = true;
      }

      // ---- cases -------------------------------------------------------
      let cl = 0;
      for (let i = 0; i < CASES; i++) {
        const c = cs[i];
        if (!c.live) continue;
        c.t += dt;
        if (c.t > 3.2) { c.live = false; continue; }
        if (!c.rest) {
          c.v.y -= 19 * dt;
          c.p.addScaledVector(c.v, dt);
          c.rot.x += c.spin.x * dt; c.rot.y += c.spin.y * dt; c.rot.z += c.spin.z * dt;
          const g = groundAt ? groundAt(c.p.x, c.p.z) : 0;
          if (c.p.y <= g + 0.006) {
            // one small bounce, then it lies where it fell
            if (Math.abs(c.v.y) > 1.2) { c.p.y = g + 0.006; c.v.y *= -0.32; c.v.x *= 0.5; c.v.z *= 0.5; c.spin.multiplyScalar(0.4); }
            else { c.p.y = g + 0.006; c.rest = true; c.rot.x = Math.PI / 2; }
          }
        }
        _q.setFromEuler(c.rot);
        const fade = c.t > 2.6 ? Math.max(0, 1 - (c.t - 2.6) / 0.6) : 1;
        _s.set(fade, fade, fade);
        _m.compose(c.p, _q, _s);
        cases.setMatrixAt(cl, _m);
        cl++;
      }
      cases.count = cl;
      cases.visible = cl > 0;
      if (cl > 0) cases.instanceMatrix.needsUpdate = true;

      debrisPool.update(dt);
      sparkPool.update(dt);
    },

    stats() {
      return {
        tracers: tracers.count, cases: cases.count,
        debris: debrisPool.live, sparks: sparkPool.live,
        flash: +Math.max(0, flashT / flashDur).toFixed(2),
      };
    },
  };

  return api;
}

export { SURFACES };
