import * as THREE from 'three';
import { clamp, lerp, smoothstep, hash2i } from './util.js';
import { mergeGeos, paint, makeAerialMaterial, applyMossShader, setAerialPivot } from './materials.js';
import { applyContactShade, beginPropChannel } from './vegetation.js';
// The prop broadphase lives in vegetation.js (props.js already imports it, so putting
// it there avoids a cycle) and is re-exported here because this is where a consumer
// looking for "the props" will start. See the PROP BROADPHASE section for the contract.
export { queryProps, propsNear, propColliderCount, resetPropColliders } from './vegetation.js';
import { AX, AZ, PX, PZ, LAKE } from './terrain.js';

/* =================================================================================
 * "NOT ONE OF THE TREES CASTS A SHADOW ONTO THE GROUND" — DIAGNOSED, r19, AND IT IS
 * NEITHER OF THE TWO THINGS IT LOOKS LIKE. Read this before spending another round on
 * the shadow map; three sessions have now gone at it from three directions.
 *
 * The r19 blind critic ranked this second of four: "Count the trees: zero of them
 * darken the ground ... a lollipop tree with no ground shadow is the most obvious
 * tell." Confirmed by eye on captures/r18nohud/vista_golden.png. The two obvious
 * causes were tested and BOTH ARE FALSE:
 *
 *   1. "the trees are missing castShadow."  No. tools/_castattrib.mjs walks the scene
 *      and finds all five tree InstancedMeshes (336 instances) with castShadow true and
 *      visible true, and they measurably self-shadow — turning the flag off changes the
 *      canopies. The depth map contains them.
 *   2. "they are outside the shadow frustum."  No, and this is the expensive one to
 *      re-derive. tools/_treediff.mjs renders the staged vista with the ortho box at
 *      half-size 90, 170 (ship) and 400 and diffs trees-cast on/off in each:
 *
 *          box half-size   90 m     170 m    400 m
 *          tree-shadow mean 0.072   0.076    0.074   (units of 255)
 *          pixels touched   0.43%   0.45%    0.47%
 *
 *      A 4.4x change in reach is worth 0.04% of the frame. This agrees with the
 *      _boxsweep table in sky/index.js and closes the question a third time.
 *
 * THE ACTUAL CAUSE is the one CLAUDE.md already warns about, applied to a slope rather
 * than to the frame: a shadow can only remove the KEY's contribution, and the ground
 * those trees stand on has almost no key on it. tools/_keymap.mjs renders the frame
 * against the same frame with sun.intensity = 0 and reports mean |difference| by region:
 *
 *      tree-covered hillside   2.44 / 255      <- the trees the critic counted
 *      near meadow            51.22
 *      mid meadow             44.16
 *      left hillside          43.09
 *
 * The hillside every visible tree in vista_golden stands on is receiving 5% of the key
 * the meadow beside it receives, because it faces away from the sun. It is ALREADY
 * unlit, and no shadow map of any resolution or extent can darken it further. The
 * amplified trees-on/off diff (captures/_treediff/ship_diff.png) shows this directly:
 * every changed pixel is on a canopy, not one is on the hillside.
 *
 * Two things follow, and neither of them is in this directory:
 *   - The fix is the KEY/FILL RATIO (sky/index.js), not the shadow map. A slope at 5%
 *     of key renders at nearly the same luminance as one at 100% because the unshadowed
 *     fill puts it back; that is why the frame reads as "one global illumination level"
 *     and why the same slope has no visible form of its own either.
 *   - Tree PLACEMENT (vegetation.js) is the other half. Every tree in the frame is on a
 *     hillside at 200-400 m; there is not one in the flat, fully lit near meadow where
 *     its shadow would rake across the ground the camera is actually looking at.
 * ================================================================================= */

// DO NOT "FIX" THIS TO `new THREE.Color(hex)`, however much CLAUDE.md's double-decode
// trap says you should. It IS the double decode — and world/index.js already knows,
// and compensates for it with `liftVertexAlbedo(m.geometry, 4.6)` on every rock mesh it
// adds. Removing the second conversion here without removing that gain there makes
// every boulder 4.6x too bright, and liftVertexAlbedo clamps at 1.0 per channel, so
// what you actually get is a white rock with a red cast (the warm ledge tint clips
// first in red). The two lines have to move together, and the lift is in a file this
// system does not own. Flagged in the r19 report instead.
const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();
const toWorld = (u, v) => [u * AX + v * PX, u * AZ + v * PZ];

/**
 * A SPECULAR LOBE ON A LAMBERT MATERIAL — reference #8 / the r19 blind critique.
 *
 *   "Lambert-only materials: no specular lobe, no roughness variation, no reflections.
 *    The real frames differentiate materials BY THEIR HIGHLIGHT ... stone is matte. The
 *    imitation has one shading response for the entire world, so a rock, a leaf, a metal
 *    helmet and an animal's fleece are distinguishable only by hue."
 *
 * "Stone is matte" is not "stone has no lobe". A dry facet of granite still has a
 * dielectric F0 of ~0.04 and a Fresnel that climbs to 1.0 at grazing, and that grazing
 * climb is the entire reason a real boulder's silhouette separates from the grass behind
 * it. Ours had none, because MeshLambertMaterial has no specular path at all — its
 * RE_Direct writes directDiffuse and nothing else.
 *
 * WHY NOT JUST SWITCH THE STONE TO MeshStandardMaterial. Measured, and rejected: the
 * standard/physical shader also turns on the IBL, and `scene.environment` is a PMREM of
 * a GROUND-LESS sky sphere (see the long note in creatures/materials.js). Every rock's
 * underside would be lit by sky, which is the exact flatness this round is trying to
 * remove — and it would have arrived alongside the specular that was supposed to fix it,
 * so neither could be attributed. A hand-written direct lobe costs ~15 lines of GLSL,
 * adds no indirect term, and leaves the ambient exactly where the round before this one
 * measured it.
 *
 * The lobe is injected into RE_Direct_Lambert rather than appended after
 * lights_fragment_end, on purpose: inside RE_Direct, `directLight.color` has ALREADY
 * been multiplied by the shadow map. A highlight appended afterwards has no way to see
 * the shadow term and burns straight through cast shadow, which reads as a rock that is
 * lit from inside.
 *
 * MEASURE THIS ON tools/_stoneshot.mjs, NOT ON THE SIX MATCHED SHOTS. Rocks and ruins
 * move 0.30% of the pixels in vista_golden and 0.09% in overshoulder_meadow, so the
 * whole of this function plus the cavity and course-joint bakes below register as
 * +0.1 on `mean` and nothing at all on `edge` in measure.py. That is not evidence the
 * stone is fine; it is evidence the graded framings never point at any. On the ruin
 * close-up the same change is worth, over stone pixels only: value span (p95-p05)
 * 124.9 -> 144.9, sd 51.9 -> 57.0, with whole-frame `edge` flat at 5.18 — more form,
 * no extra high-frequency noise.
 *
 * ROUGHNESS VARIATION comes from a hash of the face normal. The stone geometry is
 * flat-shaded, so the normal is constant across a facet and the hash is therefore
 * constant across a facet: adjacent facets of the same boulder catch the key at
 * different widths, which is what "roughness variation" looks like on faceted rock.
 * A per-pixel noise would just be sparkle.
 */
