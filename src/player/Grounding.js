import * as THREE from 'three';

/**
 * THE PLAYER'S CONTACT OCCLUSION.
 *
 * What this replaces, and why. Until r13 the avatar stood on a single 0.95 m plane with
 * `MeshBasicMaterial({ color: 0x1b2415, opacity: 0.55, blending: NormalBlending })` and
 * a radial gradient whose inner stop was `rgba(0,0,0,0.85)`. That is not an occlusion
 * term, it is dark green paint alpha-composited over the meadow, and it is exactly what
 * the r11 blind critic named: "a hard black elliptical blob decal instead of an
 * occlusion gradient". An alpha-blended constant colour cannot know what it is sitting
 * on, so it reads as a sticker on grass and as a stain on soil. A MULTIPLY can only ever
 * scale what is already in the buffer, which is what shadowing physically is.
 *
 * The second half of the problem is measured rather than aesthetic. `tools/_groundprobe2.mjs`
 * A/Bs the grounding meshes themselves (the shadow-map toggle in `_groundprobe.mjs`
 * cannot see them at all, since they are geometry and not shadow casters). On the r12
 * build the player's flat decal changed 1.11% of overshoulder_meadow by a mean of 8.3 of
 * 255, and the diff image is not an ellipse — it is a comb of blade silhouettes. The
 * meadow carpet is 0.30-0.60 m tall and the avatar is standing IN it, so from a
 * third-person camera almost every pixel around the boots is grass, not ground.
 * Darkening the ground plane darkens something the camera cannot see.
 *
 * So the occlusion is sliced into horizontal discs from the soil up through the canopy,
 * shrinking and weakening with height, drawn as one instanced multiply. A blade whose
 * visible pixel is at 0.25 m is darkened by the discs the view ray crossed above it; a
 * bare patch of trail is darkened by all of them. Multiply compounds, so the stack is
 * budgeted: with CORE red 0.46 each layer contributes `1 - 0.54 * s`, the four multiply
 * to ~0.30 at the exact centre (under the boots, which hide it) and the ground disc
 * alone gives ~0.54. Raising a strength is a multiplicative change — check the product.
 *
 * DELIBERATE DUPLICATION: src/creatures/materials.js carries the same technique for
 * creatures. Systems never import each other (CLAUDE.md), and player and creatures are
 * owned as separate directories, so the ~60 lines are copied rather than shared. If you
 * change the profile here, change it there, or the player and the pals will sit in the
 * meadow differently.
 */

/** y in metres above the terrain, r as a fraction of the footprint, s = strength */
const LAYERS = [
  { y: 0.020, r: 1.18, s: 0.95 },   // the ground itself
  { y: 0.145, r: 1.08, s: 0.55 },   // blade bases
  { y: 0.300, r: 0.94, s: 0.38 },   // mid canopy
  { y: 0.470, r: 0.72, s: 0.26 },   // tips, at the avatar's shin line
];

/**
 * The occlusion profile, authored DIRECTLY IN LINEAR MULTIPLIER SPACE.
 *
 * The scene renders into a HalfFloat linear target (src/post/index.js). A canvas texture
 * flagged SRGBColorSpace is decoded on sample, so an sRGB byte of 104 — "multiply by
 * 0.41" as authored — arrives at the blender as 0.14, i.e. 86% black. That is the trap
 * that made the previous generation of these decals read as tar. The byte here IS the
 * linear multiplier and the texture is NoColorSpace so nothing decodes it.
 */
