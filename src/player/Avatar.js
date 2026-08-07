import * as THREE from 'three';

/**
 * Procedural stylised humanoid — "the traveller".
 *
 * Built entirely from lathes, spheres and rounded boxes at runtime (no assets).
 * Proportions are anime-heroic rather than realistic: ~6.9 heads, 1.78 m, narrow
 * waist, wide shoulder line, heavy boots. It is seen from behind at 2-4 m almost
 * all the time, so the silhouette budget goes into the back: the horned helm's
 * profile, the shoulder pelts and the jetpack's twin tanks.
 *
 * r14 re-dressed the traveller: horned iron helm, dark leather cuirass with a
 * concentric boss, one pauldron, bare upper arms, fur at the shoulders, and a jetpack
 * where the bedroll pack used to be. The spiked hair, the canvas pack and the red
 * scarf that used to carry the back are gone.
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
  // the face reads through a 5 cm slot in a steel shell, so it is never lit like a bare
  // arm is. Painting the skull darker than `skin` is the cheapest stand-in for the
  // occlusion the helmet should be casting and is most of what separates "a face in a
  // helmet" from "a helmet resting on a face".
  faceShade: 0xc0916c,
  // Auburn 0xa8462a was the traveller's hair when the traveller had a spiked anime cap
  // of it. Under the helm only the nape tuft and six side locks escape, and as cones at
  // that saturation they read from behind as a red scarf tied at the neck — which is
  // exactly what they were reported as. Matched to the beard instead.
  hair: 0x4a3220,
  // r14: the traveller's blue-grey wool became dark oiled leather to match the
  // reference plate's cuirass. Everything cut from `jacket` (torso, collar, coat tail)
  // follows, which is what makes the silhouette read as armour rather than as a coat.
  jacket: 0x453a31,
  jacketDark: 0x2f2721,
  shirt: 0x9c9179,
  trouser: 0x4b453c,
  leather: 0x6d4b32,
  strap: 0x5d452e,
  canvas: 0x534c3b,
  glove: 0x3a3831,
  bedroll: 0xc7bda0,
  eye: 0x241c18,
  berry: 0xbe3a2f,
  leaf: 0x5c8a3a,
  // Nord kit (r14): horned iron helm + fur mantle.
  // The first pass had the helm at 0x5b616b, which is the same value AND the same
  // blue-grey family as the jacket (0x333c52) — under a blue sky key the two merged
  // into one shape and the helmet stopped reading as metal at all. Steel has to be
  // lighter than the cloth it sits on and pulled off the cloth's hue.
  //
  // Values then re-matched against the art direction the helm is going for: dark,
  // desaturated and warm-neutral, closer to charcoal than to bright steel — and,
  // importantly, THE HORNS ARE THE SAME VALUE AS THE HELM. Reading them as pale bone
  // was the single biggest miss; they are dark keratin that separates from the steel
  // only by being warmer and a touch lighter at the tips.
  iron: 0x4b4a46,
  ironDark: 0x45443f,
  horn: 0x585047,
  // the reference plate's pelt is nearly black; 0x5a4a3c came back as pale tan under a
  // meadow key and read as paper, not fur
  fur: 0x3f362e,
  // darker and less saturated than the hair: at 0x9c4a2c the beard read as a red bib
  // hanging off the chin rather than as hair in the helm's shade
  // and darker again after the flip: in full sun 0x7c3a22 lit up to brick red across
  // the whole lower face and read as a bandana over the mouth, not as hair
  beard: 0x46301f,
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
 * THE RIG FACES -Z. Everything else in the player system agrees on this: the movement
 * basis is `fwd = (-sin(yaw), 0, -cos(yaw))` with `root.rotation.y = bodyYaw`, the IK
 * pole vector that decides which way the knees bend is (0, 0, -1), the stride puts the
 * leading foot at negative local z, and the boots' toes are modelled at z -0.15.
 *
 * The torso and head, however, were authored facing +Z — eyes at z +0.098, pack at
 * z -0.185. So from r13 until this was found the avatar walked with the pack leading and
 * the face trailing: the follow camera sits behind the direction of travel and was
 * therefore looking at the character's FACE the entire time. A bald sphere with a nape
 * tuft is ambiguous enough that nobody caught it; a horned helmet with a nose guard is
 * not, which is how it finally surfaced.
 *
 * The parts below are still authored the readable way (face toward +z) and flipped here.
 * The alternative — negating forty z literals by hand — is the same transform with more
 * places to get one sign wrong. Rotation, not mirroring: a mirror would invert the
 * winding of every triangle.
 */
