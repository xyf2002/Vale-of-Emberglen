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
  // Nord kit (r14): horned iron helm + fur mantle.
  // The first pass had the helm at 0x5b616b, which is the same value AND the same
  // blue-grey family as the jacket (0x333c52) — under a blue sky key the two merged
  // into one shape and the helmet stopped reading as metal at all. Steel has to be
  // lighter than the cloth it sits on and pulled off the cloth's hue.
  iron: 0x7d8189,
  ironDark: 0x4c515a,
  horn: 0xcfc3a6,
  fur: 0x5a4a3c,
  // darker and less saturated than the hair: at 0x9c4a2c the beard read as a red bib
  // hanging off the chin rather than as hair in the helm's shade
  beard: 0x7c3a22,
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

/**
 * A tapered, ridged horn swept along a curve.
 *
 * TubeGeometry would give the sweep but only at a constant radius, and a horn is
 * almost entirely defined by its taper — a constant-radius tube reads as a pipe glued
 * to the helmet. So the rings are laid out by hand on the curve's Frenet frames:
 * radius falls off with a slight ease so the base stays thick and the last third
 * needles, and a low-frequency ripple along the length gives the growth ridges that
 * catch the key light and stop the horn reading as smooth plastic.
 *
 * @param pts    control points in head space; the curve passes through them.
 * @param rBase  radius at pts[0], @param rTip radius at the last point.
 */
function horn(pts, rBase, rTip, { seg = 26, radial = 9, ridges = 9, ridgeAmt = 0.075, flat = 0.86 } = {}) {
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(...p)));
  const frames = curve.computeFrenetFrames(seg, false);
  const pos = new Float32Array((seg + 1) * (radial + 1) * 3);
  const uv = new Float32Array((seg + 1) * (radial + 1) * 2);
  const idx = [];
  const P = new THREE.Vector3();
  let o = 0;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    curve.getPointAt(t, P);
    const N = frames.normals[i], B = frames.binormals[i];
    // ease the taper: thick shank, fast needle at the end
    const r = (rBase + (rTip - rBase) * (t * t * 0.55 + t * 0.45))
      * (1 + Math.sin(t * ridges * Math.PI * 2) * ridgeAmt * (1 - t));
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cx = Math.cos(a) * r, cy = Math.sin(a) * r * flat;   // ovalised cross-section
      pos[o * 3] = P.x + N.x * cx + B.x * cy;
      pos[o * 3 + 1] = P.y + N.y * cx + B.y * cy;
      pos[o * 3 + 2] = P.z + N.z * cx + B.z * cy;
      uv[o * 2] = j / radial;
      uv[o * 2 + 1] = t;
      o++;
    }
  }
  const row = radial + 1;
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * row + j, b = a + row;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ material */

/**
 * three's own line out of <lights_fragment_begin>. Matched loosely enough to survive
 * whitespace churn, strictly enough that a signature change fails visibly instead of
 * silently leaving the acne in place. (Same trick as the creature fur shader — the two
 * systems own separate directories and must not import each other, so it is copied.)
 */
const DIR_SHADOW_LINE = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \],([\s\S]*?)directionalLightShadow\.shadowBias,([\s\S]*?)\) : 1\.0;/;

/**
 * @param shadowBias  normalised-depth push on the avatar's own shadow lookup, ~0.5 m.
 *
 * WHY THE AVATAR RECEIVES SHADOW AT ALL, AND WHY IT NEEDS ITS OWN BIAS.
 *
 * Until r13 every avatar mesh was `castShadow = true; receiveShadow = false`, so the
 * character was lit identically standing in open sun and standing under a tree — which
 * is another way of saying the character was not in the scene, it was composited over
 * it. The r12 blind critic named "nothing is grounded" as the single biggest gap and
 * this is part of it: a figure that never darkens as it walks into shade cannot read as
 * being in the same space as the shade.
 *
 * Turning the flag on naively does not work, for the reason recorded in
 * src/creatures/materials.js: the shadow map is ~7 cm/texel and the PCF kernel spans
 * ~22 cm, so on a limb 12 cm thick roughly half the taps land behind the surface no
 * matter which way it faces. The result is not a shadow, it is a uniform ~0.5 on the key
 * everywhere, i.e. a flat character. The avatar is worse off than a Woolkin here because
 * it is assembled from a dozen small convex parts with gaps between them. So the
 * directional lookup gets a much larger depth bias: the avatar still darkens under a
 * tree or a hillside, it just stops shadowing its own sleeve.
 */