export function applyStoneSpecular(mat, { rough = 0.62, spread = 0.22, f0 = 0.045, gain = 1.0 } = {}) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  const f = (v) => v.toFixed(4);
  mat.onBeforeCompile = function (sh, renderer) {
    if (prev) prev.call(this, sh, renderer);
    const src = THREE.ShaderChunk.lights_lambert_pars_fragment;
    const ANCHOR = 'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );';
    if (!src.includes(ANCHOR)) {
      console.warn('[props] Lambert chunk changed shape; stone specular skipped');
      return;
    }
    const chunk = src.replace(ANCHOR, `${ANCHOR}
      {
        // per-facet roughness: the normal is flat across a facet, so this is too
        float h_ = fract( sin( dot( geometryNormal, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
        float rg_ = clamp( ${f(rough)} + ( h_ - 0.5 ) * ${f(spread)}, 0.06, 1.0 );
        float a_ = rg_ * rg_;
        float a2_ = a_ * a_;
        vec3 H_ = normalize( directLight.direction + geometryViewDir );
        float NdH_ = saturate( dot( geometryNormal, H_ ) );
        float VdH_ = saturate( dot( geometryViewDir, H_ ) );
        float NdV_ = max( dot( geometryNormal, geometryViewDir ), 1e-4 );
        float NdL_ = max( dotNL, 1e-4 );
        float d_ = NdH_ * NdH_ * ( a2_ - 1.0 ) + 1.0;
        float D_ = a2_ / ( PI * d_ * d_ );
        // Smith height-correlated visibility, the same one BRDF_GGX uses
        float sv_ = NdL_ * sqrt( NdV_ * NdV_ * ( 1.0 - a2_ ) + a2_ );
        // NB: sl_, not gl_ -- GLSL reserves every identifier that starts with gl_ and the
        // shader fails to link with "reserved built-in name".
        float sl_ = NdV_ * sqrt( NdL_ * NdL_ * ( 1.0 - a2_ ) + a2_ );
        float V_ = 0.5 / max( sv_ + sl_, 1e-6 );
        // F90 is 1.0. Every dielectric goes to full reflectance at grazing, and that
        // climb is the whole point — see creatures/materials.js for the round this cost.
        float F_ = ${f(f0)} + ( 1.0 - ${f(f0)} ) * pow( 1.0 - VdH_, 5.0 );
        reflectedLight.directSpecular += irradiance * ( D_ * V_ * F_ * ${f(gain)} );
      }`);
    // MeshLambertMaterial's own main() composes ONLY directDiffuse + indirectDiffuse +
    // emissive, so a lobe written into reflectedLight.directSpecular is computed and then
    // thrown away. That cost twenty minutes of "the shader compiles and nothing changed";
    // if the stone ever goes flat again, check this line before touching the BRDF.
    const OUT = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';
    if (!sh.fragmentShader.includes(OUT)) {
      console.warn('[props] Lambert outgoingLight line changed shape; stone specular discarded');
      return;
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <lights_lambert_pars_fragment>', chunk)
      .replace(OUT, `${OUT}
        outgoingLight += reflectedLight.directSpecular;`);
  };
  const tag = `stonespec${rough}_${spread}_${f0}_${gain}`;
  mat.customProgramCacheKey = prevKey ? () => prevKey.call(mat) + tag : () => tag;
  return mat;
}

/* ================================================================= ROCKS ====== */

