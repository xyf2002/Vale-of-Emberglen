import * as THREE from 'three';

/**
 * Pooled effects for the sphere loop. Everything here is fixed-size and allocated once:
 * two InstancedMeshes (sparks, rings), one instanced arc, two ground markers. No
 * geometry, material, vector or object is created after init, so a throw costs the same
 * whether it is the first of the session or the hundredth.
 *
 * Additive materials fade by driving the instance COLOUR toward black rather than by
 * opacity, because InstancedMesh has no per-instance alpha. Under additive blending
 * black is invisible, so the two are the same thing.
 */

const MAX_SPARKS = 180;
const MAX_RINGS = 8;
const ARC_DOTS = 34;

export function createFx(ctx, rng) {
  const scene = ctx.scene;
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const _p = new THREE.Vector3();
  const _c = new THREE.Color();
  const _c2 = new THREE.Color();
  const FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const NOROT = new THREE.Quaternion();

  // ---- sparks ---------------------------------------------------------------
  const sparkGeo = new THREE.OctahedronGeometry(1, 0);
  const sparkMat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const sparks = new THREE.InstancedMesh(sparkGeo, sparkMat, MAX_SPARKS);
  sparks.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPARKS * 3), 3);
  sparks.frustumCulled = false;
  sparks.renderOrder = 5;
  sparks.count = 0;
  scene.add(sparks);

  const sp = {
    x: new Float32Array(MAX_SPARKS), y: new Float32Array(MAX_SPARKS), z: new Float32Array(MAX_SPARKS),
    vx: new Float32Array(MAX_SPARKS), vy: new Float32Array(MAX_SPARKS), vz: new Float32Array(MAX_SPARKS),
    life: new Float32Array(MAX_SPARKS), max: new Float32Array(MAX_SPARKS),
    size: new Float32Array(MAX_SPARKS), grav: new Float32Array(MAX_SPARKS),
    r: new Float32Array(MAX_SPARKS), g: new Float32Array(MAX_SPARKS), b: new Float32Array(MAX_SPARKS),
    // optional attractor: pull toward (ax,ay,az) at strength `pull`
    ax: new Float32Array(MAX_SPARKS), ay: new Float32Array(MAX_SPARKS), az: new Float32Array(MAX_SPARKS),
    pull: new Float32Array(MAX_SPARKS),
  };
  let nSpark = 0;

  function spark(x, y, z, vx, vy, vz, color, size, life, grav = 0, pull = 0, ax = 0, ay = 0, az = 0) {
    const i = nSpark < MAX_SPARKS ? nSpark++ : (MAX_SPARKS - 1);
    sp.x[i] = x; sp.y[i] = y; sp.z[i] = z;
    sp.vx[i] = vx; sp.vy[i] = vy; sp.vz[i] = vz;
    sp.life[i] = life; sp.max[i] = life; sp.size[i] = size; sp.grav[i] = grav;
    sp.pull[i] = pull; sp.ax[i] = ax; sp.ay[i] = ay; sp.az[i] = az;
    _c.set(color);
    sp.r[i] = _c.r; sp.g[i] = _c.g; sp.b[i] = _c.b;
  }

  // ---- expanding rings ------------------------------------------------------
  const ringGeo = new THREE.RingGeometry(0.80, 1.0, 40);
  const ringMat = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const rings = new THREE.InstancedMesh(ringGeo, ringMat, MAX_RINGS);
  rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 3), 3);
  rings.frustumCulled = false;
  rings.renderOrder = 4;
  rings.count = 0;
  scene.add(rings);

  const rg = {
    x: new Float32Array(MAX_RINGS), y: new Float32Array(MAX_RINGS), z: new Float32Array(MAX_RINGS),
    r0: new Float32Array(MAX_RINGS), r1: new Float32Array(MAX_RINGS),
    t: new Float32Array(MAX_RINGS), dur: new Float32Array(MAX_RINGS),
    r: new Float32Array(MAX_RINGS), g: new Float32Array(MAX_RINGS), b: new Float32Array(MAX_RINGS),
  };
  let nRing = 0;

  // ---- the aim arc ----------------------------------------------------------
  const dotGeo = new THREE.IcosahedronGeometry(1, 0);
  // NOT additive. An additive arc over a sunlit meadow is invisible — the grass is
  // already near the top of the range, so adding light to it does nothing. Opaque,
  // untonemapped beads read at any exposure, which is the whole job of an aim arc.
  const dotMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0.98, depthWrite: false, toneMapped: false,
  });
  const arcDots = new THREE.InstancedMesh(dotGeo, dotMat, ARC_DOTS);
  arcDots.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ARC_DOTS * 3), 3);
  arcDots.frustumCulled = false;
  arcDots.renderOrder = 4;
  arcDots.count = 0;
  scene.add(arcDots);

  // ---- ground markers -------------------------------------------------------
  // Ground markers are opaque for the same reason the arc is: additive rings vanish on
  // sunlit grass, and a landing marker you cannot see is worse than none.
  function makeMarker(inner, outer, color, opacity) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(inner, outer, 48),
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
        toneMapped: false,
      }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 3;
    m.visible = false;
    m.frustumCulled = false;
    scene.add(m);
    return m;
  }
  // where the throw lands, and — under a creature — how good the odds are
  const landMark = makeMarker(0.40, 0.52, 0xffe6b0, 0.85);
  const oddsMark = makeMarker(0.62, 0.88, 0xffffff, 0.75);

  const api = {
    /** a puff of sparks */
    burst(pos, { n = 12, color = 0xffe0a0, speed = 2.0, size = 0.055, life = 0.55, up = 1.0, grav = 3.0 } = {}) {
      for (let i = 0; i < n; i++) {
        const th = rng.next() * Math.PI * 2;
        const ph = Math.acos(1 - 2 * rng.next());
        const s = speed * (0.45 + rng.next() * 0.9);
        spark(pos.x, pos.y, pos.z,
          Math.sin(ph) * Math.cos(th) * s,
          Math.cos(ph) * s * 0.6 + up * (0.4 + rng.next() * 0.8),
          Math.sin(ph) * Math.sin(th) * s,
          color, size * (0.65 + rng.next() * 0.7), life * (0.7 + rng.next() * 0.6), grav);
      }
    },

    /** a single spark, used for the flight trail */
    trail(pos, color = 0xffd9a0, size = 0.035, life = 0.28) {
      spark(pos.x, pos.y, pos.z,
        rng.range(-0.25, 0.25), rng.range(-0.1, 0.35), rng.range(-0.25, 0.25),
        color, size, life, 0.6);
    },

    /**
     * Motes torn off the creature and dragged into the sphere mouth.
     * `sizeK` is a legibility compensator, not a style knob: an 0.05 m additive mote is
     * roughly one pixel at 26 m and additive-over-sunlit-grass at one pixel is invisible
     * (same reason the arc and the ground markers here are opaque rather than additive).
     * The caller passes camera range, so the vortex costs nothing extra up close.
     */
    swirl(from, to, radius, color = 0xffeec4, sizeK = 1) {
      const th = rng.next() * Math.PI * 2;
      const r = radius * (0.55 + rng.next() * 0.75);
      const x = from.x + Math.cos(th) * r;
      const y = from.y + rng.range(-radius * 0.4, radius * 0.9);
      const z = from.z + Math.sin(th) * r;
      // tangential kick so the pull-in reads as a vortex, not a straight suck
      spark(x, y, z, -Math.sin(th) * 2.4, 0.5, Math.cos(th) * 2.4,
        color, (0.048 + rng.next() * 0.03) * sizeK, 0.42, 0, 26, to.x, to.y, to.z);
    },

    ring(pos, { r0 = 0.2, r1 = 1.6, dur = 0.55, color = 0xffe0a8 } = {}) {
      const i = nRing < MAX_RINGS ? nRing++ : (MAX_RINGS - 1);
      rg.x[i] = pos.x; rg.y[i] = pos.y + 0.04; rg.z[i] = pos.z;
      rg.r0[i] = r0; rg.r1[i] = r1; rg.t[i] = 0; rg.dur[i] = dur;
      _c.set(color);
      rg.r[i] = _c.r; rg.g[i] = _c.g; rg.b[i] = _c.b;
    },

    /** draw the aim arc from a traced point list */
    showArc(points, count, color = 0xffe2ae) {
      _c.set(color);
      const n = Math.min(count, ARC_DOTS);
      for (let i = 0; i < n; i++) {
        const u = i / Math.max(1, n - 1);
        // fat near the hand, tapering into the marker: the taper IS the direction cue
        const s = 0.085 - u * 0.050;
        _s.setScalar(Math.max(0.022, s));
        _m.compose(points[i], NOROT, _s);
        arcDots.setMatrixAt(i, _m);
        const f = 1.0 - u * 0.25;
        _c2.setRGB(_c.r * f, _c.g * f, _c.b * f);
        arcDots.setColorAt(i, _c2);
      }
      arcDots.count = n;
      arcDots.visible = n > 0;
      arcDots.instanceMatrix.needsUpdate = true;
      if (arcDots.instanceColor) arcDots.instanceColor.needsUpdate = true;
    },
    hideArc() { arcDots.count = 0; arcDots.visible = false; },

    /** the ground ring where the throw will land */
    showLand(pos, on = true) {
      landMark.visible = on;
      if (on) landMark.position.set(pos.x, pos.y + 0.05, pos.z);
    },

    /**
     * The odds ring under a targeted creature. Colour IS the number: red means it will
     * almost certainly break out, green means feeding it did its job. This is the whole
     * design constraint made visible without a single line of HUD text.
     */
    showOdds(pos, chance, radius) {
      oddsMark.visible = true;
      oddsMark.position.set(pos.x, pos.y + 0.06, pos.z);
      const k = Math.max(0.4, radius);
      oddsMark.scale.setScalar(k);
      _c.setHSL(0.02 + 0.30 * Math.min(1, chance * 1.05), 0.92, 0.55);
      oddsMark.material.color.copy(_c);
      oddsMark.material.opacity = 0.78 + chance * 0.20;
    },
    hideOdds() { oddsMark.visible = false; },

    update(dt) {
      // ---- sparks ----
      for (let i = 0; i < nSpark;) {
        sp.life[i] -= dt;
        if (sp.life[i] <= 0) {
          const j = --nSpark;
          if (j !== i) {
            for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'life', 'max', 'size', 'grav', 'r', 'g', 'b', 'ax', 'ay', 'az', 'pull']) sp[k][i] = sp[k][j];
          }
          continue;
        }
        if (sp.pull[i] > 0) {
          const dx = sp.ax[i] - sp.x[i], dy = sp.ay[i] - sp.y[i], dz = sp.az[i] - sp.z[i];
          const d = Math.max(0.12, Math.hypot(dx, dy, dz));
          const a = sp.pull[i] / d;
          sp.vx[i] += dx * a * dt; sp.vy[i] += dy * a * dt; sp.vz[i] += dz * a * dt;
          sp.vx[i] *= 0.96; sp.vy[i] *= 0.96; sp.vz[i] *= 0.96;
        } else {
          sp.vy[i] -= sp.grav[i] * dt;
        }
        sp.x[i] += sp.vx[i] * dt; sp.y[i] += sp.vy[i] * dt; sp.z[i] += sp.vz[i] * dt;
        i++;
      }
      for (let i = 0; i < nSpark; i++) {
        const u = sp.life[i] / sp.max[i];
        _p.set(sp.x[i], sp.y[i], sp.z[i]);
        _s.setScalar(sp.size[i] * (0.35 + 0.65 * u));
        _m.compose(_p, NOROT, _s);
        sparks.setMatrixAt(i, _m);
        _c.setRGB(sp.r[i] * u, sp.g[i] * u, sp.b[i] * u);
        sparks.setColorAt(i, _c);
      }
      sparks.count = nSpark;
      sparks.visible = nSpark > 0;
      sparks.instanceMatrix.needsUpdate = true;
      if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;

      // ---- rings ----
      for (let i = 0; i < nRing;) {
        rg.t[i] += dt;
        if (rg.t[i] >= rg.dur[i]) {
          const j = --nRing;
          if (j !== i) for (const k of ['x', 'y', 'z', 'r0', 'r1', 't', 'dur', 'r', 'g', 'b']) rg[k][i] = rg[k][j];
          continue;
        }
        i++;
      }
      for (let i = 0; i < nRing; i++) {
        const u = rg.t[i] / rg.dur[i];
        const e = 1 - (1 - u) * (1 - u);
        const r = rg.r0[i] + (rg.r1[i] - rg.r0[i]) * e;
        _p.set(rg.x[i], rg.y[i], rg.z[i]);
        _s.set(r, r, 1);
        _m.compose(_p, FLAT, _s);
        rings.setMatrixAt(i, _m);
        const f = (1 - u) * (1 - u);
        _c.setRGB(rg.r[i] * f, rg.g[i] * f, rg.b[i] * f);
        rings.setColorAt(i, _c);
      }
      rings.count = nRing;
      rings.visible = nRing > 0;
      rings.instanceMatrix.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    },

    stats() { return { sparks: nSpark, rings: nRing, arc: arcDots.count }; },

    dispose() {
      scene.remove(sparks, rings, arcDots, landMark, oddsMark);
      sparkGeo.dispose(); sparkMat.dispose();
      ringGeo.dispose(); ringMat.dispose();
      dotGeo.dispose(); dotMat.dispose();
      landMark.geometry.dispose(); landMark.material.dispose();
      oddsMark.geometry.dispose(); oddsMark.material.dispose();
    },
  };

  return api;
}