function mat(color, rough = 0.82, opts = {}, { shadowBias = -0.00042 } = {}) {
  const m = new THREE.MeshStandardMaterial({
    color, roughness: rough, metalness: 0, ...opts,
  });
  // A thin warm rim along the silhouette. Reference note #4: subtle, ~10-15% of key,
  // but always present — it is what stops a character sinking into the grass.
  m.userData.rim = {
    color: { value: new THREE.Color(1.0, 0.86, 0.66) },
    strength: { value: 0.22 },
  };
  m.userData.uShadowBias = { value: shadowBias };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uRimColor = m.userData.rim.color;
    sh.uniforms.uRimStrength = m.userData.rim.strength;
    sh.uniforms.uShadowBias = m.userData.uShadowBias;

    // onBeforeCompile hands us the shader BEFORE #include resolution, so to touch a line
    // inside a stock chunk we have to expand that chunk ourselves.
    const litBegin = THREE.ShaderChunk.lights_fragment_begin.replace(DIR_SHADOW_LINE,
      'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ],$1uShadowBias,$2) : 1.0;');
    if (!/uShadowBias/.test(litBegin)) {
      console.warn('[player] avatar shader: could not re-bias the directional shadow lookup; '
        + 'the avatar will self-shadow to a flat half-light.');
    }

    sh.fragmentShader = 'uniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uShadowBias;\n' + sh.fragmentShader;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_fragment_begin>', litBegin)
      .replace('#include <opaque_fragment>',
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
    // scene.environment is a PMREM of the sky at environmentIntensity 0.30 (see
    // src/sky/index.js), so a fully metallic helm has almost nothing to reflect and
    // renders near-black. 0.38 keeps the specular roll along the dome and the brow
    // band while leaving enough diffuse for the key to model the shape.
    iron: mat(PAL.iron, 0.44, { metalness: 0.38 }),
    ironDark: mat(PAL.ironDark, 0.55, { metalness: 0.30 }),
    horn: mat(PAL.horn, 0.66),
    // DoubleSide: the mantle is an open sweep with two cut edges, and from a side
    // camera you look straight into them.
    fur: mat(PAL.fur, 0.96, { side: THREE.DoubleSide }),
    beard: mat(PAL.beard, 0.85),
  };

  const root = new THREE.Group();
  root.name = 'avatar';

  const add = (parent, geo, material) => {
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true;
    // r13: was false. See the shadow-bias note on mat() above — the avatar now darkens
    // when it walks into tree or hillside shade instead of being lit identically
    // everywhere, which was half of why it read as composited over the meadow.
    m.receiveShadow = true;
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

  // fur mantle over the shoulders. A lathe ring with a per-vertex noise push: the
  // silhouette has to be ragged or it reads as a rubber donut, and the push is done on
  // the geometry rather than in a shader so it costs nothing at runtime and stays
  // byte-identical per seed.
  {
    // Two rules this shape had to learn the hard way:
    //
    // 1. The profile MUST be monotone in y and run bottom-to-top. A LatheGeometry winds
    //    strictly along the profile, so a folded or top-down profile sweeps surface that
    //    faces inwards: the first pass closed the underside by folding back up, and the
    //    returning leg lit off backfaces — a pale flat shelf, not dark fur. The
    //    underside is never visible from a playable camera, so leave it open.
    // 2. It has to clear the deltoids (x 0.176 + r 0.078 = 0.254) or it is invisible.
    //    At the first pass's 0.244 it sat *under* the shoulder caps and simply never
    //    appeared in any of the five probe framings.
    //
    // The sweep stops 47 degrees short of the back on each side so the bedroll and pack
    // (z -0.11 to -0.26) sit in a gap rather than intersecting the pelt. From directly
    // behind you see the two cut edges flanking the pack, which is what a pelt worn
    // under a pack strap does anyway.
    // 40 segments, not 24: at 24 the noise below had one sample every 15 degrees of hem,
    // which is coarser than the wobble it is trying to describe, so the pelt came back
    // smooth — a leather cape, not fur.
    const ruff = new THREE.LatheGeometry([
      [0.258, -0.040], [0.259, -0.022], [0.250, -0.004], [0.232, 0.018],
      [0.206, 0.040], [0.178, 0.060], [0.148, 0.082],
    ].map(([r, y]) => new THREE.Vector2(r, y)), 40, -Math.PI * 0.74, Math.PI * 1.48);
    ruff.scale(1.04, 1, 0.90);
    const p = ruff.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      // two octaves: the coarse one breaks the hem line, the fine one gives the shading
      // enough variation that the pelt does not read as moulded plastic
      const n = Math.sin(v.x * 46.0 + v.y * 9.0) * Math.cos(v.z * 39.0 - v.y * 11.0)
        + 0.55 * Math.sin(v.x * 121.0 - v.z * 97.0) * Math.cos(v.z * 109.0 + v.y * 23.0);
      const outer = THREE.MathUtils.smoothstep(Math.hypot(v.x, v.z), 0.14, 0.23);
      p.setXYZ(i, v.x * (1 + n * 0.10 * outer), v.y + n * 0.034 * outer, v.z * (1 + n * 0.10 * outer));
    }
    ruff.computeVertexNormals();
    add(chest, merge([{ geo: ruff, m: M(0, 0.168, -0.010) }]), mats.fur);
  }

  // Scarf ring at the collar — now a thin band tucked under the mantle. At the r13
  // radius it sat directly below the helm's chin line and read as a wide red grin.
  const scarfRing = merge([
    { geo: new THREE.TorusGeometry(0.073, 0.021, 7, 18), m: M(0, 0.244, -0.005, Math.PI / 2, 0, 0, 1.05, 1, 0.9) },
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

  // flat-graphic eyes + brows (reference note #3 — drawn, not modelled). Both sit lower
  // than on the r13 avatar: the helm's brow band occupies y 0.028-0.070, and anything
  // above that line is inside the steel.
  const faceGeo = merge([
    { geo: new THREE.SphereGeometry(0.021, 10, 8), m: M(0.041, -0.020, 0.099, 0, 0, 0, 1, 1.15, 0.30) },
    { geo: new THREE.SphereGeometry(0.021, 10, 8), m: M(-0.041, -0.020, 0.099, 0, 0, 0, 1, 1.15, 0.30) },
    { geo: roundedBox(0.044, 0.010, 0.012, 0.005, 2), m: M(0.043, 0.012, 0.098, 0, 0, -0.20) },
    { geo: roundedBox(0.044, 0.010, 0.012, 0.005, 2), m: M(-0.043, 0.012, 0.098, 0, 0, 0.20) },
  ]);
  add(head, faceGeo, mats.dark);

  // ---- horned iron helm ------------------------------------------------
  //
  // The avatar is seen from behind at 2-4 m nearly all the time, so a helmet earns its
  // budget only if it changes the SILHOUETTE from that angle — a smooth dome does not,
  // it just replaces one round shape with another. What reads at 3 m from behind is the
  // pair of horns breaking the head's outline sideways and the neck guard flaring over
  // the collar, so those get the vertices; the face-side detail (nose guard, cheek
  // plates, rivets) is cheap and only pays off in the dialogue/idle framings.
  const helmGeo = merge([
    // dome: sits a few mm proud of the 0.108 skull, open at the back for the neck flare
    { geo: lathe([
      [0.121, 0.028], [0.126, 0.055], [0.124, 0.086], [0.112, 0.112],
      [0.086, 0.132], [0.046, 0.146], [0.0, 0.150],
    ], 20), m: M(0, 0.004, -0.006, 0, 0, 0, 1.02, 1.0, 1.06) },
    // brow band — the heavy forged ring the horns and the nose guard hang off
    { geo: new THREE.TorusGeometry(0.122, 0.0215, 7, 22), m: M(0, 0.049, -0.006, Math.PI / 2, 0, 0, 1.02, 1, 1.06) },
    // Nose guard down the centre line. The first pass had it 34 mm wide and the cheek
    // plates 36 mm wide sitting at z 0.056 — three vertical slabs across a 21 cm face,
    // which left two isolated slots of skin and read as a mask, not a helmet. The rule
    // that fixed it: the face opening has to be wider than every bar crossing it.
    { geo: roundedBox(0.024, 0.088, 0.028, 0.010, 3), m: M(0, -0.004, 0.104, 0.16, 0, 0) },
    // (the cheek plates are in the darker merge below — at helm value they rounded up
    // into a pale puck over each ear and read as a headphone)
    // Neck guard: a HALF lathe over the back of the skull only.
    //
    // The first pass used a full lathe squashed to 0.62 in z so it would not cover the
    // face — which put its back wall at z -0.085, i.e. *inside* the 0.108 skull, so it
    // rendered nothing at all and the back of the head was a bare skin ball under the
    // dome from every following-camera angle. LatheGeometry takes phiStart/phiLength
    // (phi 0 is +Z, phi PI is -Z), so the back half can be swept directly at full
    // radius instead of scaling a full ring down until it disappears.
    // Points run BOTTOM TO TOP. A lathe's normals follow the profile direction, so a
    // top-down profile sweeps a surface facing inwards — it renders only backfaces and
    // is invisible from outside, which is the second time this shape has vanished
    // (see the mantle in the chest block for the first).
    { geo: new THREE.LatheGeometry(
      [[0.092, -0.092], [0.116, -0.074], [0.130, -0.046], [0.132, -0.010], [0.122, 0.030]]
        .map(([r, y]) => new THREE.Vector2(r, y)), 16, Math.PI * 0.52, Math.PI * 0.96),
      m: M(0, 0.026, -0.008, 0.14, 0, 0) },
  ]);
  add(head, helmGeo, mats.iron);

  // rivets + horn sockets, one shade darker so the band does not read as one slab
  const rivets = [];
  for (let i = 0; i < 9; i++) {
    const a = -1.15 + (i / 8) * 2.30;                 // front arc only
    rivets.push({ geo: new THREE.SphereGeometry(0.011, 6, 5),
      m: M(Math.sin(a) * 0.126, 0.049, Math.cos(a) * 0.130) });
  }
  for (const s of [1, -1]) {
    rivets.push({ geo: new THREE.CylinderGeometry(0.050, 0.042, 0.036, 10),
      m: M(s * 0.103, 0.062, -0.012, 0, 0, s * -1.15) });
    // cheek plate: flat, at the jaw hinge, not across the eyes
    rivets.push({ geo: roundedBox(0.022, 0.092, 0.056, 0.014, 3),
      m: M(s * 0.108, -0.026, 0.022, 0.06, s * -0.30, s * 0.10) });
  }
  add(head, merge(rivets), mats.ironDark);

  // the horns themselves: out, up and forward, tips curling in over the brow
  const hornGeo = merge([1, -1].map(s => ({
    geo: horn([
      [s * 0.108, 0.062, -0.012],
      [s * 0.168, 0.098, -0.026],
      [s * 0.216, 0.170, -0.010],
      [s * 0.232, 0.252, 0.048],
      [s * 0.206, 0.312, 0.116],
    ], 0.046, 0.008, { ridges: 9 }),
  })));
  add(head, hornGeo, mats.horn);

  // ---- hair & beard ----------------------------------------------------
  // Only what escapes the helm: a nape tuft and two side locks. The r13 spike cap is
  // gone — it lived entirely inside the dome.
  const hairGeo = [];
  const tuft = new THREE.ConeGeometry(0.054, 0.16, 7);
  tuft.translate(0, -0.062, 0);
  hairGeo.push({ geo: tuft, m: M(0, -0.052, -0.090, 0.55, 0, 0) });
  for (let i = 0; i < 6; i++) {
    const s = i < 3 ? 1 : -1;
    const len = rng.range(0.085, 0.145);
    const lock = new THREE.ConeGeometry(rng.range(0.020, 0.030), len, 6);
    lock.translate(0, -len * 0.42, 0);
    hairGeo.push({ geo: lock,
      m: M(s * rng.range(0.082, 0.104), -0.028, rng.range(-0.062, 0.010),
        rng.range(-0.10, 0.22), 0, s * rng.range(0.15, 0.45)) });
  }
  add(head, merge(hairGeo), mats.hair);

  // short beard along the jaw — the Nord read is as much the beard as the horns
  // The first pass built this at r 0.084 around a 0.108 skull, i.e. entirely inside the
  // head — the dark band under the eyes people would have read as a beard was the cheek
  // plates' shadow. A beard has to clear the skull it grows on.
  const beardGeo = merge([
    { geo: new THREE.SphereGeometry(0.112, 16, 12, 0, Math.PI * 2, Math.PI * 0.50, Math.PI * 0.50),
      m: M(0, -0.040, 0.004, -0.08, 0, 0, 1.02, 1.32, 1.04) },
    { geo: roundedBox(0.062, 0.024, 0.030, 0.010, 2), m: M(0, -0.046, 0.094, 0.10, 0, 0) },  // moustache
  ]);
  add(head, beardGeo, mats.beard);

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
