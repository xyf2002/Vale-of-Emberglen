import * as THREE from 'three';
import { mkCanvas } from './procgen.js';

/**
 * FUR SHADING — reference observation #4.
 *
 *   "matte and micro-fuzzy; nothing is glossy ... a broad, very low intensity diffuse
 *    falloff and essentially no specular lobe ... a thin warm rim light along the
 *    top-back edge ... subtle (maybe 10-15% of the key's intensity) but always present."
 *
 * ---------------------------------------------------------------------------
 * WHY THE CREATURES USED TO READ AS "LIT FROM EVERY DIRECTION EQUALLY"
 *
 * A blind critic's verdict on the creature portrait was that our Woolkin "has
 * essentially no shading gradient at all: the underside of the creature is the same
 * value as the top". That was not a hunch, and it was not the `wrap` term. It was
 * measured, by writing the raw lighting terms out as colour and reading the pixels:
 *
 *   indirect diffuse : ~1.29 x albedo at the top of the ball, ~1.25 at the bottom
 *   direct sun       : ~0.37 x albedo
 *
 * i.e. the ambient was 3.4x the key, and it was FLAT. Two causes, both fixed here:
 *
 *   1. `scene.environment` is a PMREM of the sky dome, and the sky dome is a sphere
 *      with no ground in it. Its lower hemisphere is sky, so the IBL lit the creature's
 *      belly exactly as hard as its back. Nothing in the standard pipeline knows that
 *      an object standing in a meadow cannot see sky through the meadow. So we apply
 *      our own sky-visibility term to the IBL irradiance (`uAmbFloor`) and give back a
 *      fraction of what we removed as a warm ground bounce (`uBounce`) — reference #9's
 *      "cooler, less saturated version of the lit colour", and the critic's own note
 *      that the real pal has "a warm bounce back up from the grass".
 *
 *   2. The sun was being multiplied by ~0.48 EVERYWHERE by the shadow map. That is not
 *      a shadow, it is self-shadow acne: the map is ~7 cm/texel and the PCF kernel spans
 *      ~22 cm, which on a 90 cm ball means roughly half the taps land behind the
 *      surface no matter which way it faces. (Measured: turning castShadow off took the
 *      term from 0.48 to 0.77 with no change in shape.) A uniform 0.5 on the key and
 *      nothing on the ambient is *precisely* the recipe for a flat creature. So the
 *      creature's shadow lookup gets its own, much larger depth bias (`uShadowBias`);
 *      creatures still receive real cast shadows from trees and terrain, they just stop
 *      shadowing themselves into mush.
 *
 * With the ambient no longer swamping it, the key can carry the form (`uKey`).
 * ---------------------------------------------------------------------------
 *
 * On top of that, the stylisation the reference actually asks for:
 *   1. specular is zeroed (optionally a whisper of satin for smooth-skinned species)
 *   2. a wrapped ("half-lambert-ish") fill term widens the diffuse falloff past the
 *      terminator, which is what light scattering through flocked fibre actually does
 *   3. a fresnel rim, masked to the upward + away-from-camera side and modulated by the
 *      key direction, tinted warm
 *   4. a fresnel "fuzz" lift at grazing angles — asperity scattering, the reason a wool
 *      silhouette looks slightly luminous at its edge
 *   5. a ground-line occlusion: the bottom of a creature standing in grass is buried in
 *      it. Without this things "sit on top of the image" instead of in the world.
 */

// three's own line out of <lights_fragment_begin>. Matched loosely enough to survive
// whitespace churn, strictly enough that a signature change fails visibly rather than
// silently leaving the acne in place.
const DIR_SHADOW_LINE = /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \],([\s\S]*?)directionalLightShadow\.shadowBias,([\s\S]*?)\) : 1\.0;/;

