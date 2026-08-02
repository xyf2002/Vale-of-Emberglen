import * as THREE from 'three';

/**
 * Procedural stylised humanoid — "the traveller".
 *
 * Built entirely from lathes, spheres and rounded boxes at runtime (no assets).
 * Proportions are anime-heroic rather than realistic: ~6.9 heads, 1.78 m, narrow
 * waist, wide shoulder line, heavy boots. It is seen from behind at 2-4 m almost
 * all the time, so the silhouette budget goes into the back: raised collar,
 * spiked hair, a bedroll pack and a trailing scarf.
 *
 * Everything returns a flat rig of THREE.Groups; the animator writes transforms,
 * this file never animates.
 */

export const RIG = {
  hipY: 0.94,
  hipHalf: 0.105,
  chestY: 0.30,          // chest group, relative to hips
  shoulderHalf: 0.185,
  shoulderY: 0.15,       // relative to chest
  neckY: 0.245,          // relative to chest
  headY: 0.115,          // relative to neck
  upperArm: 0.30,
  foreArm: 0.255,
  thigh: 0.44,
  shin: 0.41,
  ankleY: 0.09,
  height: 1.78,
};

const PAL = {
  skin: 0xe9bd94,
  skinShade: 0xd8a67d,
  hair: 0xa8462a,
  jacket: 0x333c52,
  jacketDark: 0x272e3f,
  shirt: 0xcfc2a2,
  trouser: 0x555f70,
  leather: 0x6d4b32,
  strap: 0x7d5a3a,
  canvas: 0x8b8560,
  glove: 0x3a3831,
  scarf: 0xb9563a,
  bedroll: 0xc7bda0,
  eye: 0x241c18,
  berry: 0xbe3a2f,
  leaf: 0x5c8a3a,
};

/* ------------------------------------------------------------------ geometry */

/** merge a list of {geo, m?} into one non-indexed BufferGeometry */
function merge(entries) {
  const parts = [];
  for (const e of entries) {
    if (!e) continue;
    let g = e.geo.index ? e.geo.toNonIndexed() : e.geo.clone();
    if (e.m) g.applyMatrix4(e.m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    parts.push(g);
    if (e.geo !== g) e.geo.dispose?.();
  }
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    uv.set(g.attributes.uv.array.subarray(0, g.attributes.position.count * 2), o * 2);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
/** compact matrix builder */
function M(px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** tapered capsule: origin at the top joint, body hangs to -len, hemispherical caps */
function limb(rTop, rBot, len, seg = 12) {
  const pts = [];
  const cap = 4;
  for (let i = 0; i <= cap; i++) {
    const a = -Math.PI / 2 + (i / cap) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-3, Math.cos(a) * rBot), -len + Math.sin(a) * rBot));
  }
  const shaft = 3;
  for (let i = 1; i <= shaft; i++) {
    const t = i / shaft;
    pts.push(new THREE.Vector2(rBot + (rTop - rBot) * t, -len + len * t));
  }
  for (let i = 1; i <= cap; i++) {
    const a = (i / cap) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(1e-3, Math.cos(a) * rTop), Math.sin(a) * rTop));
  }
  return new THREE.LatheGeometry(pts, seg);
}

/** lathe from an array of [radius, y] pairs, bottom -> top */
function lathe(profile, seg = 18) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-3, r), y)), seg);
}

/** box with rounded edges via a squircle push (no external geometry dep) */
function roundedBox(w, h, d, r, seg = 4) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.attributes.position;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  const v = new THREE.Vector3(), inner = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(
      THREE.MathUtils.clamp(v.x, -hx, hx),
      THREE.MathUtils.clamp(v.y, -hy, hy),
      THREE.MathUtils.clamp(v.z, -hz, hz));
    v.sub(inner);
    const l = v.length();
    if (l > 1e-6) v.multiplyScalar(r / l);
    p.setXYZ(i, inner.x + v.x, inner.y + v.y, inner.z + v.z);
  }
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ material */

