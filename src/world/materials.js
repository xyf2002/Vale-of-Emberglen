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

/* ---------------------------------------------------------------- ground texture */

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

  const ca = new THREE.Color(tintA), cb = new THREE.Color(tintB);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 1, f = freq, sum = 0, nrm = 0;
      for (let o = 0; o < octaves; o++) {
        sum += a * pnoise((x / size) * f, (y / size) * f, f);
        nrm += a; a *= 0.5; f *= 2;
      }
      let n = sum / nrm; // -1..1
      n = 0.5 + n * 0.5 * contrast * 2;
      n = Math.max(0, Math.min(1, n));
      const i = (y * size + x) * 4;
      img.data[i] = (ca.r + (cb.r - ca.r) * n) * 255;
      img.data[i + 1] = (ca.g + (cb.g - ca.g) * n) * 255;
      img.data[i + 2] = (ca.b + (cb.b - ca.b) * n) * 255;
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
      uMax: { value: opts.maxHaze ?? 0.92 },
      uBase: { value: new THREE.Color(opts.color ?? 0xffffff).convertSRGBToLinear() },
      uDesat: { value: opts.desat ?? 0.55 },
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
      uniform float uNear, uFar, uMax, uDesat;
      varying vec3 vN; varying vec3 vW; varying vec3 vC;
      void main() {
        vec3 n = normalize(vN);
        float ndl = max(dot(n, normalize(uSun)), 0.0);
        float sky = 0.5 + 0.5 * n.y;
        vec3 base = uBase * vC;
        vec3 c = base * (uAmb * (0.35 + 0.45 * sky) + uSunCol * (0.75 * ndl));
        float d = length(vW - cameraPosition);
        // same curve three's linear fog uses, so the seam with the terrain is invisible
        float f = smoothstep(uNear, uFar, d);
        // crush saturation with distance — hue shifts toward the sky, per ref #7
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(c, vec3(lum), uDesat * f);
        // Aerial perspective in LINEAR space, before the pipeline tone-maps. The
        // old order mixed the sRGB fog colour into the linear composer buffer,
        // which washed far geometry toward white in every capture. The grade now
        // applies ACES+sRGB to the finished mix exactly once, like the terrain.
        float f2 = smoothstep(uFar, uFar * 3.4, d);
        float haze = min(1.0, f * uMax + f2 * (1.0 - uMax) * 0.8);
        c = mix(c, uFogS, haze);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  mat.vertexColors = true;
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
  const moss = new THREE.Color(mossHex).convertSRGBToLinear();
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