function rockGeometry(rng, noise, detail = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const p = g.attributes.position;
  const sx = rng.range(0.75, 1.4), sy = rng.range(0.5, 0.95), sz = rng.range(0.75, 1.4);
  const ph = rng.range(0, 10);
  // the per-vertex displacement gain, kept for the cavity term below
  const disp = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // stratified: flatten in y and cut faceted steps so it reads as rock, not a potato.
    //
    // `- ph` IS LOAD-BEARING. `ph` is a phase that decorrelates the banding pattern
    // between rocks so they do not all step at the same heights. Added before the round
    // and not taken back out, it stops being a phase and becomes a TRANSLATION: band
    // lands at y + ph, and the lerp keeps 45% of it, baking a constant +0.45*ph lift
    // into the geometry. With ph up to 10 that is up to 4.5 units of rock hanging in
    // mid-air, scaled by the instance scale on top.
    //
    // It cost most of a round to find, because every object-space check exonerates it:
    // the instance ORIGINS are all correctly grounded (mean gap -0.15), the placement
    // code queries heightAt properly, and the bug lives entirely inside the baked
    // vertices. Five separate probes reported "nothing floats" while the frame plainly
    // showed boulders in the sky. If props ever float again, measure the GEOMETRY
    // bounding box against the instance origin, not the origin against the terrain.
    const band = Math.round((y + ph) * 2.6) / 2.6 - ph;
    y = lerp(y, band, 0.45);
    const d = 1 + 0.30 * noise.fbm(x * 2.1 + ph, z * 2.1 - ph, 3) + 0.16 * noise.fbm(y * 3.4, x * 3.4, 2);
    disp[i] = d;
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sz);
  }
  g.computeVertexNormals();
  const n = p.count;
  const nrm = g.attributes.normal;
  const arr = new Float32Array(n * 3);
  // ------------------------------------------------------------------
  // A MATERIAL THAT KNOWS WHICH WAY GRAVITY POINTS.
  //
  // A blind critic, comparing our vista to a real plate: "B's rocks are single
  // untextured grey facets ... plain unpainted light-grey geometry sitting at a
  // compositional focal point", against "A's cliff faces carry layered strata with
  // moss accumulating only on upward-facing ledges — a material that knows which way
  // gravity points."
  //
  // The moss shader was already upward-facing-only. What was missing is the other
  // half: the rock under it was a BLOTCH. The colour was `fbm(x, z)` — a horizontal
  // splatter with no vertical structure at all, so the faceted silhouette had nothing
  // running across it and every facet read as one flat grey.
  //
  // Three gravity-aware terms replace it, sized against the measured sd of noise.fbm
  // (~0.20, centred on 0) rather than assumed to be 0..1:
  //   strata — a function of HEIGHT ONLY, so bands wrap the stone the way bedding
  //            planes do instead of blotching it
  //   ledges — up-facing surfaces are paler and warmer (dust, lichen, sun bleaching);
  //            down-facing ones stay cool and dark
  //   grain  — a fine per-facet break so adjacent facets never share an exact value
  //   cavity — see below
  //
  // ------------------------------------------------------------------
  // CAVITY OCCLUSION, r19. The blind critic's second ranked gap: "the bushes have no
  // occlusion in their own concavities, so a berry cluster reads as spheres floating in
  // front of a lump rather than nestled in it ... nothing has depth, mass, or contact."
  //
  // The same sentence is true of every prop in this file, and the shadow map cannot
  // help: a dent in a boulder is 5-20 cm across and a shadow texel is 6.8 cm, so the
  // occlusion inside it is at best two texels wide before the PCF kernel averages it
  // back to lit. It is the identical arithmetic to the grass-casting null result in
  // vegetation.js and to the creature contact band in creatures/materials.js. Concave
  // occlusion at this scale has to be baked into the geometry that owns it.
  //
  // Two terms, both computed from the displacement that made the dent in the first
  // place, so they cost no extra noise lookups:
  //   bend — how far the shading normal has swung off the radial direction. On a convex
  //          bulge the two agree (bend ~ 0); a crease between two lobes swings the
  //          normal sideways and bend climbs. This is the real curvature signal.
  //   sink — the displacement gain itself. A vertex pushed IN sits at the bottom of a
  //          pocket and sees less of the sky than one pushed out.
  // ------------------------------------------------------------------
  const a = C(0x8e8e85), b = C(0xa9a597), warm = C(0xb2a893), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
    const y = py;
    const strata = noise.fbm(y * 5.2 + ph * 3.0, y * 1.7 - 2.2, 3);
    const grain = noise.fbm(px * 5.5, pz * 5.5, 2);
    const up = clamp(nrm.getY(i), -1, 1);
    const ledge = clamp(up * 0.5 + 0.5, 0, 1);
    const rl = Math.hypot(px, py, pz) || 1;
    const bend = 1 - clamp((nrm.getX(i) * px + nrm.getY(i) * py + nrm.getZ(i) * pz) / rl, -1, 1);
    const cav = clamp(bend * 1.45 + (1 - disp[i]) * 1.10, 0, 1);
    c.copy(a).lerp(b, clamp(0.5 + strata * 2.0, 0, 1));
    c.lerp(warm, ledge * 0.55);
    // 0.36 is the deepest a pocket goes. Past ~0.45 the creases read as painted black
    // lines rather than as shade, which is the failure mode the bush decal had.
    const v = (0.80 + 0.30 * ledge) * (1 + 0.34 * strata + 0.18 * grain) * (1 - 0.36 * cav);
    arr[i * 3] = c.r * v; arr[i * 3 + 1] = c.g * v; arr[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

export function createRocks(ctx, T, rng) {
  const noise = ctx.noise;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  applyMossShader(mat, 0x6b8a3a, { amount: 1.25 });
  // Field stone: matte, but not lobe-less. Rough enough that the highlight is a wide
  // wash across a facet rather than a dot, with a per-facet break so a boulder does not
  // catch the key uniformly. See applyStoneSpecular.
  applyStoneSpecular(mat, { rough: 0.66, spread: 0.24, f0: 0.045, gain: 1.0 });
  // rocks are sunk 0.30 of their radius, so their contact line is below the instance
  // origin — see applyContactShade for why this cannot go through the shadow map
  applyContactShade(mat, { rangeAbs: 0.10, rangeRel: 0.30, dark: 0.42, sinkRel: 0.30 });

  const smallGeos = [];
  for (let i = 0; i < 4; i++) smallGeos.push(rockGeometry(rng, noise, 0));
  const bigGeos = [];
  for (let i = 0; i < 3; i++) bigGeos.push(rockGeometry(rng, noise, 1));

  const lists = [...smallGeos, ...bigGeos].map(() => []);
  const q = clamp(ctx.quality.grassDensity ?? 1, 0.35, 1.5);

  // scattered pebbles and stones, favouring slopes and worn ground
  const nSmall = Math.round(560 * q);
  for (let i = 0; i < nSmall * 2; i++) {
    if (lists.slice(0, 4).reduce((a, b) => a + b.length, 0) >= nSmall) break;
    const a = rng.next() * Math.PI * 2;
    const r = 6 + Math.sqrt(rng.next()) * 330;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = T.heightAt(x, z);
    if (y < T.waterLevel - 0.4) continue;
    const sl = T.slopeAt(x, z);
    const bias = 0.18 + sl * 1.6 + T.dirtAt(x, z) * 0.5;
    if (rng.next() > clamp(bias, 0, 1)) continue;
    lists[rng.int(0, 3)].push({ x, y, z, s: rng.range(0.16, 0.85), rot: rng.next() * Math.PI * 2, tilt: rng.range(0, 0.3) });
  }
  // boulders — bigger, rarer, clumped near cliffs and the shoreline
  const nBig = Math.round(90 * q);
  for (let i = 0; i < nBig * 4; i++) {
    if (lists.slice(4).reduce((a, b) => a + b.length, 0) >= nBig) break;
    const a = rng.next() * Math.PI * 2;
    const r = 14 + Math.sqrt(rng.next()) * 330;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = T.heightAt(x, z);
    if (y < T.waterLevel - 1.5) continue;
    const sl = T.slopeAt(x, z);
    const nearLake = smoothstep(LAKE.r + 22, LAKE.r - 4, Math.hypot(x - LAKE.x, z - LAKE.z));
    const bias = 0.06 + sl * 1.5 + nearLake * 0.45;
    if (rng.next() > clamp(bias, 0, 1)) continue;
    lists[4 + rng.int(0, 2)].push({ x, y, z, s: rng.range(1.2, 4.6), rot: rng.next() * Math.PI * 2, tilt: rng.range(0, 0.22) });
  }

  const geos = [...smallGeos, ...bigGeos];
  const meshes = [];
  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const e = new THREE.Euler();
  // ballistics broadphase: a boulder is a sphere, sunk the same 0.30 the mesh is
  const bp = beginPropChannel('rocks');
  // ground-side occlusion (see contact.js). Only stones big enough to read: a 16 cm
  // pebble's contact patch is under a pixel past ten metres and all it would do is
  // shimmer.
  const decals = [];
  let count = 0;
  for (let i = 0; i < geos.length; i++) {
    const list = lists[i];
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(geos[i], mat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      e.set(p.tilt * rng.range(-1, 1), p.rot, p.tilt * rng.range(-1, 1));
      qt.setFromEuler(e);
      m4.compose({ x: p.x, y: p.y - p.s * 0.30, z: p.z }, qt, { x: p.s, y: p.s, z: p.s });
      mesh.setMatrixAt(k, m4);
      // pebbles under 25 cm are not worth a trace entry -- they would triple the
      // collider count to stop nothing a player would ever notice
      if (p.s >= 0.25) bp.sphere(p.x, p.y - p.s * 0.30, p.z, p.s * 0.92, 'stone');
      if (p.s >= 0.32) decals.push({ x: p.x, z: p.z, r: p.s * 1.32 + 0.14, dark: 0.50 });
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);
    count += list.length;
  }
  return { meshes, count, material: mat, decals };
}

/* ================================================================= RUINS ====== */

/** a small mossy stone ruin — the pw_15 backdrop, and the thing that makes the
 *  meadow read as "somewhere with a history" rather than a noise field. */
export function createRuin(ctx, T, rng, cx, cz, scale = 1) {
  const noise = ctx.noise;
  const parts = [];
  const stone = [0xa8a294, 0x9a9488, 0xb3ac9c];

  const block = (w, h, d, x, y, z, ry, tilt = 0) => {
    const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1).toNonIndexed();
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i,
        p.getX(i) * (1 + 0.05 * noise.fbm(p.getY(i) * 3 + x, p.getZ(i) * 3, 2)),
        p.getY(i) * (1 + 0.03 * noise.fbm(p.getX(i) * 3, p.getZ(i) * 3 + z, 2)),
        p.getZ(i) * (1 + 0.05 * noise.fbm(p.getX(i) * 3 - z, p.getY(i) * 3, 2)));
    }
    g.computeVertexNormals();
    // ------------------------------------------------------------------
    // THE COURSE JOINT. Same finding as the rock cavity above: a column here is a stack
    // of five blocks and the seams between them are the only thing that says "masonry"
    // rather than "an extruded box with a noise wobble". The seam is 2-4 cm of shadow
    // — well under a shadow texel — so it is baked, per block, before the block is
    // rotated into place, while its local frame still knows which way is up.
    //
    // Two terms, and the DOWN-FACE one is the load-bearing half. Darkening only the
    // bottom band leaves the underside of the lintel and of every fallen block lit
    // exactly as brightly as its top, which is the "single global illumination level"
    // the critic named; a stone's underside sees no sky at all.
    // ------------------------------------------------------------------
    const ao = new Float32Array(p.count);
    const nrm = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const t = clamp(p.getY(i) / h + 0.5, 0, 1);        // 0 at the block's foot, 1 at its head
      const seam = 1 - smoothstep(0.0, 0.22, t);
      const down = clamp(-nrm.getY(i), 0, 1);
      ao[i] = 1 - 0.34 * seam - 0.30 * down;
    }
    g.rotateZ(tilt);
    g.rotateY(ry);
    g.translate(x, y, z);
    // paint() writes the colour attribute from scratch, so the bake lands after it. The
    // geometry is already non-indexed, so paint() does not re-order the vertices and the
    // indices in `ao` still line up.
    const out = paint(g, stone[rng.int(0, 2)], 0.09, noise);
    const col = out.attributes.color.array;
    for (let i = 0; i < ao.length; i++) {
      col[i * 3] *= ao[i]; col[i * 3 + 1] *= ao[i]; col[i * 3 + 2] *= ao[i];
    }
    return out;
  };

  const baseY = T.heightAt(cx, cz);
  const rot = rng.next() * Math.PI * 2;
  // two standing columns + a fallen lintel + rubble
  const colH = 4.6 * scale;
  for (let i = 0; i < 2; i++) {
    const sx = (i ? 1 : -1) * 1.9 * scale;
    let y = 0;
    const courses = 5;
    for (let k = 0; k < courses; k++) {
      const hgt = colH / courses;
      const w = 1.15 * scale * (1 - k * 0.05);
      parts.push(block(w, hgt * 0.97, w, sx + rng.range(-0.06, 0.06), y + hgt / 2, rng.range(-0.06, 0.06), rng.range(-0.1, 0.1), rng.range(-0.02, 0.02)));
      y += hgt;
      if (i === 1 && k === 3) break; // one column is broken
    }
  }
  // lintel across the top of the taller column, half collapsed
  parts.push(block(4.6 * scale, 0.8 * scale, 1.15 * scale, -0.6 * scale, colH + 0.35 * scale, 0, 0.06, -0.05));
  // fallen block on the ground
  parts.push(block(2.2 * scale, 0.75 * scale, 1.1 * scale, 3.1 * scale, 0.30 * scale, 1.5 * scale, 0.9, 0.08));
  parts.push(block(1.4 * scale, 0.55 * scale, 1.0 * scale, -3.0 * scale, 0.22 * scale, -1.8 * scale, 2.1, -0.12));
  // low broken wall stub
  for (let k = 0; k < 5; k++) {
    parts.push(block(1.25 * scale, 0.55 * scale, 0.85 * scale, -2.4 * scale + k * 1.28 * scale, 0.26 * scale + (k % 2) * 0.5 * scale, -3.6 * scale, rng.range(-0.08, 0.08)));
  }

  const geo = mergeGeos(parts);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  applyMossShader(mat, 0x62823a, { amount: 1.3 });
  // Dressed stone is smoother than field stone — a cut face holds a tighter wash — but
  // the block faces are large and flat, so the spread has to stay small or one whole
  // face of a column lights differently from the one beside it.
  applyStoneSpecular(mat, { rough: 0.54, spread: 0.12, f0: 0.045, gain: 1.0 });
  // the ruin is set 0.35 into the ground; without the occlusion band at that line the
  // columns read as blocks resting on a painted plane
  applyContactShade(mat, { rangeAbs: 0.55, rangeRel: 0, dark: 0.46, sinkAbs: 0.35 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.y = rot;
  mesh.position.set(cx, baseY - 0.35, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // ---- ballistics broadphase ----
  // Each ruin gets its OWN channel key, because index.js builds two of them and a
  // shared tag would have the second call delete the first one's colliders.
  const bp = beginPropChannel(`ruin@${cx.toFixed(1)},${cz.toFixed(1)}`);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  const wx = (lx, lz) => cx + lx * cs + lz * sn;
  const wz = (lx, lz) => cz - lx * sn + lz * cs;
  const y0 = baseY - 0.35;
  // the two columns, one of them broken four courses up
  bp.column(wx(-1.9 * scale, 0), wz(-1.9 * scale, 0), 0.72 * scale, y0, y0 + colH, 'stone');
  bp.column(wx(1.9 * scale, 0), wz(1.9 * scale, 0), 0.72 * scale, y0, y0 + colH * 0.8, 'stone');
  // half-collapsed lintel
  bp.sphere(wx(-0.6 * scale, 0), y0 + colH + 0.35 * scale, wz(-0.6 * scale, 0), 1.5 * scale, 'stone');
  // fallen blocks
  bp.sphere(wx(3.1 * scale, 1.5 * scale), y0 + 0.30 * scale, wz(3.1 * scale, 1.5 * scale), 1.0 * scale, 'stone');
  bp.sphere(wx(-3.0 * scale, -1.8 * scale), y0 + 0.22 * scale, wz(-3.0 * scale, -1.8 * scale), 0.8 * scale, 'stone');
  // the low broken wall stub, three spheres along its run
  for (let k = 0; k < 3; k++) {
    const lx = -2.4 * scale + k * 2.56 * scale, lz = -3.6 * scale;
    bp.sphere(wx(lx, lz), y0 + 0.45 * scale, wz(lx, lz), 0.95 * scale, 'stone');
  }
  return mesh;
}

/* ================================================================= WATER ====== */

export function createWater(ctx, T) {
  const R = LAKE.r + 14;
  const SEG = 84;
  const geo = new THREE.PlaneGeometry(R * 2, R * 2, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const depth = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + LAKE.x, z = p.getZ(i) + LAKE.z;
    depth[i] = T.waterLevel - T.heightAt(x, z);
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x1d4a52).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x5fa9a8).convertSRGBToLinear() },
        uSky: { value: new THREE.Color(0xbcd8f0).convertSRGBToLinear() },
        uSun: { value: new THREE.Vector3(0.3, 0.8, 0.3) },
        uSunCol: { value: new THREE.Color(0xffffff) },
      },
    ]),
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      attribute float aDepth;
      varying float vDepth; varying vec3 vW;
      void main() {
        vDepth = aDepth;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform float uTime; uniform vec3 uDeep, uShallow, uSky, uSun, uSunCol;
      varying float vDepth; varying vec3 vW;
      void main() {
        if (vDepth < 0.02) discard;
        // two crossing ripple trains -> analytic normal
        vec2 q1 = vW.xz * 0.32 + vec2(uTime * 0.22, uTime * 0.11);
        vec2 q2 = vW.xz * 0.71 + vec2(-uTime * 0.16, uTime * 0.27);
        float amp = 0.045;
        vec3 n = normalize(vec3(
          -(cos(q1.x + q1.y) * amp + cos(q2.x - q2.y * 1.4) * amp * 0.6),
          1.0,
          -(cos(q1.x + q1.y) * amp + -cos(q2.x - q2.y * 1.4) * amp * 0.6)));
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - clamp(dot(V, n), 0.0, 1.0), 3.4);
        float shallow = 1.0 - clamp(vDepth / 3.4, 0.0, 1.0);
        vec3 body = mix(uDeep, uShallow, shallow * shallow);
        vec3 col = mix(body, uSky, clamp(0.18 + fres * 0.82, 0.0, 1.0));
        // sun glint
        vec3 H = normalize(normalize(uSun) + V);
        col += uSunCol * pow(max(dot(n, H), 0.0), 220.0) * 1.6;
        // shoreline lightening + a thin foam line
        float edge = smoothstep(1.1, 0.05, vDepth);
        col = mix(col, uShallow * 1.25, edge * 0.55);
        float foam = smoothstep(0.30, 0.10, vDepth) * smoothstep(0.02, 0.10, vDepth);
        col = mix(col, vec3(0.95), foam * 0.5);
        float alpha = smoothstep(0.02, 0.45, vDepth) * (0.72 + fres * 0.28);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, T.waterLevel, LAKE.z);
  mesh.renderOrder = 2;
  mesh.name = 'water';
  return { mesh, material: mat };
}

