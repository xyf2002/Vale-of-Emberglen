import * as THREE from 'three';

/**
 * GROUND-SIDE CONTACT OCCLUSION — the other half of "sitting in the world".
 *
 * `applyContactShade` in vegetation.js darkens the OBJECT near its own base. Two blind
 * critics in a row said that is not enough, and they are right: they described the
 * GROUND, not the prop.
 *
 *   r11: "an icosphere with berries as separate spheres stuck to it, sitting on the
 *         grass with no contact shadow and no ambient occlusion at the ground line.
 *         It doesn't sit in the world, it sits on top of the image."
 *   r12: "no contact darkening at the blade/soil junction. The field reads as green
 *         sprites scattered on sand."
 *
 * Reference #9 asks for "a small, tight, distinctly darker ellipse directly under the
 * feet with a hard-ish inner core and ~0.2 m of falloff". 0.2 m is roughly three shadow
 * texels at the live frustum (see the grass-casting note in vegetation.js), so this
 * cannot come from the shadow map at any sun angle, and it must not depend on one: a
 * contact shadow is ambient occlusion — it is there at noon, at dusk and under cloud.
 *
 * WHY THIS IS A BAKED MESH AND NOT AN INSTANCED QUAD.
 *
 * The obvious implementation is an InstancedMesh of unit discs oriented to the terrain
 * normal. It was rejected before it was written, for a reason worth recording:
 *
 *   - A flat disc has to be pushed off the surface to survive the depth test, and the
 *     ground mesh tessellates at 2.2 m so the analytic height and the rendered surface
 *     disagree by a couple of centimetres. Push it far enough to always win (5 cm) and
 *     you buy PARALLAX: from eye height (1.7 m) at 20 m the ground is 5 degrees off
 *     grazing, so a 5 cm lift slides the "shadow" 0.6 m away from the thing casting it —
 *     wider than the decal itself. Push it less and half of them vanish into the ground.
 *   - The disc is planar and the ground is not. On the 0.45-slope limit that props are
 *     placed on, a 1.5 m disc misses the surface by 30 cm at its rim.
 *
 * Sampling the heightfield PER VERTEX removes both problems at once: every vertex sits
 * on the surface it is darkening, so the offset can be 1 cm and there is no parallax and
 * no slope error. The price is that the decals cannot be instanced — so they are merged
 * into one geometry instead, which is one draw call either way.
 *
 * MULTIPLY BLENDING IS CORRECT HERE, and only because of where it lands in the pipeline:
 * post/index.js renders the scene into a HalfFloat LINEAR target and tone-maps later, so
 * `dst * src` is a multiply on linear radiance, which is what an occlusion term is. If
 * the scene ever renders straight to an sRGB backbuffer this becomes a multiply on
 * tone-mapped values and will read too strong in the shoulder.
 *
 * The material carries no fog. A fogged multiply would push the decal colour toward the
 * fog colour, i.e. toward WHITE-ish, i.e. it would stop occluding at exactly the
 * distance the fog matters — and worse, could brighten. The distance term below fades
 * the occlusion to nothing instead, on the same schedule, which is also what stops a
 * sub-pixel decal from shimmering under camera motion.
 */

/**
 * Unit contact patch: centre, an inner ring, a rim.
 *
 * Reference #9 asks for "a hard-ish inner core and ~0.2 m of falloff", so the core is
 * held nearly flat out to 0.72 r and everything happens in the last quarter. A linear
 * ramp all the way from the centre (the first version, RING 0.55 / 0.62) reads as a
 * soft airbrushed smudge, which is the thing that makes a contact shadow look painted.
 *
 * The patch also has to be WIDER THAN THE OBJECT or none of it is visible: a shrub's
 * own silhouette hides everything inside its footprint, so the only part of the patch a
 * camera ever sees is the ring that escapes past the leaves. Sizing the patch to the
 * object (which is the intuitive thing, and was the first thing tried) puts 100% of the
 * occlusion where 0% of it can be seen — measured as a frame-mean move of 0.8/255 that
 * was almost entirely the near-field clutter rather than any of the shrubs.
 */
const SEG = 8;
const RING = 0.72;
/** occlusion profile down the three rings. Rim must be 0 or the patch has a hard edge. */
const PROFILE = [1.0, 0.90, 0.0];
const VERTS = 1 + SEG * 2;
const TRIS = SEG * 3;

/**
 * A contact-occlusion field.
 *
 * `cap` is the maximum number of patches; the buffers are allocated once and rewritten
 * in place, so the camera-relative clutter field can call set() on every rebuild without
 * churning GPU buffers.
 *
 * Each patch is { x, z, r, dark } — world centre, world radius, and the multiplier the
 * ground reaches at the very centre (0.55 = "45% of the light removed").
 */
