import * as THREE from 'three';

/**
 * FUR SHADING — reference observation #4.
 *
 *   "matte and micro-fuzzy; nothing is glossy ... a broad, very low intensity diffuse
 *    falloff and essentially no specular lobe ... a thin warm rim light along the
 *    top-back edge ... subtle (maybe 10-15% of the key's intensity) but always present."
 *
 * MeshStandardMaterial out of the box gives us the exact opposite: a GGX lobe and a hard
 * terminator. So we patch it:
 *   1. specular is zeroed (optionally a whisper of satin for smooth-skinned species)
 *   2. a wrapped ("half-lambert-ish") fill term widens the diffuse falloff far past the
 *      terminator, which is what light scattering through flocked fibre actually does
 *   3. a fresnel rim, masked to the upward + away-from-camera side and modulated by the
 *      key direction, tinted warm
 *   4. a fresnel "fuzz" lift at grazing angles — asperity scattering, the reason a wool
 *      silhouette looks slightly luminous at its edge
 */
export function furMaterial({ map, sheen = 0.0, rim = 0.15, rimColor = 0xffd7a8, fill = 0.34, wrap = 0.62, fuzz = 0.16, transparent = false }) {
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
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, mat.userData.u);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uRim; uniform vec3 uRimColor;
        uniform float uFill; uniform float uWrap; uniform float uFuzz; uniform float uSheen;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        material.roughness = 1.0;
        material.specularColor = vec3( 0.006 + uSheen * 0.05 );
        material.specularF90 = 0.02 + uSheen * 0.35;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if ( NUM_DIR_LIGHTS > 0 )
        {
          vec3 Nv = normalize( normal );
          vec3 Vv = normalize( vViewPosition );
          vec3 Lv = normalize( directionalLights[ 0 ].direction );
          float ndl = dot( Nv, Lv );

          // 2. broad wrapped fill — fur scatters far around the terminator
          float wr = max( 0.0, ( ndl + uWrap ) / ( 1.0 + uWrap ) );
          wr = wr * wr;
          float shade = 1.0;
          #if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
            shade = mix( 0.55, 1.0, getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] ) );
          #endif
          reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * diffuseColor.rgb * ( wr * uFill * shade );

          float fres = pow( clamp( 1.0 - max( dot( Nv, Vv ), 0.0 ), 0.0, 1.0 ), 2.6 );

          // 4. asperity / fuzz lift at grazing angles
          reflectedLight.indirectDiffuse += diffuseColor.rgb * fres * uFuzz * ( 0.35 + 0.65 * max( ndl, 0.0 ) );

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
 * Shared multiply-blended contact-shadow decal pool. Reference observation #9.
 *
 * Per-instance strength rides in instanceColor.r: 1 = full contact shadow, 0 = gone.
 * A plain multiply cannot lighten, so the shader lerps the sampled multiplier back
 * toward white instead — that is what lets a hopping creature's shadow soften and
 * spread as it leaves the ground rather than sliding around underneath it.
 */
export function makeContactShadows(texture, max = 48) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  // Multiply, spelled out as custom blending: THREE.MultiplyBlending refuses to run
  // without premultipliedAlpha and falls back to *no* blending, which puts an opaque
  // white card under every creature. dst = dst * src is what we actually want.
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
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

  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.count = 0;
  mesh.name = 'creature-contact-shadows';
  return mesh;
}
