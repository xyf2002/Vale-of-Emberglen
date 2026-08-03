import * as THREE from 'three';

/* ---------------------------------------------------------------- geometry merge */

/** merge a list of non-indexed geometries that all carry position/normal/color */
export function mergeGeos(geos) {
  const list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nrm.set(g.attributes.normal.array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, o * 3);
    else col.fill(1, o * 3, o * 3 + n * 3);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** paint a constant colour into a geometry's vertex colours */
export function paint(geo, hex, jitter = 0, noiseFn = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  // ColorManagement is on: `new THREE.Color(hex)` is already in linear working space,
  // so convertSRGBToLinear() here would double-darken the vertex albedo (6-12x).
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  const p = g.attributes.position.array;
  for (let i = 0; i < n; i++) {
    let v = 1;
    if (jitter && noiseFn) v = 1 + jitter * noiseFn(p[i * 3] * 2.4, p[i * 3 + 2] * 2.4, 2);
    arr[i * 3] = c.r * v; arr[i * 3 + 1] = c.g * v; arr[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * Undo a double sRGB->linear conversion baked into a geometry's vertex colours.
 *
 * `new THREE.Color(hex)` already lands in linear working space (ColorManagement is on),
 * so any builder that also calls .convertSRGBToLinear() ends up with an albedo 5-8x
 * darker than the hex it authored. The rock geometry is built that way: 0x8e8e85, a
 * mid grey, arrives as linear 0.028 — darker than wet asphalt. Lit rock rendered at
 * ~107/255 and shadowed rock at ~50/255, so every boulder in the meadow read as a black
 * hole rather than as one of the "three or four material changes across the shot" that
 * reference #8 asks for, and the moss cap on it had nothing to sit on.
 *
 * The generator lives outside this system, so the correction is applied to the finished
 * attribute here rather than by reaching into someone else's file.
 */
export function liftVertexAlbedo(geo, gain) {
  const a = geo?.attributes?.color;
  if (!a) return geo;
  const arr = a.array;
  for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, arr[i] * gain);
  a.needsUpdate = true;
  return geo;
}

/* ---------------------------------------------------------------- ground texture */

/** deterministic periodic value-noise sampler on a torus of period `per` */
function periodicNoise(seed) {
  const perm = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), s | 1) ^ (s + Math.imul(s ^ (s >>> 7), s | 61))) >>> 0; return s / 4294967296; };
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y) => { switch (h & 3) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; default: return -x - y; } };
  return (x, y, per) => {
    const X = Math.floor(x), Y = Math.floor(y);
    const fx = x - X, fy = y - Y;
    const u = fade(fx), v = fade(fy);
    const X0 = ((X % per) + per) % per, X1 = (X0 + 1) % per;
    const Y0 = ((Y % per) + per) % per, Y1 = (Y0 + 1) % per;
    const A0 = perm[perm[X0] + Y0], A1 = perm[perm[X0] + Y1];
    const B0 = perm[perm[X1] + Y0], B1 = perm[perm[X1] + Y1];
    return lp(lp(grad(A0, fx, fy), grad(B0, fx - 1, fy), u), lp(grad(A1, fx, fy - 1), grad(B1, fx - 1, fy - 1), u), v);
  };
}

/**
 * Three DECORRELATED periodic fbm fields packed into R/G/B, stored raw (no colour
 * space encoding, no mipmap-killing filters). This is the material-blend mask the
 * ground shader runs on: sampled at four world scales it supplies the "two or three
 * low-frequency noise octaves" the critique asks for without a per-pixel fbm loop.
 *
 * Each channel gets its own permutation table AND its own base frequency, so the
 * three fields do not share features — sampling R at 23 m and G at 4 m gives genuinely
 * independent patch boundaries rather than the same blob at two sizes.
 *
 * Every channel is normalised to fill 0..1 after generation, so smoothstep thresholds
 * in the shader mean what they look like they mean.
 */