export function furMaterial({
  map, sheen = 0.0, rim = 0.15, rimColor = 0xffd7a8, fill = 0.34, wrap = 0.62,
  fuzz = 0.16, transparent = false,
  // --- form ---
  key = 2.05,              // multiplier on the sun's direct diffuse
  ambFloor = 0.30,         // sky light a fully downward-facing surface keeps
  bounce = 0.42,           // fraction of the blocked sky light returned as ground bounce
  bounceColor = 0xc9ad74,  // dry-grass bounce, warm and desaturated
  // Ground-line occlusion. r13: raised from 0.42/0.20. A creature standing in a 0.30-
  // 0.60 m carpet has its whole lower third inside the canopy, not just its toes, and
  // 0.20 of normalised height on a Woolkin is about 18 cm — the ramp finished below the
  // grass line, so from any playable camera the visible bottom of the body was as bright
  // as its back. That is half of "it sits on top of the picture"; the other half is the
  // ground itself, handled by CONTACT_LAYERS below. Measured on creature_portrait: this
  // pair is what darkens the wool where the blades cross it.
  groundAO = 0.55,         // occlusion at the very bottom of the creature
  groundAOh = 0.34,        // ...falling off over this much of its normalised height
  groundAOkey = 0.80,      // ...and how much of it also lands on the sun. 0 = ambient only
  shadowBias = -0.00048,   // ~0.6 m of depth push: enough to clear a creature's own hull
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: map || null,
    vertexColors: true,
    roughness: 1.0,
    metalness: 0.0,
    transparent,
    depthWrite: !transparent,
    side: THREE.FrontSide,
  });
  mat.userData.u = {
    uRim: { value: rim },
    uRimColor: { value: new THREE.Color(rimColor) },
    uFill: { value: fill },
    uWrap: { value: wrap },
    uFuzz: { value: fuzz },
    uSheen: { value: sheen },
    uKey: { value: key },
    uAmbFloor: { value: ambFloor },
    uBounce: { value: bounce },
    uBounceColor: { value: new THREE.Color(bounceColor) },
    uGroundAO: { value: groundAO },
    uGroundAOh: { value: groundAOh },
    uGroundAOkey: { value: groundAOkey },
    uShadowBias: { value: shadowBias },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.u);

    // vBodyY: height up the creature in its own normalised space (feet 0, crown ~1).
    // Taken after skinning, so a creature that crouches or rears carries its ground-line
    // occlusion with it.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vBodyY;`)
      .replace('#include <project_vertex>', `vBodyY = transformed.y;
        #include <project_vertex>`);

    // ---- 1. stop the creature shadowing itself into a uniform half-light --------
    // onBeforeCompile hands us the shader BEFORE #include resolution, so to touch a
    // line inside a stock chunk we have to expand that chunk ourselves.
    const litBegin = THREE.ShaderChunk.lights_fragment_begin.replace(DIR_SHADOW_LINE,
      'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ],$1uShadowBias,$2) : 1.0;');
    if (!/uShadowBias/.test(litBegin)) {
      console.warn('[creatures] fur shader: could not re-bias the directional shadow lookup; '
        + 'creatures will self-shadow to a flat half-light.');
    }

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', litBegin)
      .replace('#include <common>', `#include <common>
        uniform float uRim; uniform vec3 uRimColor;
        uniform float uFill; uniform float uWrap; uniform float uFuzz; uniform float uSheen;
        uniform float uKey; uniform float uAmbFloor; uniform float uBounce; uniform vec3 uBounceColor;
        uniform float uGroundAO; uniform float uGroundAOh; uniform float uGroundAOkey;
        uniform float uShadowBias;
        varying float vBodyY;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.roughness = 1.0;
        material.specularColor = vec3( 0.006 + uSheen * 0.05 );
        material.specularF90 = 0.02 + uSheen * 0.35;`)
      // ---- 0. the ambient stops being a light box -----------------------------
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        {
          vec3 nWa = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
          // what fraction of the sky this normal can actually see. The env map is a
          // ground-less sky sphere, so without this the belly is lit like the back.
          float skyOcc = mix( uAmbFloor, 1.0, smoothstep( -0.62, 0.80, nWa.y ) );
          // and the ground line, where the creature is buried in grass
          float gao = 1.0 - uGroundAO * ( 1.0 - smoothstep( 0.0, uGroundAOh, vBodyY ) );
          vec3 lost = iblIrradiance * ( 1.0 - skyOcc );
          iblIrradiance *= skyOcc * gao;
          irradiance *= mix( 0.62, 1.0, skyOcc ) * gao;
          irradiance += lost * uBounce * uBounceColor;
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // The ground line occludes the KEY too, not just the ambient.
        //
        // MEASURED, r13: raising uGroundAO from 0.42 to 0.55 moved the rendered bottom of
        // a Woolkin by almost nothing, and the reason is in the block above — gao was
        // applied to iblIrradiance and irradiance only. Since the fur shader started
        // multiplying the key by uKey (2.05) to stop the creature being an ambient-lit
        // ball, the ambient is no longer the dominant term, so occluding only the ambient
        // occludes a minority share of the pixel. A creature standing in a 0.45 m carpet
        // has its lower body shaded from the sun by the blades, so the same ramp belongs
        // on the direct term. Held slightly weaker (0.80) than the ambient occlusion: a
        // blade carpet is gappy, and crushing the key to zero at the waterline reads as
        // a creature dipped in ink rather than one standing in grass. uGroundAOkey is a
        // live uniform so tools/_groundprobe2.mjs can put the material back to its
        // pre-r13 ambient-only behaviour and attribute the guardrail movement.
        {
          float gaoD = 1.0 - uGroundAO * uGroundAOkey * ( 1.0 - smoothstep( 0.0, uGroundAOh, vBodyY ) );
          reflectedLight.directDiffuse *= uKey * gaoD;
        }
        #if ( NUM_DIR_LIGHTS > 0 )
        {
          vec3 Nv = normalize( normal );
          vec3 Vv = normalize( vViewPosition );
          vec3 Lv = normalize( directionalLights[ 0 ].direction );
          float ndl = dot( Nv, Lv );

          // 2. broad wrapped fill — fur scatters far around the terminator. It must NOT
          // reach all the way round: at wrap 0.6 a plain remap would still light a fully
          // back-facing surface at 0.375, which flattens a sphere into a disc. The square
          // keeps the lift weighted to the lit side, where scattering actually happens.
          float wr = max( 0.0, ( ndl + uWrap ) / ( 1.0 + uWrap ) );
          wr = wr * wr;
          float shade = 1.0;
          #if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
            shade = mix( 0.55, 1.0, getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, uShadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] ) );
          #endif
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb * ( wr * uFill * shade );

          float fres = pow( clamp( 1.0 - max( dot( Nv, Vv ), 0.0 ), 0.0, 1.0 ), 2.6 );

          // 4. asperity / fuzz lift at grazing angles. Weighted hard onto the lit side —
          // an unweighted version outlines the whole silhouette evenly, which is another
          // way of saying "lit from every direction".
          reflectedLight.indirectDiffuse += diffuseColor.rgb * fres * uFuzz * ( 0.15 + 0.85 * max( ndl, 0.0 ) );

          // 3. thin warm rim on the top-back edge
          vec3 Nw = normalize( ( vec4( Nv, 0.0 ) * viewMatrix ).xyz );
          float top  = smoothstep( -0.25, 0.85, Nw.y );
          float back = smoothstep( -0.75, 0.55, ndl );
          reflectedLight.indirectSpecular += uRimColor * ( fres * fres * top * back * uRim * 3.0 );
        }
        #endif`);
  };
  mat.customProgramCacheKey = () => `fur|${sheen}|${transparent}`;
  return mat;
}