export function createContactField(T, cap, { name = 'contact', fadeNear = 70, fadeFar = 150 } = {}) {
  const pos = new Float32Array(cap * VERTS * 3);
  const ao = new Float32Array(cap * VERTS);
  const idx = new Uint32Array(cap * TRIS * 3);

  // index buffer is fixed for every patch slot, so build it once
  for (let p = 0; p < cap; p++) {
    const v0 = p * VERTS;          // centre
    const vi = v0 + 1;             // inner ring
    const vo = v0 + 1 + SEG;       // outer ring
    let w = p * TRIS * 3;
    for (let s = 0; s < SEG; s++) {
      const s1 = (s + 1) % SEG;
      // WINDING. Ring vertex s is at (cos a, 0, sin a). Fanning centre -> s -> s+1 in
      // increasing a gives a face normal of -Y, i.e. the whole field faces the ground
      // and is back-face culled from every camera that could ever see it. It was
      // written that way first, and the symptom is indistinguishable from "the draw
      // call never happened": forcing the fragment shader to output pure black moved
      // the frame mean by 0.05/255 and disabling the depth test changed nothing.
      // Reversed so the patches face +Y.
      idx[w++] = v0; idx[w++] = vi + s1; idx[w++] = vi + s;
      idx[w++] = vi + s; idx[w++] = vo + s1; idx[w++] = vo + s;
      idx[w++] = vi + s; idx[w++] = vi + s1; idx[w++] = vo + s1;
    }
  }

  const cosT = new Float32Array(SEG), sinT = new Float32Array(SEG);
  for (let s = 0; s < SEG; s++) {
    const a = (s / SEG) * Math.PI * 2;
    cosT[s] = Math.cos(a); sinT[s] = Math.sin(a);
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const aoAttr = new THREE.BufferAttribute(ao, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  aoAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('aAo', aoAttr);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setDrawRange(0, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float aAo;
      varying float vAo;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vAo = aAo * (1.0 - smoothstep(${fadeNear.toFixed(1)}, ${fadeFar.toFixed(1)}, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vAo;
      void main() { gl_FragColor = vec4(vec3(1.0 - vAo), 1.0); }`,
    // CustomBlending, not MultiplyBlending: three r185 implements the latter as
    // `blendFuncSeparate(DST_COLOR, ONE_MINUS_SRC_ALPHA, ...)`, which is only a plain
    // multiply when the source alpha is exactly 1 — and it errors out to the console on
    // every frame unless premultipliedAlpha is set. Spelling the factors out gives
    // dst * src with the destination alpha left alone, and cannot drift with a
    // three upgrade.
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
    depthWrite: false,
    // Coplanar with the ground by construction (every vertex is sampled off the same
    // heightfield), so the depth fight is handled where it belongs — in depth space,
    // where it costs no world-space parallax. The 1 cm lift below is only there to
    // cover the difference between the analytic height and the tessellated mesh.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  // before water and motes in the transparent pass; it is part of the ground, not of
  // the things floating over it
  mesh.renderOrder = -1;
  mesh.matrixAutoUpdate = false;

  let n = 0;

  function set(list) {
    n = 0;
    for (let i = 0; i < list.length && n < cap; i++) {
      const d = list[i];
      const r = d.r;
      if (!(r > 0.02)) continue;
      const base = n * VERTS;
      const strength = d.dark;
      // centre
      let w = base * 3;
      pos[w] = d.x; pos[w + 1] = T.heightAt(d.x, d.z) + 0.01; pos[w + 2] = d.z;
      ao[base] = strength * PROFILE[0];
      for (let ring = 0; ring < 2; ring++) {
        const rr = ring === 0 ? r * RING : r;
        const prof = PROFILE[ring + 1] * strength;
        for (let s = 0; s < SEG; s++) {
          const vx = d.x + cosT[s] * rr, vz = d.z + sinT[s] * rr;
          const vi = base + 1 + ring * SEG + s;
          w = vi * 3;
          pos[w] = vx; pos[w + 1] = T.heightAt(vx, vz) + 0.01; pos[w + 2] = vz;
          ao[vi] = prof;
        }
      }
      n++;
    }
    posAttr.needsUpdate = true;
    aoAttr.needsUpdate = true;
    geo.setDrawRange(0, n * TRIS * 3);
    return n;
  }

  return {
    mesh,
    set,
    get count() { return n; },
    get triangles() { return n * TRIS; },
  };
}