/* =============================================================== MOTES ======== */

/**
 * Night motes — drifting warm points of light over the meadow.
 *
 * The dusk frame is the weakest thing we render: 1.7 local contrast and 146 distinct
 * colours against pw_16's 5.2 and 422. The difference is not exposure — both frames
 * average 50 — it is that pw_16 is a DARK frame with warm practical lights in it,
 * while ours is a flat blue multiply over a daylight image. Reference observation for
 * `dusk_mood` is explicit: "does the world hold up when the sun is not doing the work
 * for you", and pw_16 answers it with lanterns.
 *
 * We have no village to hang lanterns on, so the practicals are the fauna: slow warm
 * motes at knee-to-head height. One additively blended draw call. They are keyed
 * entirely off the sky's night amount so they are exactly invisible in all five
 * daylight shots.
 *
 * ROUND 12: THEY NOW EMIT. The blind critic's verdict on the dusk pair was the widest
 * gap in the whole pack, and it was not about the sprites: "A's lanterns emit light.
 * Each paper lantern owns a pool of warm falloff on the gravel path and throws an
 * uneven wash up the shoji panels behind it... B is a night scene with NO LIGHT SOURCES
 * IN IT. The fireflies are unlit point sprites contributing nothing."
 *
 * So a small FIXED POOL of point lights chases the motes nearest the camera. Fixed,
 * because three compiles NUM_POINT_LIGHTS into every material in the scene: one light
 * per mote is not "expensive", it is a shader that does not link. Six lights, reassigned
 * as you walk, gated on the sky's own night curve so the daylight shots compile and
 * render exactly as they did before.
 *
 * The field itself also had to move. It was scattered `r = 3 + sqrt(u) * 78` from the
 * WORLD ORIGIN, and the player spawns 98 m from the origin — measured, every pool sat
 * at intensity 0 because the nearest mote to the dusk camera was outside the search
 * radius. Same arithmetic that emptied the first 25 m of the meadow (see
 * createGroundClutter). The field is now a camera-relative, world-anchored hash grid
 * rebuilt when the camera crosses an 18 m cell: deterministic, constant cost, and it
 * exists wherever you actually are rather than only where the world was authored.
 */