/**
 * Contact-shadow decal profile. Reference observation #9:
 * "a small, tight, distinctly darker ellipse directly under the feet with a hard-ish
 * inner core and ~0.2 m of falloff. Drop the contact shadow and everything floats."
 *
 * The real shadow map cannot do this job: its texel is 6.8 cm, larger than the contact
 * region it would have to resolve. A decal is the right technique. It just has to be a
 * good decal instead of a black sticker.
 *
 * WHY THE DECAL READ AS A HARD BLACK BLOB (measured, not guessed):
 *   The old texture was authored as a set of sRGB stops — the darkest was rgb(104,111,132),
 *   intended as "multiply the ground by 0.41". But the scene renders into a HalfFloat
 *   LINEAR render target (src/post/index.js), and the texture was flagged SRGBColorSpace,
 *   so the number the blender actually multiplied by was sRGB->linear(104/255) = **0.14**.
 *   Every creature stood on an 86%-black ellipse. The fix is to author the profile
 *   directly in linear multiplier space and tell three not to decode it.
 */
function contactDecal() {
  const S = 256, R = S / 2;
  const c = mkCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;

  // Linear multipliers at the core. Cool and desaturated rather than black or grey:
  // blue is attenuated least, so the shaded ground shifts toward the sky's hue exactly
  // as reference #9 describes. This is a *darkening of the ground beneath*, which is
  // what a multiply is — never an opaque painted ellipse.
  //
  // Round 13: lightened from [0.35,0.385,0.475]. One decal used to carry the whole
  // contact term; there are now CONTACT_LAYERS of them stacked through the grass
  // canopy, and multiply blending compounds. See CONTACT_LAYERS for the arithmetic.
  const CORE = [0.46, 0.495, 0.585];
  const sstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R;
      const r = Math.sqrt(dx * dx + dy * dy);
      // The profile has to survive being sat on. From a low camera the creature's own
      // body hides the inner 55-65% of its own decal, so a falloff that is over by
      // r=0.6 is a shadow nobody can see. Hold the core out past the silhouette and
      // spend the whole outer 40% on falloff — ~0.2 m on a 1 m decal, per reference #9.
      const f = 1 - sstep(0.44, 1.0, r);
      const i = (y * S + x) * 4;
      d[i] = Math.round(255 * (1 - (1 - CORE[0]) * f));
      d[i + 1] = Math.round(255 * (1 - (1 - CORE[1]) * f));
      d[i + 2] = Math.round(255 * (1 - (1 - CORE[2]) * f));
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  // NOT SRGBColorSpace: the byte IS the linear multiplier. See the note above.
  t.colorSpace = THREE.NoColorSpace;
  // no mips: at grazing angles a mipped 1x1 of this texture averages to near-white and
  // the shadow quietly evaporates in the mid ground.
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/**
 * THE CONTACT TERM IS A STACK OF SLABS, NOT A DECAL. Read this before flattening it.
 *
 * A single decal on the ground plane is the obvious implementation and it does not work
 * in a meadow, which is measurable rather than arguable. Two independent measurements:
 *
 *   - depthTest off vs on, one flat decal: 30405 covered pixels became 4224. 86% of a
 *     ground-plane decal fails the depth test against blades standing in front of it.
 *   - r13 `tools/_groundprobe2.mjs`, which A/Bs the grounding meshes themselves rather
 *     than the shadow map: the flat decal covered 0.147% of creature_group and 1.398%
 *     of creature_portrait, and the diff image is not an ellipse — it is a row of
 *     blade-shaped slivers, the gaps *between* the grass, at the bottom of the subject.
 *
 * The reason is structural. The meadow carpet is 0.30-0.60 m tall and the creature is
 * standing IN it, so from any playable camera the pixels around a creature's base are
 * grass, not ground. Darkening the ground plane darkens something nobody can see.
 * Lifting the one decal higher does not fix it either: it detaches from the feet long
 * before it clears the canopy.
 *
 * So the occlusion is sliced: CONTACT_LAYERS horizontal discs from the soil up through
 * the canopy, shrinking and weakening with height. A blade whose visible pixel sits at
 * 0.25 m gets darkened by the discs the view ray crossed above it; a bare patch of soil
 * gets darkened by all of them. It is the same volume a real ambient occlusion term
 * would describe, integrated the only way a forward renderer with no readable depth
 * buffer can integrate it. One draw call, `max * CONTACT_LAYERS.length` instances.
 *
 * Multiply blending COMPOUNDS, so the stack has to be budgeted. With CORE red = 0.46
 * each layer contributes `1 - 0.54 * strength`, and the four below multiply to 0.29 at
 * the exact centre (which is under the belly, where the body hides it) and 0.54 for the
 * ground layer alone. Raising any strength is a multiplicative change, not an additive
 * one — check the product before touching them.
 *
 * y is in creature-size units (a 1 m creature stands in ~0.45 m of grass).
 */
export const CONTACT_LAYERS = [
  { y: 0.020, r: 1.20, s: 0.95 },   // the ground itself
  { y: 0.140, r: 1.10, s: 0.55 },   // blade bases
  { y: 0.290, r: 0.96, s: 0.38 },   // mid canopy
  { y: 0.460, r: 0.76, s: 0.26 },   // tips, right at the creature's waterline
];

/**
 * Shared multiply-blended contact-occlusion pool.
 *
 * Per-instance strength rides in instanceColor.r: 1 = full contact shadow, 0 = gone.
 * A plain multiply cannot lighten, so the shader lerps the sampled multiplier back
 * toward white instead. That is what carries both the per-layer weight above and the
 * air-gap fade — a creature that hops visibly leaves its own occlusion behind instead
 * of dragging a sticker around under itself.
 *
 * @param _legacy  ignored. The caller still builds procgen.js's sRGB-authored texture,
 *                 which is four times darker than it reads as (see contactDecal), so
 *                 the pool authors its own. Kept in the signature because the creature
 *                 system that calls this is owned elsewhere.
 * @param max      creatures, not instances. Capacity is max * CONTACT_LAYERS.length.
 */
export function makeContactShadows(_legacy, max = 48) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  // NOTE: no geo.translate() any more. Height is per-layer and per-creature-size, so it
  // has to ride in the instance matrix; baking a constant lift into the geometry is what
  // pinned every slab to the soil.
  // Multiply, spelled out as custom blending: THREE.MultiplyBlending refuses to run
  // without premultipliedAlpha and falls back to *no* blending, which puts an opaque
  // white card under every creature. dst = dst * src is what we actually want.
  const mat = new THREE.MeshBasicMaterial({
    map: contactDecal(),
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    depthWrite: false,
    depthTest: true,
    // the decal sits a couple of centimetres over a terrain mesh whose triangles are
    // ~2 m across; polygon offset keeps it out of the z-fight zone on slopes without
    // having to lift it far enough to visibly detach from the feet.
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
      .replace('#include <color_fragment>', `
        #ifdef USE_INSTANCING_COLOR
          diffuseColor.rgb = mix( vec3( 1.0 ), diffuseColor.rgb, clamp( vColor.r, 0.0, 1.0 ) );
        #endif`);
  };
  mat.customProgramCacheKey = () => 'contactShadow';

  const cap = max * CONTACT_LAYERS.length;
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  // after the opaque pass (terrain, grass, creatures) and before anything additive.
  mesh.renderOrder = 3;
  mesh.count = 0;
  mesh.name = 'creature-contact-shadows';
  mesh.userData.layers = CONTACT_LAYERS;
  return mesh;
}