function mat(color, rough = 0.82, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: 0, ...opts,
  });
  // A thin warm rim along the silhouette. Reference note #4: subtle, ~10-15% of key,
  // but always present — it is what stops a character sinking into the grass.
  m.userData.rim = {
    color: { value: new THREE.Color(1.0, 0.86, 0.66) },
    strength: { value: 0.22 },
  };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = m.userData.rim.color;
    sh.uniforms.uRimStrength = m.userData.rim.strength;
    sh.fragmentShader = 'uniform vec3 uRimColor;\nuniform float uRimStrength;\n' + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <opaque_fragment>',
      `{
         float rf = 1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0);
         outgoingLight += uRimColor * pow(rf, 3.5) * uRimStrength;
       }
       #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'avatarRim';
  return m;
}

/* ------------------------------------------------------------------ build */

export function buildAvatar(rng) {
  const mats = {
    skin: mat(PAL.skin, 0.72),
    hair: mat(PAL.hair, 0.78),
    jacket: mat(PAL.jacket, 0.85),
    shirt: mat(PAL.shirt, 0.88),
    trouser: mat(PAL.trouser, 0.87),
    leather: mat(PAL.leather, 0.7),
    strap: mat(PAL.strap, 0.8),
    canvas: mat(PAL.canvas, 0.92),
    glove: mat(PAL.glove, 0.78),
    scarf: mat(PAL.scarf, 0.9, { side: THREE.DoubleSide }),
    dark: mat(PAL.eye, 0.5),
    berry: mat(PAL.berry, 0.42),
  };

  const root = new THREE.Group();
  root.name = 'avatar';

  const add = (parent, geo, material) => {
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    m.receiveShadow = false;
    m.frustumCulled = false;
    parent.add(m);
    return m;
  };

  // ---- hips ------------------------------------------------------------
  const hips = new THREE.Group();
  hips.position.y = RIG.hipY;
  root.add(hips);

  const pelvisGeo = merge([
    { geo: lathe([
      [0.108, -0.20], [0.128, -0.15], [0.138, -0.08], [0.134, -0.02],
      [0.124, 0.03], [0.100, 0.07], [0.0, 0.085],
    ], 18), m: M(0, 0, 0, 0, 0, 0, 1, 1, 0.74) },
  ]);
  add(hips, pelvisGeo, mats.trouser);

  // belt + hip pouch + a short coat tail: all leather, one draw call
  const beltGeo = merge([
    { geo: new THREE.TorusGeometry(0.128, 0.021, 6, 20), m: M(0, 0.015, 0, Math.PI / 2, 0, 0, 1, 1, 0.78) },
    { geo: roundedBox(0.05, 0.035, 0.022, 0.008, 2), m: M(0, 0.015, -0.098) },
    { geo: roundedBox(0.10, 0.115, 0.07, 0.025, 3), m: M(0.115, -0.055, 0.01, 0, 0.2, 0.1) },
    { geo: roundedBox(0.055, 0.09, 0.05, 0.02, 3), m: M(-0.125, -0.05, -0.02, 0, -0.25, -0.08) },
  ]);
  add(hips, beltGeo, mats.leather);

  // hip cloth hanging at the back — reads as a coat tail from behind
  const clothGeo = merge([
    { geo: lathe([[0.150, -0.26], [0.152, -0.18], [0.142, -0.09], [0.128, -0.01]], 16),
      m: M(0, 0, -0.012, 0, 0, 0, 1, 1, 0.8) },
  ]);
  add(hips, clothGeo, mats.jacket);

  // ---- chest -----------------------------------------------------------
  const chest = new THREE.Group();
  chest.position.y = RIG.chestY;
  hips.add(chest);

  const torso = lathe([
    [0.098, -0.235], [0.112, -0.18], [0.122, -0.10], [0.138, -0.02],
    [0.158, 0.06], [0.172, 0.13], [0.174, 0.185], [0.150, 0.225],
    [0.105, 0.248], [0.0, 0.258],
  ], 20);
  torso.scale(1, 1, 0.70);

  const collar = lathe([
    [0.088, 0.20], [0.104, 0.245], [0.118, 0.30], [0.113, 0.315], [0.096, 0.262], [0.080, 0.212],
  ], 18);
  collar.scale(1.06, 1, 0.86);

  const jacketGeo = merge([
    { geo: torso },
    { geo: collar },
    // deltoid caps so the shoulder joint never reads as a gap
    { geo: new THREE.SphereGeometry(0.078, 12, 9), m: M(0.176, 0.148, 0, 0, 0, 0, 1, 0.92, 1) },
    { geo: new THREE.SphereGeometry(0.078, 12, 9), m: M(-0.176, 0.148, 0, 0, 0, 0, 1, 0.92, 1) },
  ]);
  add(chest, jacketGeo, mats.jacket);

  // shirt showing at the chest opening
  const shirtGeo = merge([
    { geo: lathe([[0.070, -0.10], [0.088, 0.0], [0.098, 0.10], [0.092, 0.19], [0.070, 0.235]], 14),
      m: M(0, 0, 0.012, 0, 0, 0, 1, 1, 0.62) },
  ]);
  add(chest, shirtGeo, mats.shirt);

  // pack: rounded box + bedroll + two shoulder straps
  const packGeo = merge([
    { geo: roundedBox(0.30, 0.30, 0.155, 0.055, 4), m: M(0, 0.055, -0.185) },
    { geo: roundedBox(0.20, 0.10, 0.09, 0.03, 3), m: M(0, -0.09, -0.20) },
  ]);
  add(chest, packGeo, mats.canvas);

  const bedrollGeo = merge([
    { geo: new THREE.CylinderGeometry(0.056, 0.056, 0.30, 12), m: M(0, 0.215, -0.185, 0, 0, Math.PI / 2) },
  ]);
  add(chest, bedrollGeo, mats.shirt);

  const strapGeo = merge([
    { geo: roundedBox(0.045, 0.30, 0.030, 0.012, 2), m: M(0.105, 0.075, 0.075, 0.30, 0, 0.06) },
    { geo: roundedBox(0.045, 0.30, 0.030, 0.012, 2), m: M(-0.105, 0.075, 0.075, 0.30, 0, -0.06) },
    { geo: roundedBox(0.045, 0.12, 0.030, 0.012, 2), m: M(0.115, 0.175, -0.11, -0.5, 0, 0.06) },
    { geo: roundedBox(0.045, 0.12, 0.030, 0.012, 2), m: M(-0.115, 0.175, -0.11, -0.5, 0, -0.06) },
  ]);
  add(chest, strapGeo, mats.strap);

  // scarf ring at the collar
  const scarfRing = merge([
    { geo: new THREE.TorusGeometry(0.082, 0.030, 7, 18), m: M(0, 0.268, -0.005, Math.PI / 2, 0, 0, 1.05, 1, 0.9) },
  ]);
  add(chest, scarfRing, mats.scarf);

  // trailing scarf tail (vertex-animated)
  const tailGeo = new THREE.PlaneGeometry(0.13, 0.40, 2, 7);
  tailGeo.translate(0, -0.20, 0);
  const scarfTail = add(chest, tailGeo, mats.scarf);
  scarfTail.position.set(-0.135, 0.275, -0.035);
  scarfTail.rotation.set(0, 0.25, 0.12);
  scarfTail.castShadow = false;
  const scarfBase = Float32Array.from(tailGeo.attributes.position.array);

  // ---- neck & head -----------------------------------------------------
  const neck = new THREE.Group();
  neck.position.set(0, RIG.neckY, -0.005);
  chest.add(neck);
  add(neck, limb(0.050, 0.058, 0.05, 10), mats.skin);

  const head = new THREE.Group();
  head.position.y = RIG.headY;
  neck.add(head);

  const skullGeo = merge([
    { geo: new THREE.SphereGeometry(0.108, 18, 14), m: M(0, 0, 0, 0, 0, 0, 1.0, 1.10, 1.04) },
    // jaw / chin taper
    { geo: new THREE.SphereGeometry(0.072, 14, 10), m: M(0, -0.062, 0.012, 0, 0, 0, 0.96, 0.86, 1.0) },
    // ears
    { geo: new THREE.SphereGeometry(0.024, 8, 6), m: M(0.104, -0.008, 0.004, 0, 0, 0, 0.5, 1.1, 0.8) },
    { geo: new THREE.SphereGeometry(0.024, 8, 6), m: M(-0.104, -0.008, 0.004, 0, 0, 0, 0.5, 1.1, 0.8) },
  ]);
  add(head, skullGeo, mats.skin);

  // flat-graphic eyes + brows (reference note #3 — drawn, not modelled)
  const faceGeo = merge([
    { geo: new THREE.SphereGeometry(0.026, 10, 8), m: M(0.043, -0.006, 0.098, 0, 0, 0, 1, 1.25, 0.30) },
    { geo: new THREE.SphereGeometry(0.026, 10, 8), m: M(-0.043, -0.006, 0.098, 0, 0, 0, 1, 1.25, 0.30) },
    { geo: roundedBox(0.046, 0.011, 0.012, 0.005, 2), m: M(0.045, 0.040, 0.096, 0, 0, -0.16) },
    { geo: roundedBox(0.046, 0.011, 0.012, 0.005, 2), m: M(-0.045, 0.040, 0.096, 0, 0, 0.16) },
  ]);
  add(head, faceGeo, mats.dark);

  // hair: a displaced cap plus spikes that overshoot the skull
  const capGeo = new THREE.SphereGeometry(0.121, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62);
  {
    const p = capGeo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = Math.sin(v.x * 41.0) * Math.cos(v.z * 37.0 + v.y * 13.0);
      v.multiplyScalar(1 + n * 0.075);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    capGeo.computeVertexNormals();
  }
  const spikes = [{ geo: capGeo, m: M(0, 0.012, -0.006, 0, 0, 0, 1.02, 1.0, 1.06) }];
  for (let i = 0; i < 9; i++) {
    const a = rng.range(-2.55, 2.55);           // biased to the back/sides
    const el = rng.range(0.15, 1.05);
    const r = 0.108;
    const px = Math.sin(a) * Math.cos(el) * r;
    const pz = -Math.cos(a) * Math.cos(el) * r;
    const py = Math.sin(el) * r * 1.05 + 0.012;
    const len = rng.range(0.075, 0.145);
    const dir = new THREE.Vector3(px, py * 0.6 + 0.04, pz).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(px, py, pz), q, new THREE.Vector3(1, 1, 1));
    const cone = new THREE.ConeGeometry(rng.range(0.026, 0.042), len, 6);
    cone.translate(0, len * 0.34, 0);
    spikes.push({ geo: cone, m });
  }
  // nape tuft
  const tuft = new THREE.ConeGeometry(0.052, 0.15, 7);
  tuft.translate(0, -0.055, 0);
  spikes.push({ geo: tuft, m: M(0, -0.045, -0.088, 0.55, 0, 0) });
  add(head, merge(spikes), mats.hair);

  // ---- arms ------------------------------------------------------------
  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * RIG.shoulderHalf, RIG.shoulderY, 0);
    chest.add(shoulder);
    add(shoulder, limb(0.062, 0.048, RIG.upperArm, 10), mats.jacket);

    const elbow = new THREE.Group();
    elbow.position.y = -RIG.upperArm;
    shoulder.add(elbow);
    add(elbow, limb(0.050, 0.038, RIG.foreArm, 10), mats.skin);
    // bracer
    add(elbow, merge([
      { geo: limb(0.054, 0.050, 0.075, 10), m: M(0, -0.005, 0) },
    ]), mats.leather);

    const hand = new THREE.Group();
    hand.position.y = -RIG.foreArm;
    elbow.add(hand);
    add(hand, merge([
      { geo: new THREE.SphereGeometry(0.050, 10, 8), m: M(0, -0.030, 0, 0, 0, 0, 0.82, 1.15, 0.66) },
      { geo: new THREE.SphereGeometry(0.024, 8, 6), m: M(side * 0.036, -0.022, 0.010) },
    ]), mats.glove);
    return { shoulder, elbow, hand };
  }
  const armR = arm(1);
  const armL = arm(-1);

  // held berry (feeding gesture prop)
  const berry = new THREE.Group();
  berry.position.set(0, -0.075, 0.02);
  berry.visible = false;
  armR.hand.add(berry);
  add(berry, merge([
    { geo: new THREE.SphereGeometry(0.032, 10, 8) },
    { geo: new THREE.SphereGeometry(0.021, 8, 6), m: M(0.030, 0.012, -0.014, 0, 0, 0, 1, 0.85, 1) },
  ]), mats.berry);

  // ---- legs (IK, parented to root so the animator can solve in root space) --
  function leg() {
    const thigh = new THREE.Group();
    root.add(thigh);
    add(thigh, limb(0.092, 0.068, RIG.thigh, 10), mats.trouser);

    const shin = new THREE.Group();
    root.add(shin);
    add(shin, limb(0.070, 0.052, RIG.shin, 10), mats.trouser);
    // boot shaft
    add(shin, merge([
      { geo: limb(0.076, 0.062, 0.19, 10), m: M(0, -RIG.shin + 0.19, 0) },
    ]), mats.leather);

    const foot = new THREE.Group();
    root.add(foot);
    add(foot, merge([
      { geo: roundedBox(0.098, 0.085, 0.235, 0.035, 3), m: M(0, -0.045, -0.045) },
      { geo: new THREE.SphereGeometry(0.048, 10, 8), m: M(0, -0.042, -0.150, 0, 0, 0, 1.0, 0.85, 0.9) },
      { geo: roundedBox(0.105, 0.028, 0.245, 0.012, 3), m: M(0, -0.078, -0.045) },
    ]), mats.leather);
    return { thigh, shin, foot };
  }
  const legR = leg();
  const legL = leg();

  return {
    root,
    rig: { hips, chest, neck, head, armR, armL, legR, legL, berry, scarfTail, scarfBase },
    materials: mats,
    palette: PAL,
    setRim(color, strength) {
      for (const k in mats) {
        const r = mats[k].userData.rim;
        if (!r) continue;
        r.color.value.copy(color);
        r.strength.value = strength;
      }
    },
  };
}