function front(geo) { geo.rotateY(Math.PI); return geo; }

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
    faceShade: mat(PAL.faceShade, 0.74),
    hair: mat(PAL.hair, 0.78),
    jacket: mat(PAL.jacket, 0.85),
    shirt: mat(PAL.shirt, 0.88),
    trouser: mat(PAL.trouser, 0.87),
    leather: mat(PAL.leather, 0.7),
    strap: mat(PAL.strap, 0.8),
    canvas: mat(PAL.canvas, 0.92),
    glove: mat(PAL.glove, 0.78),
    dark: mat(PAL.eye, 0.5),
    berry: mat(PAL.berry, 0.42),
    // scene.environment is a PMREM of the sky at environmentIntensity 0.30 (see
    // src/sky/index.js), so a fully metallic helm has almost nothing to reflect and
    // renders near-black. 0.38 keeps the specular roll along the dome and the brow
    // band while leaving enough diffuse for the key to model the shape.
    iron: mat(PAL.iron, 0.56, { metalness: 0.28 }),
    ironDark: mat(PAL.ironDark, 0.60, { metalness: 0.28 }),
    horn: mat(PAL.horn, 0.74),
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
  add(hips, front(pelvisGeo), mats.trouser);

  // belt + hip pouch + a short coat tail: all leather, one draw call
  const beltGeo = merge([
    { geo: new THREE.TorusGeometry(0.128, 0.021, 6, 20), m: M(0, 0.015, 0, Math.PI / 2, 0, 0, 1, 1, 0.78) },
    { geo: roundedBox(0.05, 0.035, 0.022, 0.008, 2), m: M(0, 0.015, -0.098) },
    { geo: roundedBox(0.10, 0.115, 0.07, 0.025, 3), m: M(0.115, -0.055, 0.01, 0, 0.2, 0.1) },
    { geo: roundedBox(0.055, 0.09, 0.05, 0.02, 3), m: M(-0.125, -0.05, -0.02, 0, -0.25, -0.08) },
  ]);
  add(hips, front(beltGeo), mats.leather);

  // belt plate: the concentric disc the plate wears dead centre, same vocabulary as the
  // chest boss. Pelvis radius 0.134 with a 0.74 z-scale puts the front at ~0.099.
  const beltPlateGeo = merge([
    { geo: new THREE.CylinderGeometry(0.052, 0.048, 0.018, 16), m: M(0, 0.012, 0.096, Math.PI / 2, 0, 0) },
    { geo: new THREE.TorusGeometry(0.036, 0.007, 6, 18), m: M(0, 0.012, 0.106) },
    { geo: new THREE.SphereGeometry(0.012, 8, 6), m: M(0, 0.012, 0.108, 0, 0, 0, 1, 1, 0.7) },
  ]);
  add(hips, front(beltPlateGeo), mats.ironDark);

  // hip cloth hanging at the back — reads as a coat tail from behind
  const clothGeo = merge([
    { geo: lathe([[0.150, -0.26], [0.152, -0.18], [0.142, -0.09], [0.128, -0.01]], 16),
      m: M(0, 0, -0.012, 0, 0, 0, 1, 1, 0.8) },
  ]);
  add(hips, front(clothGeo), mats.jacket);

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
  add(chest, front(jacketGeo), mats.jacket);

  // shirt showing at the chest opening
  const shirtGeo = merge([
    { geo: lathe([[0.070, -0.10], [0.088, 0.0], [0.098, 0.10], [0.092, 0.19], [0.070, 0.235]], 14),
      m: M(0, 0, 0.012, 0, 0, 0, 1, 1, 0.62) },
  ]);
  add(chest, front(shirtGeo), mats.shirt);

  // ---- the cuirass hardware --------------------------------------------
  //
  // Three shapes carry the plate's chest, and they are all round metal on dark leather:
  // a big concentric BOSS high on the wearer's right, a layered PAULDRON over that same
  // shoulder, and the belt plate down on the hips (in the hips block). The torso lathe
  // is scaled 0.70 in z, so its front surface at chest y 0.02 is only ~0.104 out — the
  // boss has to sit at 0.10, not at the 0.14 the un-squashed radius suggests, or it
  // floats a centimetre proud of the chest.
  const bossGeo = merge([
    { geo: new THREE.CylinderGeometry(0.074, 0.068, 0.022, 20), m: M(0.052, 0.062, 0.098, Math.PI / 2, 0, 0) },
    { geo: new THREE.TorusGeometry(0.055, 0.009, 6, 20), m: M(0.052, 0.062, 0.111) },
    { geo: new THREE.TorusGeometry(0.031, 0.007, 6, 16), m: M(0.052, 0.062, 0.113) },
    { geo: new THREE.SphereGeometry(0.015, 8, 6), m: M(0.052, 0.062, 0.115, 0, 0, 0, 1, 1, 0.7) },
    // the strap yoke it hangs from
    { geo: roundedBox(0.030, 0.080, 0.020, 0.008, 2), m: M(0.052, 0.128, 0.086, 0.35, 0, -0.10) },
  ]);
  add(chest, front(bossGeo), mats.ironDark);

  // pauldron: an angular cap over the right deltoid with a rivet boss, sitting proud of
  // the fur. One shoulder only — the plate's left shoulder is bare mail and fur, and an
  // asymmetric pauldron is most of what makes that armour read as hand-made.
  const pauldronGeo = merge([
    { geo: roundedBox(0.185, 0.062, 0.170, 0.026, 3), m: M(0.176, 0.182, -0.004, 0, 0, -0.30) },
    { geo: roundedBox(0.150, 0.048, 0.140, 0.022, 3), m: M(0.196, 0.140, -0.004, 0, 0, -0.44) },
    { geo: new THREE.CylinderGeometry(0.030, 0.026, 0.016, 12), m: M(0.183, 0.196, 0.004, 0, 0, 0.20) },
    { geo: new THREE.SphereGeometry(0.011, 8, 6), m: M(0.183, 0.203, 0.004) },
  ]);
  add(chest, front(pauldronGeo), mats.iron);

  // JETPACK — the twin-tank rig off GTA San Andreas, in the place the bedroll pack used
  // to sit. Its shape language is: one flat backplate against the spine, two vertical
  // tanks either side of it with domed caps, a flared nozzle under each tank, and a yoke
  // over the top joining the pair.
  //
  // The tanks sit at x +-0.105 and z -0.185. That is INSIDE the shoulder pelts' 0.26
  // radius but behind their 80-degree rear gap, which is the same gap the old pack used;
  // the fur closes over the harness at the shoulder and leaves the tanks clear.
  const jetBodyGeo = merge([
    { geo: roundedBox(0.235, 0.285, 0.075, 0.030, 3), m: M(0, 0.045, -0.150) },
    // tanks
    { geo: new THREE.CylinderGeometry(0.062, 0.062, 0.255, 14), m: M(0.105, 0.050, -0.196) },
    { geo: new THREE.CylinderGeometry(0.062, 0.062, 0.255, 14), m: M(-0.105, 0.050, -0.196) },
    { geo: new THREE.SphereGeometry(0.062, 14, 8), m: M(0.105, 0.178, -0.196, 0, 0, 0, 1, 0.72, 1) },
    { geo: new THREE.SphereGeometry(0.062, 14, 8), m: M(-0.105, 0.178, -0.196, 0, 0, 0, 1, 0.72, 1) },
    // the yoke over the top
    { geo: new THREE.CylinderGeometry(0.026, 0.026, 0.215, 10), m: M(0, 0.196, -0.196, 0, 0, Math.PI / 2) },
  ]);
  add(chest, front(jetBodyGeo), mats.iron);

  const jetTrimGeo = merge([
    // nozzles: a flared bell under each tank, angled a few degrees outboard
    { geo: new THREE.CylinderGeometry(0.048, 0.072, 0.085, 14), m: M(0.108, -0.108, -0.196, 0, 0, 0.06) },
    { geo: new THREE.CylinderGeometry(0.048, 0.072, 0.085, 14), m: M(-0.108, -0.108, -0.196, 0, 0, -0.06) },
    // banding round the tanks
    { geo: new THREE.TorusGeometry(0.064, 0.010, 6, 16), m: M(0.105, 0.118, -0.196, Math.PI / 2, 0, 0) },
    { geo: new THREE.TorusGeometry(0.064, 0.010, 6, 16), m: M(-0.105, 0.118, -0.196, Math.PI / 2, 0, 0) },
    { geo: new THREE.TorusGeometry(0.064, 0.010, 6, 16), m: M(0.105, -0.028, -0.196, Math.PI / 2, 0, 0) },
    { geo: new THREE.TorusGeometry(0.064, 0.010, 6, 16), m: M(-0.105, -0.028, -0.196, Math.PI / 2, 0, 0) },
    // control box on the backplate
    { geo: roundedBox(0.105, 0.075, 0.030, 0.012, 2), m: M(0, 0.130, -0.108) },
  ]);
  add(chest, front(jetTrimGeo), mats.ironDark);

  // The bells' throats, unlit. A cold jetpack should still read as having somewhere for
  // the flame to come out of, and a dark disc inside the bell does that for free — no
  // emissive, no light, nothing for the deterministic capture to disagree about.
  const jetThroatGeo = merge([
    { geo: new THREE.CylinderGeometry(0.052, 0.052, 0.012, 12), m: M(0.108, -0.140, -0.196, 0, 0, 0.06) },
    { geo: new THREE.CylinderGeometry(0.052, 0.052, 0.012, 12), m: M(-0.108, -0.140, -0.196, 0, 0, -0.06) },
  ]);
  add(chest, front(jetThroatGeo), mats.dark);

  /**
   * THE PLUMES. Two cones per nozzle — a wide orange envelope and a narrow white core —
   * hanging apex-up from the bell throats so they grow downward as thrust rises.
   *
   * They are the one part of this file that is NOT lit: MeshBasicMaterial, additive,
   * `depthWrite: false`. A flame that takes the sun's shading is a flame that goes dark
   * when the traveller flies into a hillside's shadow, and additive geometry that writes
   * depth punches a hole in everything drawn behind it in the same frame.
   *
   * No point light. A dynamic light here would move the whole frame's exposure and the
   * bloom threshold with it, which is exactly what the two-sided guardrail bands in
   * tools/measure.py are watching; the plume reaches the bloom on its own by being
   * brighter than the threshold. `castShadow` is off for the same reason — a flame that
   * casts a shadow reads as a solid object.
   *
   * The nozzle x/z here are the FLIPPED coordinates (see front()): the jetpack geometry
   * was authored with the pack behind +z and rotated, so its bells now sit at z +0.196.
   */
  const jets = [];
  for (const s of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(s * -0.108, -0.150, 0.196);
    g.rotation.z = s * -0.06;
    chest.add(g);
    const cone = (r, len, color, op) => {
      const geo = new THREE.ConeGeometry(r, len, 10, 1, true);
      geo.translate(0, -len / 2, 0);          // apex at the throat, body hanging down
      geo.rotateX(Math.PI);                   // ...and pointing the right way
      geo.translate(0, -len, 0);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: op, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: true,
      }));
      m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
      g.add(m);
      return m;
    };
    jets.push({ group: g, outer: cone(0.052, 0.30, 0xff7a2a, 0.55), core: cone(0.026, 0.20, 0xfff0c8, 0.85) });
  }

  const strapGeo = merge([
    { geo: roundedBox(0.045, 0.30, 0.030, 0.012, 2), m: M(0.105, 0.075, 0.075, 0.30, 0, 0.06) },
    { geo: roundedBox(0.045, 0.30, 0.030, 0.012, 2), m: M(-0.105, 0.075, 0.075, 0.30, 0, -0.06) },
    { geo: roundedBox(0.045, 0.12, 0.030, 0.012, 2), m: M(0.115, 0.175, -0.11, -0.5, 0, 0.06) },
    { geo: roundedBox(0.045, 0.12, 0.030, 0.012, 2), m: M(-0.115, 0.175, -0.11, -0.5, 0, -0.06) },
  ]);
  add(chest, front(strapGeo), mats.strap);

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
    //
    // TWO SHOULDER PELTS, NOT A BIB. A single sweep across the front turned the whole
    // chest into fur, and on the reference plate the chest is bare leather carrying the
    // boss — the fur is at the shoulders and again at the waist. Splitting the sweep in
    // two (phi 0 is +z, so each shoulder is centred on ±PI/2) leaves an 80-degree gap
    // at the front for the cuirass and one at the back for the pack.
    const pelts = [];
    for (const s of [1, -1]) {
      const ruff = new THREE.LatheGeometry([
        [0.262, -0.052], [0.264, -0.030], [0.252, -0.008], [0.232, 0.016],
        [0.206, 0.040], [0.178, 0.060], [0.148, 0.082],
      ].map(([r, y]) => new THREE.Vector2(r, y)), 26,
      s > 0 ? Math.PI * 0.22 : -Math.PI * 0.78, Math.PI * 0.56);
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
      pelts.push({ geo: ruff, m: M(0, 0.168, -0.010) });
    }
    add(chest, front(merge(pelts)), mats.fur);
  }

  // THE SCARF IS GONE (ring at the collar + vertex-animated tail). It was the last
  // saturated red on the character and, once the kit went to dark leather and steel, the
  // only thing on the model that was not in the reference plate's palette — under the
  // helm's chin line it read as a red grin. `rig.scarfTail` is still exported as null so
  // the animator's tail block can skip itself; see the guard there.

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
  add(head, front(skullGeo), mats.faceShade);

  // flat-graphic eyes + brows (reference note #3 — drawn, not modelled). Both sit lower
  // than on the r13 avatar: the helm's brow band occupies y 0.028-0.070, and anything
  // above that line is inside the steel.
  const faceGeo = merge([
    // dropped 10 mm when the shell came down over the temples — at y -0.020 the brow
    // band cut the top off both eyes and the character read as permanently squinting
    { geo: new THREE.SphereGeometry(0.020, 10, 8), m: M(0.040, -0.030, 0.099, 0, 0, 0, 1, 1.10, 0.30) },
    { geo: new THREE.SphereGeometry(0.020, 10, 8), m: M(-0.040, -0.030, 0.099, 0, 0, 0, 1, 1.10, 0.30) },
    { geo: roundedBox(0.044, 0.010, 0.012, 0.005, 2), m: M(0.043, 0.012, 0.098, 0, 0, -0.20) },
    { geo: roundedBox(0.044, 0.010, 0.012, 0.005, 2), m: M(-0.043, 0.012, 0.098, 0, 0, 0.20) },
  ]);
  add(head, front(faceGeo), mats.dark);

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
    // The shell now starts at y -0.030, not +0.028. On the plate the helm comes down
    // over the temples to below the eye line and the face reads as a narrow keyhole in a
    // dark shell; ours stopped at the brow, so a big bright oval of cheek and forehead
    // sat inside the frame and the whole head read as a cartoon face wearing a hat.
    // TALLER AND MORE CONICAL. Side by side with the plate, a hemispherical cap reads
    // as a bowler hat: the reference shell keeps its width to above the brow and then
    // rises to a soft point 3.5 cm higher than a hemisphere would. The crown is where
    // most of the difference in silhouette was.
    { geo: lathe([
      [0.118, -0.030], [0.125, 0.004], [0.127, 0.044], [0.123, 0.086], [0.112, 0.124],
      [0.092, 0.152], [0.060, 0.174], [0.026, 0.186], [0.0, 0.190],
    ], 20), m: M(0, 0.004, -0.006, 0, 0, 0, 1.02, 1.0, 1.06) },
    // Sagittal crest: the raised rib the plate runs front-to-back over the crown. It is
    // the single feature that stops the dome reading as a bowl, and it is visible from
    // the follow camera, which sees the top of the head more than the face.
    //
    // A partial TorusGeometry starts its arc at +X in its OWN xy plane and sweeps
    // counter-clockwise, so orienting one of these is entirely about where that start
    // lands. The crest wants the ring in the yz plane: rotate about Y by exactly PI/2
    // and the 0..PI arc maps -Z -> +Y -> +Z, i.e. front to back over the crown. The
    // first attempt also spun it PI*0.98 about Z, which swung the half-ring under the
    // head and left a stray knob poking through the top of the dome.
    // Both arcs are TRIMMED at both ends (0.13*PI in, 0.74*PI long). A half-ring ends
    // at its own equator, i.e. at ear height on the crest and at the nose on the band,
    // and a lathe's cut face is a flat disc — so the untrimmed version finished in four
    // little stubs poking out of the sides of the helmet.
    { geo: new THREE.TorusGeometry(0.130, 0.0130, 6, 24, Math.PI * 0.84),
      m: M(0, 0.004, -0.006, 0, Math.PI / 2, Math.PI * 0.06, 1, 1.10, 1.04) },
    { geo: new THREE.TorusGeometry(0.127, 0.0110, 6, 22, Math.PI * 0.74),
      m: M(0, 0.004, 0.004, 0, 0, Math.PI * 0.13, 1.02, 1, 1) },
    // brow band — the heavy forged ring the horns and the nose guard hang off
    { geo: new THREE.TorusGeometry(0.122, 0.0195, 7, 22), m: M(0, 0.049, -0.006, Math.PI / 2, 0, 0, 1.02, 1, 1.06) },
    // A pair of angled V brow ridges lived here across two iterations and is gone. The
    // plate does have them, but at this scale the front of the helm already carries the
    // nose guard and two cheek plates, and a fourth and fifth bar across a 21 cm face
    // read as a cage over it. The V now comes from the DOME's lower edge instead, which
    // dips to y -0.030 at the temples (below).
    
    // Nose guard down the centre line. The first pass had it 34 mm wide and the cheek
    // plates 36 mm wide sitting at z 0.056 — three vertical slabs across a 21 cm face,
    // which left two isolated slots of skin and read as a mask, not a helmet. The rule
    // that fixed it: the face opening has to be wider than every bar crossing it.
    { geo: roundedBox(0.024, 0.112, 0.028, 0.010, 3), m: M(0, -0.016, 0.102, 0.16, 0, 0) },
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
  add(head, front(helmGeo), mats.iron);

  // rivets + horn sockets, one shade darker so the band does not read as one slab
  const rivets = [];
  for (let i = 0; i < 7; i++) {
    const a = -0.95 + (i / 6) * 1.90;                 // front arc only
    rivets.push({ geo: new THREE.SphereGeometry(0.010, 6, 5),
      m: M(Math.sin(a) * 0.124, 0.049, Math.cos(a) * 0.128) });
  }
  // rivets up the crown strap. These have to follow the DOME's arc, not a straight
  // line: the first version stepped y and z independently and put the topmost rivet
  // out in the air above the crown, where it read as a knob screwed to the helmet.
  for (let i = 0; i < 4; i++) {
    const a = 0.46 + (i / 3) * 0.55;                  // radians up from the front
    rivets.push({ geo: new THREE.SphereGeometry(0.0095, 6, 5),
      m: M(0, 0.004 + Math.sin(a) * 0.150, Math.cos(a) * 0.128) });
  }
  for (const s of [1, -1]) {
    // horn socket — a forged collar where the horn leaves the CROWN (it used to sit on
    // the side of the band, which is where the horns used to start)
    rivets.push({ geo: new THREE.CylinderGeometry(0.040, 0.033, 0.028, 10),
      m: M(s * 0.060, 0.114, -0.008, 0, 0, s * -0.64) });
    // CHEEK PLATES: long angular fangs, not pucks. On the plate they start under the
    // temple, run down PAST the jaw and finish in a point below it, and they close in
    // toward the chin so the face opening is a narrow keyhole with the eyes at the top
    // of it. Two boxes: the wide upper plate and the tapered point below.
    rivets.push({ geo: roundedBox(0.026, 0.108, 0.074, 0.012, 3),
      m: M(s * 0.090, -0.020, 0.034, 0.05, s * -0.26, s * 0.12) });
    rivets.push({ geo: roundedBox(0.020, 0.070, 0.046, 0.010, 3),
      m: M(s * 0.084, -0.092, 0.038, 0.05, s * -0.26, s * 0.22) });
    // (a temple slot piece lived here and was deleted: at x 0.106 it cleared the
    // helmet's own outline and read as a bar sticking out of the side of the head)
  }
  add(head, front(merge(rivets)), mats.ironDark);

  // THE HORNS ARE A RAM ARC, NOT A PAIR OF SPIKES. Read off the reference plate at 4x:
  // they are socketed high on the CROWN, close to the midline; they rise only a little
  // before the arc turns over at its widest point, and then they come back DOWN the
  // outside of the helmet with the tips finishing beside the cheekbone, below the brow
  // band, pointing down and slightly inboard. The whole horn is a C that opens downward
  // and inward.
  //
  // Two wrong versions preceded this one, and both failed the same way — the tip was
  // the highest point of the horn. Up-and-forward (curling over the brow) is a bull;
  // up-and-back is an oryx. What makes the silhouette read as *this* helmet is that the
  // horn descends over the second half of its length.
  const hornGeo = merge([1, -1].map(s => ({
    geo: horn([
      [s * 0.064, 0.118, -0.008],
      [s * 0.146, 0.156, 0.000],
      [s * 0.212, 0.120, 0.018],
      [s * 0.226, 0.034, 0.044],
      [s * 0.196, -0.048, 0.068],
      // The arc has to BOW well clear of the 0.126 dome — at a 0.204 waist the horn
      // hugged the helmet and, from the follow camera that sees the character 90% of
      // the time, the pair collapsed into two little ears against the skull. 0.242
      // keeps the gap open in the rear silhouette. Thick, too: 0.056 at the socket and
      // still 0.013 at the tip, because the plate's horns are heavy all the way out
      // and only needle in the last fifth.
    ], 0.050, 0.012, { ridges: 12, ridgeAmt: 0.095, flat: 0.80 }),
  })));
  add(head, front(hornGeo), mats.horn);

  // ---- hair & beard ----------------------------------------------------
  // Only what escapes the helm: a nape tuft and two side locks. The r13 spike cap is
  // gone — it lived entirely inside the dome.
  const hairGeo = [];
  const tuft = new THREE.ConeGeometry(0.050, 0.125, 7);
  tuft.translate(0, -0.050, 0);
  hairGeo.push({ geo: tuft, m: M(0, -0.056, -0.086, 0.55, 0, 0) });
  for (let i = 0; i < 6; i++) {
    const s = i < 3 ? 1 : -1;
    const len = rng.range(0.085, 0.145);
    const lock = new THREE.ConeGeometry(rng.range(0.020, 0.030), len, 6);
    lock.translate(0, -len * 0.42, 0);
    hairGeo.push({ geo: lock,
      m: M(s * rng.range(0.082, 0.104), -0.028, rng.range(-0.062, 0.010),
        rng.range(-0.10, 0.22), 0, s * rng.range(0.15, 0.45)) });
  }
  add(head, front(merge(hairGeo)), mats.hair);

  // short beard along the jaw — the Nord read is as much the beard as the horns
  // The first pass built this at r 0.084 around a 0.108 skull, i.e. entirely inside the
  // head — the dark band under the eyes people would have read as a beard was the cheek
  // plates' shadow. A beard has to clear the skull it grows on.
  const beardGeo = merge([
    // ...and it starts BELOW the equator (thetaStart 0.58, not 0.50). Cutting at the
    // equator wrapped the whole lower face from cheekbone to jaw in one unbroken shell,
    // which at meadow key values reads as a mask over the mouth however dark it is.
    { geo: new THREE.SphereGeometry(0.110, 16, 12, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38),
      m: M(0, -0.030, 0.004, -0.08, 0, 0, 1.02, 1.30, 1.04) },
    { geo: roundedBox(0.056, 0.020, 0.028, 0.008, 2), m: M(0, -0.050, 0.094, 0.10, 0, 0) },  // moustache
  ]);
  add(head, front(beardGeo), mats.beard);

  // ---- arms ------------------------------------------------------------
  function arm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * RIG.shoulderHalf, RIG.shoulderY, 0);
    chest.add(shoulder);
    // BARE UPPER ARM. The plate's cuirass is sleeveless — that bare arm between the
    // pauldron and the bracer is half of why the armour reads as heavy, because there
    // is skin next to it for scale. Was mats.jacket, i.e. a full sleeve.
    add(shoulder, limb(0.062, 0.048, RIG.upperArm, 10), mats.skin);
    // arm ring at the top of the biceps, where the sleeve used to end
    add(shoulder, merge([
      { geo: limb(0.066, 0.064, 0.040, 10), m: M(0, -0.012, 0) },
    ]), mats.strap);

    const elbow = new THREE.Group();
    elbow.position.y = -RIG.upperArm;
    shoulder.add(elbow);
    add(elbow, limb(0.050, 0.038, RIG.foreArm, 10), mats.skin);
    // bracer
    add(elbow, merge([
      { geo: limb(0.054, 0.050, 0.075, 10), m: M(0, -0.005, 0) },
    ]), mats.leather);

    const hand = new THREE.Group();
    hand.name = side > 0 ? 'handR' : 'handL';   // probes measure wrist-to-grip by name
    hand.position.y = -RIG.foreArm;
    elbow.add(hand);
    add(hand, merge([
      { geo: new THREE.SphereGeometry(0.050, 10, 8), m: M(0, -0.030, 0, 0, 0, 0, 0.82, 1.15, 0.66) },
      { geo: new THREE.SphereGeometry(0.024, 8, 6), m: M(side * 0.036, -0.022, -0.010) },  // thumb, forward = -z
    ]), mats.glove);
    return { shoulder, elbow, hand };
  }
  const armR = arm(1);
  const armL = arm(-1);

  // held berry (feeding gesture prop)
  const berry = new THREE.Group();
  berry.position.set(0, -0.075, -0.02);   // in front of the palm; the rig faces -z
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
    rig: { hips, chest, neck, head, armR, armL, legR, legL, berry,
      scarfTail: null, scarfBase: null },
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

    /**
     * Jet plume, driven by src/player once per frame.
     *
     * @param thrust  0..1
     * @param flick   a signed flicker, -1..1, that the CALLER samples from ctx.noise at
     *                the simulated time. It is not generated here on purpose: this file
     *                has no rng and no clock, and both are forbidden anyway — the same
     *                seed and the same number of simulated seconds have to produce a
     *                byte-comparable frame.
     *
     * Thrust 0 leaves a pilot flame rather than nothing. A jetpack whose bells go
     * completely dark while the traveller hovers reads as broken hardware.
     */
    setJetThrust(thrust, flick = 0) {
      // a negative thrust means "the jets are off entirely" — hide the plumes rather
      // than leave a pilot flame burning on a traveller who is standing in a meadow
      if (thrust < 0) { for (const j of jets) j.group.visible = false; return; }
      for (const j of jets) j.group.visible = true;
      const t = thrust > 1 ? 1 : thrust;
      const lit = 0.16 + t * 0.84;                       // pilot flame at rest
      for (let i = 0; i < jets.length; i++) {
        const j = jets[i];
        const f = 1 + flick * (0.10 + t * 0.16) * (i === 0 ? 1 : -1);
        j.outer.scale.set(0.55 + t * 0.45, lit * f, 0.55 + t * 0.45);
        j.core.scale.set(0.5 + t * 0.5, lit * f * 0.86, 0.5 + t * 0.5);
        j.outer.material.opacity = 0.16 + t * 0.46;
        j.core.material.opacity = 0.26 + t * 0.62;
      }
    },
  };
}