export function makeMaskTexture(seed, size = 256, bases = [5, 7, 11], octaves = 4) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);
  const chans = [];
  for (let c = 0; c < 3; c++) {
    const pn = periodicNoise((seed ^ (0x9e37 * (c + 1))) >>> 0);
    const base = bases[c];
    const buf = new Float32Array(size * size);
    let lo = 1e9, hi = -1e9;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let a = 1, f = base, sum = 0, nrm = 0;
        for (let o = 0; o < octaves; o++) {
          sum += a * pn((x / size) * f, (y / size) * f, f);
          nrm += a; a *= 0.55; f *= 2;
        }
        const v = sum / nrm;
        buf[y * size + x] = v;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const inv = 1 / Math.max(1e-5, hi - lo);
    for (let i = 0; i < buf.length; i++) buf[i] = (buf[i] - lo) * inv;
    chans.push(buf);
  }
  for (let i = 0; i < size * size; i++) {
    img.data[i * 4] = Math.round(chans[0][i] * 255);
    img.data[i * 4 + 1] = Math.round(chans[1][i] * 255);
    img.data[i * 4 + 2] = Math.round(chans[2][i] * 255);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** seamless tiling value-noise texture, generated at runtime (no external assets) */
export function makeNoiseTexture(seed, size = 256, freq = 5, octaves = 4, contrast = 0.30, tintA = 0x8b8b7a, tintB = 0xffffff) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const img = g.createImageData(size, size);

  const perm = new Uint8Array(512);
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), s | 1) ^ (s + Math.imul(s ^ (s >>> 7), s | 61))) >>> 0; return s / 4294967296; };
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y) => { switch (h & 3) { case 0: return x + y; case 1: return -x + y; case 2: return x - y; default: return -x - y; } };
  // periodic value noise on a torus of period `per`
  const pnoise = (x, y, per) => {
    const X = Math.floor(x), Y = Math.floor(y);
    const fx = x - X, fy = y - Y;
    const u = fade(fx), v = fade(fy);
    const X0 = ((X % per) + per) % per, X1 = (X0 + 1) % per;
    const Y0 = ((Y % per) + per) % per, Y1 = (Y0 + 1) % per;
    const A0 = perm[perm[X0] + Y0], A1 = perm[perm[X0] + Y1];
    const B0 = perm[perm[X1] + Y0], B1 = perm[perm[X1] + Y1];
    return lp(lp(grad(A0, fx, fy), grad(B0, fx - 1, fy), u), lp(grad(A1, fx, fy - 1), grad(B1, fx - 1, fy - 1), u), v);
  };

  // ------------------------------------------------------------------------
  // THIS IS ALBEDO *MODULATION*, NOT ALBEDO. Two compounding bugs used to make it
  // eat most of the ground's brightness, and that was the single largest cause of
  // the 2-3x too dark ground:
  //
  //   1. `new THREE.Color(hex)` is already LINEAR (ColorManagement is on), and the
  //      result was written straight into an sRGB-tagged canvas. Sampling therefore
  //      linearised it a second time: the authored 0.275 came back as 0.093.
  //   2. the ramp ran the full way down to the dark tint, so the MEAN multiplier on
  //      ground albedo was ~0.36, not ~1.
  //
  //   measured: tintA 0x8f8f83, contrast 0.34  ->  sampled linear 0.13 .. 0.76,
  //   mean 0.36. The ground albedo was being cut to a third before a single light
  //   touched it.
  //
  // Fixed: the ramp is normalised so its BRIGHT end is white, its dark end is the
  // authored tint compressed toward white by MOD, and the result is sRGB-encoded on
  // the way out so the sampler returns what was authored. Mean multiplier ~0.86.
  // ------------------------------------------------------------------------
  const ca = new THREE.Color(tintA), cb = new THREE.Color(tintB);
  // How much of the authored darkening survives. Low values make the ground a flat
  // painted sheet (which is what the first fix produced -- correct brightness, no
  // texture); 0.66 keeps a visible mottle without eating the albedo again.
  const MOD = 0.66;
  const norm = Math.max(cb.r, cb.g, cb.b, 1e-4);
  const lo = [ca.r, ca.g, ca.b].map((v, k) => 1 - MOD * (1 - v / norm) * ([cb.r, cb.g, cb.b][k] / norm));
  const hi = [cb.r / norm, cb.g / norm, cb.b / norm];
  const enc = (v) => {
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Two extra octaves and a shallower amplitude rolloff (0.58 rather than 0.5).
      // The ground map repeats every 7.5 m, so with a 1/2 rolloff there is almost no
      // energy left at the 10-20 cm scale and a camera 1-2 m off the deck sees a
      // smooth painted surface. The reference plates have visible ground texture at
      // exactly that scale.
      let a = 1, f = freq, sum = 0, nrm = 0;
      for (let o = 0; o < octaves + 2; o++) {
        sum += a * pnoise((x / size) * f, (y / size) * f, f);
        nrm += a; a *= 0.58; f *= 2;
      }
      let n = sum / nrm; // -1..1
      n = 0.5 + n * 0.5 * contrast * 2;
      n = Math.max(0, Math.min(1, n));
      const i = (y * size + x) * 4;
      img.data[i] = enc(lo[0] + (hi[0] - lo[0]) * n);
      img.data[i + 1] = enc(lo[1] + (hi[1] - lo[1]) * n);
      img.data[i + 2] = enc(lo[2] + (hi[2] - lo[2]) * n);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------- aerial-perspective shader */

/**
 * Distant geometry (the horizon skirt, mesas, the far tower) is drawn with THREE's fog
 * DISABLED and its own aerial perspective, capped short of 100%. Linear scene fog would
 * flatten anything past `far` into pure sky and the 1–3 km landmark that reference
 * observation #7 demands would simply vanish. This keeps it as a pale, low-saturation
 * silhouette that still reads.
 */
export function makeAerialMaterial(opts = {}) {
  const mat = new THREE.ShaderMaterial({
    fog: false,
    vertexColors: true,
    uniforms: {
      // LINEAR-space haze colour (ColorManagement already linearizes the hex):
      // mixed into the linear colour buffer and tone-mapped by the pipeline.
      uFogS: { value: new THREE.Color(0xc9dcea) },
      uSun: { value: new THREE.Vector3(0.3, 0.85, 0.4) },
      uSunCol: { value: new THREE.Color(0xffffff) },
      uAmb: { value: new THREE.Color(0x9fb6cc) },
      uNear: { value: 140 },
      uFar: { value: 900 },
      // Density of the scene's FogExp2, mirrored here so distant geometry hazes on
      // EXACTLY the curve the near terrain and the foliage do. See uDensity use below.
      uDensity: { value: 0.0021 },
      uMax: { value: opts.maxHaze ?? 0.92 },
      uBase: { value: new THREE.Color(opts.color ?? 0xffffff).convertSRGBToLinear() },
      uDesat: { value: opts.desat ?? 0.55 },
      // How much surface form survives the haze. At maxHaze 0.90 a straight mix leaves
      // 10% of the shading, which is why the far ranges read as "flat paper cutouts:
      // single-facet white silhouettes, no rock striation, no shading break". This
      // re-applies the form term AFTER the haze as a multiplier around 1.0, so the
      // mountains stay pale and desaturated (reference #7) while still having a lit
      // shoulder and a shaded one.
      uForm: { value: opts.form ?? 0.42 },
      // Mean vertex luminance of the geometry this material is used on. The form
      // restore below re-expands contrast AROUND this value, so it must be the
      // actual mean or the correction becomes a brightness offset and shifts the
      // horizon's exposure (which the ground/sky ratio guardrail measures). Set it
      // with setAerialPivot() once the geometry exists.
      uPivot: { value: opts.pivot ?? 0.62 },
    },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vW; varying vec3 vC;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz; vC = color;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uFogS, uSun, uSunCol, uAmb, uBase;
      uniform float uNear, uFar, uMax, uDesat, uForm, uPivot, uDensity;
      varying vec3 vN; varying vec3 vW; varying vec3 vC;
      void main() {
        vec3 n = normalize(vN);
        float ndl = max(dot(n, normalize(uSun)), 0.0);
        float sky = 0.5 + 0.5 * n.y;
        vec3 base = uBase * vC;
        vec3 c = base * (uAmb * (0.35 + 0.45 * sky) + uSunCol * (0.75 * ndl));
        // the form term, kept aside so it can be re-applied on top of the haze below
        float form = ndl * 0.58 + sky * 0.42;
        float vLum = dot(vC, vec3(0.2126, 0.7152, 0.0722));
        float d = length(vW - cameraPosition);
        // ------------------------------------------------------------------
        // THE FLOATING-VEGETATION SEAM.
        //
        // The scene fog is FogExp2, and the ground mesh, the trees and the bushes all
        // fade on 1 - exp(-(d*density)^2). This material used smoothstep(140, 900, d)
        // instead, which is a completely different curve: at the seam where the ground
        // mesh ends (460 m) the NEAR terrain sat at 0.61 haze while the FAR terrain
        // 30 m behind it sat at 0.40. Terrain got *less* misty as it receded, so the
        // mid-ground hills washed out while the ranges behind them stayed solid, and
        // the canopies sitting on the hazier ground read as darker objects hanging in
        // white air with nothing under them.
        //
        // Same curve, same density, one cap. The cap is what keeps the 1-3 km landmark
        // from dissolving completely (reference #7 wants it pale, not gone).
        // ------------------------------------------------------------------
        float f = clamp(1.0 - exp(-(d * uDensity) * (d * uDensity)), 0.0, 1.0);
        // crush saturation with distance — hue shifts toward the sky, per ref #7
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(lum), uDesat * f);
        // Aerial perspective in LINEAR space, before the pipeline tone-maps. The
        // old order mixed the sRGB fog colour into the linear composer buffer,
        // which washed far geometry toward white in every capture. The grade now
        // applies ACES+sRGB to the finished mix exactly once, like the terrain.
        float haze = min(f, uMax);
        c = mix(c, uFogS, haze);
        // Put the shading break back. Without this the far ranges are a single flat
        // value: a paper cutout. Scaled by the haze term so it only acts where the mix
        // has already eaten the real shading, and centred on 1.0 so it changes contrast,
        // not exposure — the horizon's mean luminance is unchanged.
        c *= 1.0 + uForm * haze * ((form - 0.55) * 1.15 + (vLum / max(uPivot, 1e-4) - 1.0) * 1.30);
        gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.vertexColors = true;
  return mat;
}

/**
 * Point an aerial material's contrast pivot at the geometry it actually draws.
 * Without this the "put the shading break back" term (see uForm) is centred on a
 * guess, and a guess that is wrong by 30% lifts or drops the whole horizon band —
 * which moves the measured ground/sky luminance ratio for reasons that have
 * nothing to do with the ground.
 */
export function setAerialPivot(mat, geo) {
  const a = geo?.attributes?.color?.array;
  if (!a || !mat?.uniforms?.uPivot) return mat;
  let s = 0;
  const n = a.length / 3;
  for (let i = 0; i < n; i++) s += 0.2126 * a[i * 3] + 0.7152 * a[i * 3 + 1] + 0.0722 * a[i * 3 + 2];
  mat.uniforms.uPivot.value = Math.max(1e-4, s / n);
  return mat;
}

const _tmpC = new THREE.Color();

/** keep aerial materials in sync with whatever the sky system is doing */
export function syncAerial(mats, scene, sky) {
  const fogCol = scene.fog?.color ?? scene.background;
  for (const m of mats) {
    if (fogCol && fogCol.isColor) {
      // uFogS is mixed in linear space in the shader (see makeAerialMaterial), so
      // the LINEAR fog colour is passed through unchanged.
      m.uniforms.uFogS.value.copy(fogCol);
      m.uniforms.uAmb.value.copy(fogCol).lerp(_tmpC.setRGB(1, 1, 1), 0.18);
    }
    if (scene.fog) {
      // FogExp2 has no near/far; carrying its density across is what keeps the far
      // geometry on the same haze curve as everything three fogs itself.
      if (scene.fog.isFogExp2) m.uniforms.uDensity.value = scene.fog.density;
      else if (scene.fog.far) m.uniforms.uDensity.value = 1.6 / scene.fog.far;
      m.uniforms.uNear.value = scene.fog.near ?? 140;
      m.uniforms.uFar.value = scene.fog.far ?? 900;
    }
    if (sky?.getSunDirection) m.uniforms.uSun.value.copy(sky.getSunDirection());
    if (sky?.getSunColor) m.uniforms.uSunCol.value.copy(sky.getSunColor());
  }
}

/* --------------------------------------------------------------- moss-capped rock */

/**
 * Rock shader hook: moss only on upward-facing surfaces (reference observation #8),
 * with a noisy, broken edge so it does not read as a clean gradient.
 */
export function applyMossShader(mat, mossHex = 0x6d8a3c, opts = {}) {
  // NOT .convertSRGBToLinear(): ColorManagement is on, so `new THREE.Color(hex)` is
  // already in linear working space (see paint() above). The second conversion made the
  // moss ~7x too dark, which is why every rock and every ruin in the frames read as bare
  // grey stone -- "moss on stone" is one of the four material changes reference #8 asks
  // for across a single shot, and it was silently invisible.
  const moss = new THREE.Color(mossHex);
  mat.userData.moss = { value: new THREE.Vector3(moss.r, moss.g, moss.b) };
  mat.userData.mossAmt = { value: opts.amount ?? 1.0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMoss = mat.userData.moss;
    sh.uniforms.uMossAmt = mat.userData.mossAmt;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vUpness;\nvarying vec3 vWPos;')
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vec3 wN_ = objectNormal;
        #ifdef USE_INSTANCING
          wN_ = normalize(mat3(instanceMatrix) * wN_);
        #endif
        vUpness = normalize(mat3(modelMatrix) * wN_).y;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 wp_ = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp_ = instanceMatrix * wp_;
        #endif
        vWPos = (modelMatrix * wp_).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uMoss; uniform float uMossAmt;
        varying float vUpness; varying vec3 vWPos;
        float h21_(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vn_(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h21_(i), h21_(i+vec2(1,0)), f.x), mix(h21_(i+vec2(0,1)), h21_(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float nz = vn_(vWPos.xz * 0.55) * 0.6 + vn_(vWPos.xz * 1.9) * 0.4;
          float m = smoothstep(0.36, 0.80, vUpness + (nz - 0.5) * 0.55);
          m *= uMossAmt * smoothstep(0.0, 0.35, nz + 0.15);
          diffuseColor.rgb = mix(diffuseColor.rgb, uMoss * (0.75 + 0.5 * nz), clamp(m, 0.0, 1.0));
        }`);
  };
  mat.customProgramCacheKey = () => 'moss' + (opts.amount ?? 1);
  return mat;
}