export function createMotes(ctx, T, rng) {
  const N = Math.round(360 * clamp(ctx.quality.grassDensity ?? 1, 0.4, 1.5));
  const geo = new THREE.PlaneGeometry(1, 1);
  const uniforms = { uAmt: { value: 0 }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: /* glsl */`
      uniform float uTime; uniform float uAmt;
      attribute vec3 aSeed;
      varying vec2 vUvM; varying vec3 vTint; varying float vPulse;
      void main() {
        vUvM = uv;
        vTint = instanceColor;
        // each mote breathes on its own phase; a field that pulses in unison reads
        // as an effect, a field that does not reads as insects
        float ph = aSeed.z * 6.2831;
        vPulse = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.7 + aSeed.x * 1.1) + ph));
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // slow lateral drift and a lazy vertical bob
        mv.x += sin(uTime * (0.16 + aSeed.x * 0.12) + ph) * 0.9;
        mv.y += sin(uTime * (0.23 + aSeed.y * 0.14) + ph * 1.7) * 0.45;
        float s = length(instanceMatrix[0].xyz) * (0.55 + 0.75 * vPulse);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAmt;
      varying vec2 vUvM; varying vec3 vTint; varying float vPulse;
      void main() {
        float d = length(vUvM - 0.5) * 2.0;
        if (d > 1.0) discard;
        // hot core, wide soft halo — a point practical, not a sprite disc
        float core = pow(1.0 - clamp(d, 0.0, 1.0), 6.0);
        float halo = pow(1.0 - clamp(d, 0.0, 1.0), 2.0) * 0.30;
        vec3 c = vTint * (core * 4.2 + halo * 1.4);
        gl_FragColor = vec4(c * uAmt * vPulse, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  const seeds = new Float32Array(N * 3);
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = 'motes';

  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const col = new THREE.Color();
  const motes = [];
  // amber, honey and a few cool green ones so the field is not one hue
  const TINTS = [0xffc46a, 0xffb04a, 0xffd894, 0xbfe07a];
  const seedAttr = new THREE.InstancedBufferAttribute(seeds, 3);
  seedAttr.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (mesh.instanceColor) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aSeed', seedAttr);
  mesh.count = 0;

  const STEP = 7.2 / Math.sqrt(clamp(ctx.quality.grassDensity ?? 1, 0.4, 1.5));
  const R = 86;
  function rebuildField(camX, camZ) {
    motes.length = 0;
    let n = 0;
    const i0 = Math.floor((camX - R) / STEP), i1 = Math.ceil((camX + R) / STEP);
    const j0 = Math.floor((camZ - R) / STEP), j1 = Math.ceil((camZ + R) / STEP);
    for (let j = j0; j <= j1 && n < N; j++) {
      for (let i = i0; i <= i1 && n < N; i++) {
        const h0 = hash2i(i, j, 8101), h1 = hash2i(i, j, 8117);
        const x = i * STEP + (h0 - 0.5) * STEP * 0.96;
        const z = j * STEP + (h1 - 0.5) * STEP * 0.96;
        if (Math.hypot(x - camX, z - camZ) > R) continue;
        const gy = T.heightAt(x, z);
        if (gy < T.waterLevel + 0.4) continue;
        if (T.slopeAt(x, z) > 0.42) continue;
        const h2 = hash2i(i, j, 8123);
        // motes gather over damp low ground, not evenly across the meadow
        if (h2 > 0.32 + smoothstep(30, 8, gy) * 0.55) continue;
        const h3 = hash2i(i, j, 8147), h4 = hash2i(i, j, 8161), h5 = hash2i(i, j, 8179);
        const y = gy + 0.35 + Math.pow(h3, 1.7) * 2.3;
        const s = 0.16 + h4 * 0.22;
        m4.compose({ x, y, z }, qt, { x: s, y: s, z: s });
        mesh.setMatrixAt(n, m4);
        col.setHex(TINTS[Math.floor(h5 * TINTS.length) % TINTS.length]).multiplyScalar(0.7 + h0 * 0.65);
        mesh.setColorAt(n, col);
        seeds[n * 3] = h3; seeds[n * 3 + 1] = h4; seeds[n * 3 + 2] = h1;
        // kept for the light pool: base position, ground height, seeds and tint
        motes.push({ x, y, z, gy, tint: col.clone(), s0: h3, s1: h4, ph: h1 * Math.PI * 2 });
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    seedAttr.needsUpdate = true;
  }
  rebuildField(0, 0);

  /* ---------------------------------------------------------- the light pool ---- */
  // Six. three bakes NUM_POINT_LIGHTS into every program in the scene, so this is a
  // hard architectural ceiling, not a performance preference — and six warm pools in a
  // frame is already more practicals than pw_16 has lanterns in shot.
  const POOL = 6;
  const AMBER = new THREE.Color(0xffa855);
  const lights = [];
  for (let i = 0; i < POOL; i++) {
    // decay 2 with distance 9: irradiance falls as 1/d^2 and is clamped to zero at 9 m,
    // so each mote owns a readable ellipse of ground and nothing beyond it
    const l = new THREE.PointLight(0xffb469, 0, 11, 2);
    l.castShadow = false;
    l.visible = false;
    l.matrixAutoUpdate = true;
    mesh.add(l);           // the mesh is the only thing the world system adds to the scene
    lights.push({ l, mote: null });
  }
  let lastPick = -1e9, lastCX = 1e9, lastCZ = 1e9, lastLit = false;
  let fieldX = 0, fieldZ = 0;

  function pick(cam) {
    // nearest motes to the camera, preferring the low ones — a pool 3 m in the air
    // lights nothing, and the whole point is a wash on the ground
    const scored = [];
    for (let i = 0; i < motes.length; i++) {
      const m = motes[i];
      const d = Math.hypot(m.x - cam.x, m.z - cam.z);
      if (d > 26) continue;
      scored.push([d + (m.y - m.gy) * 3.0, i]);
    }
    scored.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < POOL; k++) {
      lights[k].mote = scored[k] ? motes[scored[k][1]] : null;
    }
  }

  return {
    mesh, lightCount: POOL,
    get count() { return mesh.count; },
    update(elapsed, nightAmt) {
      uniforms.uTime.value = elapsed;
      uniforms.uAmt.value = nightAmt;
      const lit = nightAmt > 0.004;
      mesh.visible = lit;

      // re-anchor the field on an 18 m cell so it is always around the camera; the
      // hash is world-anchored, so an individual mote does not move when it does
      const c0 = ctx.camera?.position;
      if (c0) {
        const qx = Math.round(c0.x / 18) * 18, qz = Math.round(c0.z / 18) * 18;
        if (qx !== fieldX || qz !== fieldZ) {
          fieldX = qx; fieldZ = qz;
          rebuildField(qx, qz);
          lastPick = -1e9;
        }
      }

      // Toggling visibility changes the scene's light count and forces three to
      // relink every material, so it is done once on the day/night crossing and never
      // per frame. By day these are invisible and cost exactly nothing.
      if (lit !== lastLit) {
        for (const e of lights) e.l.visible = lit;
        lastLit = lit;
        lastPick = -1e9;
      }
      if (!lit) return;

      const cam = ctx.camera?.position;
      if (cam && (elapsed - lastPick > 0.8 || Math.hypot(cam.x - lastCX, cam.z - lastCZ) > 2.5)) {
        pick(cam);
        lastPick = elapsed; lastCX = cam.x; lastCZ = cam.z;
      }
      for (const e of lights) {
        const m = e.mote;
        if (!m) { e.l.intensity = 0; continue; }
        // the sprite's own bob and breath, replicated so the pool moves and pulses
        // WITH the mote instead of sitting under a light that has drifted off it
        const bob = Math.sin(elapsed * (0.23 + m.s1 * 0.14) + m.ph * 1.7) * 0.45;
        const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(elapsed * (0.7 + m.s0 * 1.1) + m.ph));
        e.l.position.set(m.x, m.y + bob, m.z);
        // The critic's note on the reference lantern is that the "warm core colour-
        // shifts as it fades into the cool blue ambient". A few of the sprite tints are
        // deliberately cool-green so the FIELD is not one hue, but a cool-green pool on
        // green grass reads as a radioactive puddle. The sprite keeps its tint; the pool
        // it casts is pulled two thirds of the way to lantern amber.
        e.l.color.copy(m.tint).lerp(AMBER, 0.66);
        e.l.intensity = 2.0 * nightAmt * pulse;
      }
    },
  };
}

/* =========================================================== LANDMARKS ======== */

/**
 * The 1–3 km silhouettes required by reference observation #7. These use the aerial
 * material (fog off, haze capped) so they never dissolve completely into the sky.
 */
export function createLandmarks(ctx, T, rng) {
  const noise = ctx.noise;
  const group = new THREE.Group();
  group.name = 'landmarks';
  const mats = [];

  // ---- mesa / plateau silhouettes, mostly arrayed around the vista axis ----
  const parts = [];
  const specs = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const spreadA = (i / (N - 1) - 0.5) * 2.4;          // radians off the vista axis
    const ang = Math.atan2(AZ, AX) + spreadA + rng.range(-0.18, 0.18);
    const dist = rng.range(1250, 2750);
    specs.push({ ang, dist, h: rng.range(240, 560), r: rng.range(180, 420) });
  }
  for (const s of specs) {
    const x = Math.cos(s.ang) * s.dist, z = Math.sin(s.ang) * s.dist;
    // ------------------------------------------------------------------
    // The far ranges read as "flat paper cutouts: single-facet white silhouettes,
    // no rock striation, no snow line, no shading break" in every wide frame.
    // Two causes, both here: 12 segments over a 400 m plateau put a polygon edge
    // every 30 degrees of silhouette, and the vertex colour was a pure function of
    // height (0.82 + 0.24 t) — literally a vertical gradient with no rock in it.
    //
    // 22 x 9 costs ~400 triangles per mesa (9 mesas = 3.6k, one draw call) and the
    // colour now carries horizontal bedrock courses, a broken snow line and a
    // large-scale light/dark shoulder, all sized against the measured sd of
    // noise.fbm (0.20, centred on 0) rather than assumed to be 0..1.
    // ------------------------------------------------------------------
    const seg = 22, rings = 9;
    const verts = [], cols = [], idx = [];
    const c = new THREE.Color();
    const ROCK = new THREE.Color(0xf2f4f6);
    const WARM = new THREE.Color(0xf7f0e4);
    const SNOW = new THREE.Color(0xffffff);
    for (let ri = 0; ri <= rings; ri++) {
      const t = ri / rings;
      // stepped, near-vertical sided plateau
      const rr = s.r * (1 - Math.pow(t, 2.4) * 0.72) * (1 - t * 0.06);
      const yy = s.h * Math.pow(t, 0.72);
      for (let si = 0; si <= seg; si++) {
        const a = (si / seg) * Math.PI * 2;
        const wob = 1 + 0.22 * noise.fbm(Math.cos(a) * 2 + s.ang * 3, Math.sin(a) * 2 - t * 2, 2);
        const px = x + Math.cos(a) * rr * wob, pz = z + Math.sin(a) * rr * wob;
        verts.push(px, yy - 20, pz);
        // horizontal courses: a function of HEIGHT only, so they wrap the mesa the
        // way sedimentary bands do instead of blotching it
        const band = noise.fbm(yy * 0.035 + s.ang * 7, yy * 0.011 + 4.4, 3);
        // which face of the mesa this is — puts a lit shoulder and a shaded one on
        // the same rock, which is the shading break the silhouette was missing
        const face = noise.fbm(Math.cos(a) * 1.4 + s.ang * 5, Math.sin(a) * 1.4 - 2.2, 2);
        const snowT = Math.max(0, Math.min(1, (yy - (s.h * 0.62 + band * 90)) / (s.h * 0.3)));
        c.copy(ROCK).lerp(WARM, Math.max(0, Math.min(1, 0.5 + face * 1.5)));
        c.lerp(SNOW, snowT * 0.85);
        const v = (0.80 + 0.20 * t) * (1 + 0.42 * band + 0.30 * face) * (1 - snowT * 0.05);
        cols.push(c.r * v, c.g * v, c.b * v);
      }
    }
    const row = seg + 1;
    for (let ri = 0; ri < rings; ri++) {
      for (let si = 0; si < seg; si++) {
        const a = ri * row + si, b = a + 1, d = a + row, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }

  // ---- two leaning monolith slabs (the pw_11 / pw_02 signature) ----
  for (let i = 0; i < 3; i++) {
    const ang = Math.atan2(AZ, AX) + rng.range(-0.75, 0.75);
    const dist = rng.range(900, 1700);
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const L = rng.range(300, 520), W = rng.range(60, 110), Tk = rng.range(38, 70);
    const g = new THREE.BoxGeometry(W, L, Tk, 1, 4, 1).toNonIndexed();
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const yy = p.getY(k) / L + 0.5;
      p.setX(k, p.getX(k) * (1 - yy * 0.35));
      p.setZ(k, p.getZ(k) * (1 - yy * 0.25));
    }
    g.computeVertexNormals();
    g.rotateZ(rng.range(0.35, 0.75) * (rng.bool() ? 1 : -1));
    g.rotateY(rng.next() * Math.PI);
    g.translate(x, L * 0.30, z);
    parts.push(paint(g, 0xb9bcc0));
  }

  const mesaMat = makeAerialMaterial({ color: 0x9aa7ad, maxHaze: 0.855, desat: 0.60, form: 0.80 });
  mats.push(mesaMat);
  const mesaGeo = mergeGeos(parts);
  setAerialPivot(mesaMat, mesaGeo);
  const mesa = new THREE.Mesh(mesaGeo, mesaMat);
  mesa.frustumCulled = false;
  group.add(mesa);

  // ---- mid-distance ruined tower: the man-made landmark every wide Palworld shot has ----
  const towerParts = [];
  const [tx, tz] = toWorld(620, 40);
  const ty = T.analytic(tx, tz);
  let y = 0;
  const courses = 22;
  for (let i = 0; i < courses; i++) {
    const t = i / courses;
    const w = lerp(17, 8.5, t) * (1 - Math.pow(t, 3) * 0.3);
    const hgt = 3.4;
    // top few courses are broken away on one side
    const broken = t > 0.80 ? (i % 2 === 0 ? 0.5 : 0.85) : 1;
    const g = new THREE.BoxGeometry(w, hgt * 0.97, w * broken, 1, 1, 1);
    g.translate(0, y + hgt / 2, w * (1 - broken) * -0.5);
    g.rotateY(t * 0.25);
    towerParts.push(paint(g, 0xffffff));
    y += hgt;
  }
  const buttressA = new THREE.BoxGeometry(5, 26, 5).translate(11, 13, 0);
  towerParts.push(paint(buttressA, 0xffffff));
  const buttressB = new THREE.BoxGeometry(5, 18, 5).translate(-10, 9, 4);
  towerParts.push(paint(buttressB, 0xffffff));
  const towerMat = makeAerialMaterial({ color: 0x9d9c95, maxHaze: 0.80, desat: 0.5 });
  mats.push(towerMat);
  const towerGeo = mergeGeos(towerParts);
  setAerialPivot(towerMat, towerGeo);
  const tower = new THREE.Mesh(towerGeo, towerMat);
  tower.position.set(tx, ty - 3, tz);
  tower.frustumCulled = false;
  group.add(tower);

  return { group, mats, tower: { x: tx, z: tz } };
}