function occlusionProfile() {
  const S = 128, R = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;

  // Cool and desaturated, never black: blue is attenuated least so shaded ground drifts
  // toward the sky's hue, which is what reference #9 describes and what a real skylit
  // shadow does. A neutral grey multiply reads as dirt.
  const CORE = [0.46, 0.495, 0.585];
  const sstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      // Hold the core out past the silhouette and spend the whole outer half on
      // falloff. From a third-person camera the avatar's own body hides the middle of
      // its own occlusion, so a profile that is over by r=0.6 is a shadow nobody sees.
      // The extra pow() takes the shoulder off the smoothstep: the r11 critic could
      // name the *edge* of the old blob, and a gradient with a findable edge is a blob.
      const f = Math.pow(1 - sstep(0.30, 1.0, r), 1.35);
      const i = (y * S + x) * 4;
      d[i] = Math.round(255 * (1 - (1 - CORE[0]) * f));
      d[i + 1] = Math.round(255 * (1 - (1 - CORE[1]) * f));
      d[i + 2] = Math.round(255 * (1 - (1 - CORE[2]) * f));
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;      // the byte IS the multiplier — see above
  // no mips: at grazing angles a mipped 1x1 of this averages to near-white and the
  // occlusion quietly evaporates in the mid ground.
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function createGrounding({ footprint = 0.46 } = {}) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);

  // Multiply, spelled out as custom blending: THREE.MultiplyBlending refuses to run
  // without premultipliedAlpha and silently falls back to *no* blending, which puts an
  // opaque white card under the player. dst = dst * src is what we actually want.
  const mat = new THREE.MeshBasicMaterial({
    map: occlusionProfile(),
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    depthWrite: false,
    depthTest: true,
    // the bottom slab sits 2 cm over a terrain mesh whose triangles are ~2 m across;
    // polygon offset keeps it out of the z-fight zone on slopes without lifting it far
    // enough to visibly detach from the boots.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    toneMapped: false,
  });
  mat.onBeforeCompile = (shader) => {
    // three declares vColor in the VERTEX stage for USE_INSTANCING_COLOR but not in the
    // fragment stage, so the per-instance value never arrives unless we declare it.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <color_pars_fragment>', `#include <color_pars_fragment>
        #if defined( USE_INSTANCING_COLOR ) && !defined( USE_COLOR ) && !defined( USE_COLOR_ALPHA )
          varying vec4 vColor;
        #endif`)
      // a multiply cannot lighten, so per-instance strength lerps the sampled
      // multiplier back toward white instead of scaling it.
      .replace('#include <color_fragment>', `
        #ifdef USE_INSTANCING_COLOR
          diffuseColor.rgb = mix( vec3( 1.0 ), diffuseColor.rgb, clamp( vColor.r, 0.0, 1.0 ) );
        #endif`);
  };
  mat.customProgramCacheKey = () => 'playerGrounding';

  const mesh = new THREE.InstancedMesh(geo, mat, LAYERS.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(LAYERS.length * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = 'player-contact-shadow';

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const _n = new THREE.Vector3();

  /**
   * @param x,z      feet position
   * @param groundY  terrain height under the feet
   * @param airGap   0 = planted, 1 = fully off the ground. The stack spreads and fades
   *                 rather than sliding along under the avatar, so a jump reads as a
   *                 jump instead of as a decal on a leash.
   * @param crouch   0..1; a crouched player presses into the grass
   * @param normal   terrain normal, or null
   */
  mesh.place = (x, z, groundY, airGap = 0, crouch = 0, normal = null) => {
    const spread = 1 + airGap * 0.6;
    const fade = (1 - airGap * 0.80) * (1 + crouch * 0.16);
    if (normal) _q.setFromUnitVectors(UP, _n.copy(normal).normalize());
    else _q.identity();
    for (let i = 0; i < LAYERS.length; i++) {
      const L = LAYERS[i];
      const rr = footprint * L.r * spread;
      _p.set(x, groundY + L.y, z);
      // slightly rounder than the creatures' ellipse: a biped's stance is not a
      // quadruped's, and the avatar is usually seen from directly behind.
      _s.set(rr * 2.1, 1, rr * 1.9);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(i, _m);
      const s = L.s * fade;
      mesh.instanceColor.setXYZ(i, s, s, s);
    }
    mesh.count = LAYERS.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  };

  return mesh;
}
