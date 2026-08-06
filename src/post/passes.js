import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Custom passes for the Vale of Emberglen image chain.
 *
 * Everything here is hand-written rather than pulled from three's addon set for two
 * reasons: the bloom needs a soft-knee threshold and a cheap dual-filter mip chain
 * (UnrealBloomPass is ~2.5x fullscreen fill and thresholds hard), and the grade needs
 * to own the tone curve so that the ACES output matches what the engine produces when
 * post is disabled. The ACES fit below is byte-identical to three's
 * ACESFilmicToneMapping chunk, so `quality.post === false` is a graceful downgrade,
 * not a different-looking game.
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const COMMON = /* glsl */`
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Minimal ShaderPass that drives a ShaderMaterial we already own. */
export class MaterialPass extends Pass {
  constructor(material) {
    super();
    this.material = material;
    this._quad = new FullScreenQuad(material);
  }
  render(renderer, writeBuffer, readBuffer) {
    if (this.material.uniforms.tDiffuse) this.material.uniforms.tDiffuse.value = readBuffer.texture;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); if (this.clear) renderer.clear(); }
    this._quad.render(renderer);
  }
  dispose() { this.material.dispose(); this._quad.dispose(); }
}

// ---------------------------------------------------------------------------
// Bloom: threshold -> 4 mip downsamples -> tent upsample accumulate
// ---------------------------------------------------------------------------

const PREFILTER_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;        // texel size of the SOURCE
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
${COMMON}

// Karis average: weight each tap by 1/(1+luma) so a single blazing pixel cannot
// dominate a whole bloom lobe. Kills the "fireflies" that make cheap bloom sparkle.
vec3 tap(vec2 uv) { return max(texture2D(tDiffuse, uv).rgb, 0.0); }

void main() {
  vec2 o = uTexel;
  vec3 a = tap(vUv + vec2(-o.x, -o.y));
  vec3 b = tap(vUv + vec2( o.x, -o.y));
  vec3 c = tap(vUv + vec2(-o.x,  o.y));
  vec3 d = tap(vUv + vec2( o.x,  o.y));
  float wa = 1.0 / (1.0 + luma(a));
  float wb = 1.0 / (1.0 + luma(b));
  float wc = 1.0 / (1.0 + luma(c));
  float wd = 1.0 / (1.0 + luma(d));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-4);

  // soft-knee threshold — a hard threshold makes bloom pop on and off as things
  // cross it, which reads as a bug. The knee gives a quadratic ramp instead.
  float br = max(col.r, max(col.g, col.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-5);
  gl_FragColor = vec4(col * contrib, 1.0);
}
`;

const DOWN_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 col = texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb
           + texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb
           + texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb
           + texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb;
  gl_FragColor = vec4(col * 0.25, 1.0);
}
`;

const UP_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;
// 3x3 tent — the classic dual-filter upsample. Smooth enough that four mips give a
// wide, continuous halo with no visible ringing or mip banding.
void main() {
  vec2 o = uTexel * uRadius;
  vec3 s = texture2D(tDiffuse, vUv + vec2(-o.x,  o.y)).rgb
         + texture2D(tDiffuse, vUv + vec2( 0.0,  o.y)).rgb * 2.0
         + texture2D(tDiffuse, vUv + vec2( o.x,  o.y)).rgb
         + texture2D(tDiffuse, vUv + vec2(-o.x,  0.0)).rgb * 2.0
         + texture2D(tDiffuse, vUv).rgb * 4.0
         + texture2D(tDiffuse, vUv + vec2( o.x,  0.0)).rgb * 2.0
         + texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb
         + texture2D(tDiffuse, vUv + vec2( 0.0, -o.y)).rgb * 2.0
         + texture2D(tDiffuse, vUv + vec2( o.x, -o.y)).rgb;
  gl_FragColor = vec4(s * (1.0 / 16.0), 1.0);
}
`;

export class BloomPass extends Pass {
  constructor(width, height, levels = 4) {
    super();
    this.needsSwap = false;     // we only produce a side texture; colour passes through
    this.levels = levels;
    this.threshold = 0.9;
    this.knee = 0.45;
    this.radius = 1.0;
    this._targets = [];

    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    this._opts = opts;

    this.prefilter = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.9 }, uKnee: { value: 0.45 } },
      vertexShader: VERT, fragmentShader: PREFILTER_FRAG, depthTest: false, depthWrite: false,
    });
    this.down = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT, fragmentShader: DOWN_FRAG, depthTest: false, depthWrite: false,
    });
    this.up = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 } },
      vertexShader: VERT, fragmentShader: UP_FRAG, depthTest: false, depthWrite: false,
      blending: THREE.AdditiveBlending, transparent: true,
    });
    this._quad = new FullScreenQuad(this.prefilter);
    this.setSize(width, height);
  }

  setSize(width, height) {
    for (const t of this._targets) t.dispose();
    this._targets = [];
    let w = Math.max(2, Math.floor(width / 2));
    let h = Math.max(2, Math.floor(height / 2));
    for (let i = 0; i < this.levels; i++) {
      const rt = new THREE.WebGLRenderTarget(w, h, this._opts);
      rt.texture.name = `bloom.mip${i}`;
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      this._targets.push(rt);
      w = Math.max(2, Math.floor(w / 2));
      h = Math.max(2, Math.floor(h / 2));
    }
    this._srcSize = new THREE.Vector2(width, height);
  }

  get texture() { return this._targets[0].texture; }

  render(renderer, writeBuffer, readBuffer) {
    const q = this._quad;
    const mips = this._targets;

    // full res -> mip0 with threshold
    this.prefilter.uniforms.tDiffuse.value = readBuffer.texture;
    this.prefilter.uniforms.uTexel.value.set(1 / this._srcSize.x, 1 / this._srcSize.y);
    this.prefilter.uniforms.uThreshold.value = this.threshold;
    this.prefilter.uniforms.uKnee.value = Math.max(1e-3, this.knee);
    q.material = this.prefilter;
    renderer.setRenderTarget(mips[0]);
    renderer.clear(true, false, false);
    q.render(renderer);

    // downsample chain
    q.material = this.down;
    for (let i = 1; i < mips.length; i++) {
      this.down.uniforms.tDiffuse.value = mips[i - 1].texture;
      this.down.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
      renderer.setRenderTarget(mips[i]);
      renderer.clear(true, false, false);
      q.render(renderer);
    }

    // upsample + accumulate (additive)
    q.material = this.up;
    this.up.uniforms.uRadius.value = this.radius;
    for (let i = mips.length - 1; i > 0; i--) {
      this.up.uniforms.tDiffuse.value = mips[i].texture;
      this.up.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
      renderer.setRenderTarget(mips[i - 1]);
      q.render(renderer);
    }
    renderer.setRenderTarget(null);
  }

  dispose() {
    for (const t of this._targets) t.dispose();
    this.prefilter.dispose(); this.down.dispose(); this.up.dispose();
    this._quad.dispose();
  }
}

// ---------------------------------------------------------------------------
// Atmosphere: aerial perspective + depth of field, in ONE depth-sampling pass.
//
// Reference #7: "distance is conveyed almost entirely by aerial perspective ...
// frames stack three clear depth planes: warm saturated foreground grass, mid-green
// mid-ground trees and rock, and far geometry lifted to a pale blue-white flat
// silhouette with its saturation crushed to near zero. Fog is not a grey curtain --
// it is hue-shifted toward the sky colour."
//
// Scene FogExp2 alone cannot do that: at the density that keeps the near field clean
// it has only reached 4% by 100 m, so our mid-ground stayed exactly as crisp and as
// saturated as the foreground and the frame read flat.
//
// Reference #11: a portrait background stays LEGIBLE and low-detail, so the circle of
// confusion is capped at a small fraction of frame height and the pass is a no-op on
// wide lenses.
//
// WHY THESE ARE ONE PASS: RenderPass draws into the composer's READ buffer and does
// not swap, so exactly one of the two ping-pong targets owns the depth attachment.
// A pass that samples that depth texture while rendering INTO the target it is
// attached to is a feedback loop, and WebGL is entitled to return garbage -- it did,
// turning the whole portrait frame into flat grey. With a single depth consumer the
// parity always works out: it reads the target that has depth and writes the one that
// does not.
//
// The sky dome does not write depth, so its pixels keep the cleared depth and read
// back as the far plane (4000 m). Rather than a depth == 1 test (which is within 1e-5
// of a 3000 m mountain at this near/far, and that margin is not something to bet the
// whole frame on across drivers) the haze fades back out as it approaches the far
// plane -- but only there.
//
// It used to fade out from 1.4 km and be GONE by 2.6 km, which meant the one thing
// reference #7 is actually about -- "far geometry lifted to a pale blue-white flat
// silhouette with its saturation crushed to near zero" -- was the one thing that never
// received any haze. Our mountain ring sits at roughly 1-3 km, i.e. entirely inside
// the hole. A blind critic put it as "no aerial perspective, the terrain collapses
// into a stack of flat cutouts", which is exactly what a depth cue that switches off
// precisely where depth needs cueing will produce. The fade now starts at 3.3 km,
// past everything solid in the world and short of the dome.
//
// ---- THREE PLANES ---------------------------------------------------------
// Two further defects were measured (edge 13.56 on creature_portrait, 10.74 on
// interaction_feed, against reference plates at 5.16-9.87) and described in prose by
// a blind critic as the second-biggest gap overall: "B is uniformly, mercilessly
// sharp from the grass blade at the camera to the peak on the horizon", against a
// reference with "a defocused over-shoulder foreground, a sharp mid-ground subject,
// and a hazed far treeline". Both had the same root cause -- we shipped all three
// mechanisms and ran every one of them below the threshold of visibility:
//
//  1. HAZE RAMP SHAPE. A smoothstep over [start, start+range] is a ramp that has
//     barely begun at the distance where aerial perspective actually reads. With the
//     old 60 m / 980 m / strength 0.38, a mid-ground hill at 500 m received a 16%
//     mix toward the sky -- invisible -- and a 2 km mountain received 38%, when the
//     reference washes its far cliffs out by 80-90%. That is precisely the critic's
//     "mid-ground hills are the SAME green as the grass at the player's feet".
//     Replaced with exponential extinction, 1 - exp(-d/range), which is what
//     atmospheric scattering physically is: it bites immediately past hazeStart and
//     asymptotes, so mid AND far both get their correct share from one curve.
//
//  2. FOREGROUND PLANE ONLY EXISTED ON PORTRAIT LENSES. DOF was gated on fov < 46,
//     so the four wide gameplay shots -- the ones the critic was describing -- had
//     no near plane at all. The near-field softening below is deliberately NOT part
//     of the thin-lens model: it is a fixed "closer than a couple of metres" ramp
//     that runs on every lens, because pw_10 and pw_11 both defocus their
//     over-shoulder foreground on a wide.
//
//  3. THE DISC WAS TOO SMALL TO SEE. 0.42% of frame height is 3 px at 720p, i.e.
//     under one pixel once the measurement downsamples. Reference #11 caps this --
//     the background must stay LEGIBLE -- but legible is not crisp, and 3 px was
//     paying full price for a pass that produced no visible plane separation.
//     Near and far now carry separate radii, because a lens defocuses its near field
//     harder than its far field and the two want independent control anyway.
// ---------------------------------------------------------------------------

const ATMOS_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uFarCoc;      // px: defocus disc BEHIND the focal plane
uniform float uNearCoc;     // px: defocus disc IN FRONT of it
uniform float uNearIn;      // m: nearer than this, the foreground plane is fully soft
uniform float uNearOut;     // m: beyond this, the foreground plane is fully sharp
uniform float uFarPlaneCoc; // px: wide-lens far plane; 0 leaves the far side to the lens
uniform float uFarIn;       // m: where the far plane starts giving up detail
uniform float uFarOut;      // m: where it has given up all of it
uniform float uStrength;    // lens aperture-ish; 0 disables the thin-lens term
uniform vec3 uFogColor;     // LINEAR, scene-referred: the sky's own horizon radiance
uniform float uHazeStart;
uniform float uHazeRange;
uniform float uHaze;
uniform float uHazeNear;      // asymptote of the SHORT-range scattering term
uniform float uHazeNearRange; // its e-folding distance, in tens of metres
uniform float uHazeDesat;
varying vec2 vUv;
${COMMON}

float viewDist(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  // perspective depth -> positive metres in front of the camera.
  // The denominator is always negative; clamping it away from zero from BELOW is
  // what keeps this finite (clamping from above silently pins every pixel to the
  // near plane and blurs the entire frame).
  float denom = min((uFar - uNear) * d - uFar, -1e-6);
  return -(uNear * uFar) / denom;
}

// Aerial perspective at a point whose view distance is already known. Every caller
// has just paid for that depth fetch, and doing it again inside here doubled the
// depth bandwidth of the whole blur loop for nothing.
vec3 hazeAt(vec3 c, float dist) {
  if (uHaze <= 0.001) return c;
  // Exponential extinction. uHazeRange is the e-folding distance, so a hill one range
  // unit past hazeStart is already 63% of the way to the asymptote.
  // (No backticks in here: this block lives inside a JS template literal.)
  //
  // TWO terms, because one cannot describe this world. A single exponential tuned to
  // leave a 400 m cliff only ~60% washed (which is what the plates show) has an
  // e-folding distance of several hundred metres, and is therefore worth ~0.5% at the
  // 30-60 m background of a portrait -- so creature_portrait sat behind a background
  // that received literally no aerial perspective and read as a flat green wall at the
  // same value as the grass at the subject's feet. pw_15's background trees are
  // visibly lighter and bluer than its foreground. The short-range term is a small
  // asymptote reached within tens of metres; the long-range term is the mountain ring.
  // Together they give a gradient that is present at every scale the game frames.
  float fade = 1.0 - smoothstep(3300.0, 3950.0, dist);
  float hFar = uHaze * (1.0 - exp(-max(dist - uHazeStart, 0.0) / max(uHazeRange, 1.0))) * fade;
  float hNear = uHazeNear * (1.0 - exp(-max(dist - 2.0, 0.0) / max(uHazeNearRange, 1.0))) * fade;

  // The CHROMA crush is driven by the far term ALONE, and that split matters. Running
  // it off the combined haze cost 0.05 of frame saturation on every wide daylight shot
  // -- straight through the floor of the reference band -- because the short-range term
  // reaches its asymptote inside the mid-ground, i.e. over most of the frame. But
  // reference #7 does not ask for a desaturated mid-ground; it asks for a mid-GREEN
  // one, with the crush to near-neutral reserved for the far silhouette. So the near
  // term lifts value and pulls hue toward the sky, and leaves the chroma alone.
  c = mix(c, vec3(luma(c)), uHazeDesat * hFar);
  return mix(c, uFogColor, min(hFar + hNear, 0.97));
}

vec3 hazed(vec2 uv, float dist) {
  return hazeAt(max(texture2D(tDiffuse, uv).rgb, 0.0), dist);
}

// Blur radius in pixels. Three planes come out of three terms:
//   thin lens   -> near field soft, focal plane sharp, far field soft (portrait lenses)
//   near ramp   -> "closer than uNearOut" soft on EVERY lens (over-shoulder foreground)
//   far ramp    -> "further than uFarIn" soft on WIDE lenses (the hazed far treeline)
//
// The far ramp is keyed to ABSOLUTE distance rather than to the autofocus, and that is
// deliberate. On the wide gameplay camera the centre of frame is the player's own back
// at 2.3 m, so a thin-lens model would focus there and defocus the creature at 8 m --
// i.e. it would soften the one thing that has to stay sharp. Anchoring the far plane to
// metres instead leaves the whole 2-30 m subject band untouched and only gives up the
// treeline, which is what reference #7 actually describes.
//
// The band between the two ramps is the one distance nothing touches. That gap IS the
// subject plane, and it is why this does not degenerate into "blur it".
float cocAt(float dist, float f) {
  float r = 0.0;
  if (uStrength > 0.0) {
    // The near side clamps lower than the far side on purpose. Foreground samples are
    // allowed to bleed forward, so a hard foreground blur pulls BRIGHT background in
    // behind the grass and lifts the lower half of the frame -- creature_portrait's
    // ground/sky ratio walked from 0.92 to 1.01 on nothing but a bigger near disc.
    // pw_15 keeps its own foreground grass close to sharp; the softness there is on
    // the background and the cropped ruin.
    float c = clamp((1.0 - f / max(dist, 1e-3)) * uStrength, -0.62, 1.0);
    r = c < 0.0 ? -c * uNearCoc : c * uFarCoc;
  }
  r = max(r, (1.0 - smoothstep(uNearIn, uNearOut, dist)) * uNearCoc);
  if (uFarPlaneCoc > 0.0) r = max(r, smoothstep(uFarIn, uFarOut, dist) * uFarPlaneCoc);
  return r;
}

void main() {
  float dist = viewDist(vUv);

  // Autofocus on the centre of frame, biased to the NEAREST of a small cross so a
  // gap between ears focuses on the creature and not on the hill behind it.
  float f = 1.0;
  if (uStrength > 0.0) {
    f = viewDist(vec2(0.5, 0.46));
    f = min(f, viewDist(vec2(0.47, 0.46)));
    f = min(f, viewDist(vec2(0.53, 0.46)));
    f = min(f, viewDist(vec2(0.5, 0.52)));
    f = min(f, viewDist(vec2(0.5, 0.40)));
  }

  float r = cocAt(dist, f);
  if (r < 0.75) { gl_FragColor = vec4(hazed(vUv, dist), 1.0); return; }

  // 20-tap golden-angle spiral. Neighbours nearer than the focal plane are allowed
  // to bleed forward; sharp foreground pixels are rejected so the creature keeps a
  // clean edge instead of smearing into its own background.
  vec3 sum = hazed(vUv, dist);
  float wsum = 1.0;
  const int N = 20;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float ang = fi * 2.39996323;
    float rad = sqrt((fi + 0.5) / float(N)) * r;
    vec2 off = vec2(cos(ang), sin(ang)) * rad * uTexel;
    vec2 suv = vUv + off;
    float sd = viewDist(suv);
    float w = clamp((cocAt(sd, f) - rad + 1.0) * 0.6, 0.0, 1.0);
    sum += hazed(suv, sd) * w;
    wsum += w;
  }
  gl_FragColor = vec4(sum / wsum, 1.0);
}
`;

export class AtmospherePass extends Pass {
  constructor(camera, width, height) {
    super();
    this.camera = camera;
    // Explicit depth handle. RenderPass writes into the composer's READ buffer and
    // does not swap, so `readBuffer.depthTexture` is only the live depth for the pass
    // sitting directly after it.
    this.depthTexture = null;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
        uNear: { value: 0.1 }, uFar: { value: 4000 },
        uFarCoc: { value: 6 }, uNearCoc: { value: 6 },
        uNearIn: { value: 0.35 }, uNearOut: { value: 3.0 },
        uFarPlaneCoc: { value: 0 }, uFarIn: { value: 30 }, uFarOut: { value: 160 },
        uStrength: { value: 0.0 },
        uFogColor: { value: new THREE.Color(0.55, 0.66, 0.80) },
        uHazeStart: { value: 40 }, uHazeRange: { value: 520 },
        uHaze: { value: 0.45 }, uHazeDesat: { value: 0.75 },
        uHazeNear: { value: 0.0 }, uHazeNearRange: { value: 60 },
      },
      vertexShader: VERT, fragmentShader: ATMOS_FRAG, depthTest: false, depthWrite: false,
    });
    this._quad = new FullScreenQuad(this.material);
  }

  setSize(width, height) {
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
    // Keep the blur discs a constant fraction of frame height across resolutions.
    // Reference #11: the background behind a portrait subject stays LEGIBLE and
    // low-detail -- in pw_15 you can still count the trees and read the moss on the
    // ruin. 1.25% of frame height turned it to mush; 0.42% was invisible (3 px at
    // 720p, i.e. under one pixel by the time anything measures it) and left the
    // frame reading as uniformly sharp. 0.9% far / 1.15% near is the band where the
    // planes separate by eye and the background is still countable.
    this.material.uniforms.uFarCoc.value = Math.max(2, height * 0.0120);
    this.material.uniforms.uNearCoc.value = Math.max(2, height * 0.0130);
    this._widePlaneCoc = Math.max(1.5, height * 0.0060);
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.material.uniforms;
    const depth = this.depthTexture ?? readBuffer.depthTexture;
    if (!depth) { return; }   // no depth attachment: skip rather than break
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = depth;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    if (this.renderToScreen) renderer.setRenderTarget(null);
    else { renderer.setRenderTarget(writeBuffer); if (this.clear) renderer.clear(); }
    this._quad.render(renderer);
  }

  dispose() { this.material.dispose(); this._quad.dispose(); }
}

// ---------------------------------------------------------------------------
// Grade: bloom composite -> exposure/WB -> ACES -> CDL -> split tone ->
//        chroma-dependent saturation -> green steer -> print-white knee -> sRGB
// ---------------------------------------------------------------------------

const GRADE_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform sampler2D tBloom;
uniform float uExposure;
uniform vec3 uWhiteBalance;
uniform float uBloomStrength;
uniform vec3 uBloomTint;
uniform float uContrast;
uniform float uPivot;
uniform vec3 uSlope;
uniform vec3 uOffset;
uniform vec3 uPower;
uniform vec3 uShadowTint;
uniform vec3 uHighTint;
uniform float uSatLow;
uniform float uSatHigh;
uniform float uGreenShift;
uniform float uGreenSat;
uniform float uWhite;
uniform float uKneeStart;
varying vec2 vUv;
${COMMON}

// three.js ACESFilmicToneMapping, verbatim, so that disabling post changes the
// amount of polish and not the exposure of the whole game.
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 ACESFilmic(vec3 color) {
  const mat3 ACESInputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= 1.0 / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}

void main() {
  vec3 col = max(texture2D(tDiffuse, vUv).rgb, 0.0);
  vec3 bloom = max(texture2D(tBloom, vUv).rgb, 0.0);

  // bloom is added in scene-referred linear so the tone curve rolls it off like
  // real light rather than pasting a milky layer over the frame
  col += bloom * uBloomStrength * uBloomTint;

  col *= uExposure * uWhiteBalance;
  col = ACESFilmic(col);

  // contrast around a mid pivot (display-referred)
  col = max(mix(vec3(uPivot), col, uContrast), 0.0);

  // ASC-CDL: slope / offset / power. The offset is what keeps shadows off zero —
  // reference #9: shadows are a cooler version of the lit colour, never black.
  col = pow(max(col * uSlope + uOffset, 0.0), uPower);

  // split tone: cool the shadows, warm the highlights
  float l = luma(col);
  col *= mix(uShadowTint, uHighTint, smoothstep(0.12, 0.72, l));

  // Reference #5: creatures are saturated, the world is not.
  //
  // Measured off the reference plates: environment neutrals sit at chroma 0.05-0.20
  // (pw_11 rock 170/173/164, pw_15 stone 113/103/94) while creatures sit at 0.37-0.91
  // (pw_15 fox 194/123/126, pw_11 blue Pal 17/154/194). So saturation gain is driven
  // by the pixel's own chroma: scenery is pulled DOWN, the one or two genuinely
  // saturated hero hues in frame are pushed slightly UP, and the separation survives
  // even when creature and background share a luminance.
  float mx = max(col.r, max(col.g, col.b));
  float mn = min(col.r, min(col.g, col.b));
  float chroma = (mx - mn) / max(mx, 1e-4);

  // GREEN-DOMINANT mask: only pixels where green genuinely beats both neighbours.
  // This one drives the green -> yellow steer below and nothing else, because
  // pushing an already-yellow pixel further toward yellow is how a meadow ends up
  // chartreuse.
  float greenMask = smoothstep(0.03, 0.30, (col.g - max(col.r, col.b)) / max(col.g, 1e-4));

  // FOLIAGE mask: the whole yellow-green .. blue-green band, i.e. "the world".
  //
  // The measured ~25% oversaturation on the wide daylight shots lived here. The
  // green-dominant mask above misses the single most saturated thing in every one of
  // those frames: SUNLIT GRASS TIPS ARE YELLOW-GREEN, red within a few percent of
  // green, so (g - max(r,b)) is ~0 and they scored zero on it -- which meant the
  // grass was being fed through the hero-hue boost (uSatHigh, 1.22-1.24) that
  // reference #5 intends for creatures, while only the shadowed true-green grass got
  // the trim. The brightest, largest-area thing in frame was the one thing being
  // pushed up.
  //
  // Two independent tests give the band both of its edges:
  //   g clearly above b  -> yellow through green through blue-green
  //   g not far below r  -> excludes orange / red / pink, i.e. every creature hero hue
  //
  // Why this does not trade away the hue discipline a critic praised: mixing toward
  // luma scales the chroma vector about the grey axis, which leaves the hue ANGLE
  // exactly where it was. The yellow-green -> blue-green relationships survive
  // untouched; only the magnitude moves. A flat global desaturate would have taken
  // the creatures down with the meadow and killed the saturation-contrast separation
  // that reference #5 says is the entire mechanism.
  float gb = (col.g - col.b) / max(mx, 1e-4);
  float gr = (col.g - col.r) / max(mx, 1e-4);
  float foliage = smoothstep(0.06, 0.26, gb) * smoothstep(-0.20, 0.02, gr);

  float sat = mix(uSatLow, uSatHigh, smoothstep(0.20, 0.62, chroma));
  sat *= mix(1.0, uGreenSat, foliage);
  float g0 = luma(col);
  col = mix(vec3(g0), col, sat);

  // Reference #5 again: grass must be a mid-value, moderately desaturated
  // YELLOW-green. Push green-dominant pixels toward yellow by lifting red.
  col.r += greenMask * uGreenShift * col.g;

  // ---- print white ----
  // A graded frame does not reach paper white. Every daylight reference plate
  // measures 0.00-0.04% of pixels above 250 luma; ours was blowing 4.5% of
  // vista_golden into a flat white hole around the sun, because the sky dome's
  // radiance near the disc is ~10x over the ACES shoulder and clamps hard.
  // A hyperbolic knee above uKneeStart asymptotes to uWhite instead of clipping,
  // so the sun keeps a falloff, and -- the reason this is worth doing rather than
  // just pulling exposure -- it lets the mid-tone lift the low-sun shots need be
  // pushed much harder without the sky going to paper.
  {
    float mx = max(col.r, max(col.g, col.b));
    if (mx > uKneeStart) {
      float head = max(uWhite - uKneeStart, 1e-4);
      float k = uKneeStart + (mx - uKneeStart) / (1.0 + (mx - uKneeStart) / head);
      col *= k / max(mx, 1e-4);
    }
  }

  gl_FragColor = vec4(linearToSRGB(clamp(col, 0.0, 1.0)), 1.0);
}
`;

export function makeGradeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null }, tBloom: { value: null },
      uExposure: { value: 1 }, uWhiteBalance: { value: new THREE.Vector3(1, 1, 1) },
      uBloomStrength: { value: 0.3 }, uBloomTint: { value: new THREE.Vector3(1, 1, 1) },
      uContrast: { value: 1 }, uPivot: { value: 0.42 },
      uSlope: { value: new THREE.Vector3(1, 1, 1) },
      uOffset: { value: new THREE.Vector3(0, 0, 0) },
      uPower: { value: new THREE.Vector3(1, 1, 1) },
      uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
      uHighTint: { value: new THREE.Vector3(1, 1, 1) },
      uSatLow: { value: 0.9 }, uSatHigh: { value: 1.08 },
      uGreenShift: { value: 0.07 }, uGreenSat: { value: 0.93 },
      uWhite: { value: 0.95 }, uKneeStart: { value: 0.80 },
    },
    vertexShader: VERT, fragmentShader: GRADE_FRAG, depthTest: false, depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Finish: chromatic aberration + vignette + grain, all in display space
// ---------------------------------------------------------------------------

const FINISH_FRAG = /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uAberration;   // pixels of R/B split at the frame corner
uniform float uVignette;     // 0..1 darkening at the corner
uniform float uVigStart;     // radius where it begins
uniform float uGrain;
uniform float uSeed;
varying vec2 vUv;
${COMMON}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c) * 4.0;                 // 1.0 at the mid-edge, ~2 at the corner

  // Lateral chromatic aberration: zero in the middle third, quartic ramp to the very
  // edge. Real lenses do this and it is one of the cheapest "photographed, not
  // rendered" cues — but at more than ~1.5px it starts to read as a broken TV.
  vec3 col;
  float ca = uAberration * r2 * r2 / max(uResolution.x, 1.0);
  if (ca > 0.00002) {
    vec2 dir = normalize(c + 1e-6);
    col.r = texture2D(tDiffuse, vUv + dir * ca).r;
    col.g = texture2D(tDiffuse, vUv).g;
    col.b = texture2D(tDiffuse, vUv - dir * ca).b;
  } else {
    col = texture2D(tDiffuse, vUv).rgb;
  }

  // vignette — a slow cosine falloff, not a black donut
  float d = length(c * vec2(1.0, 0.92));
  float v = 1.0 - uVignette * smoothstep(uVigStart, 0.78, d);
  col *= v;

  // film grain, luminance-weighted so it lives in the mids and shadows and never
  // speckles the sky. If you can see it as texture, it is too strong.
  float n = hash21(vUv * uResolution + uSeed) - 0.5;
  float lw = 1.0 - smoothstep(0.35, 1.0, luma(col));
  col += n * uGrain * (0.35 + 0.65 * lw);

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export function makeFinishMaterial(width, height) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: new THREE.Vector2(width, height) },
      uAberration: { value: 0.9 }, uVignette: { value: 0.24 }, uVigStart: { value: 0.42 },
      uGrain: { value: 0.01 }, uSeed: { value: 0 },
    },
    vertexShader: VERT, fragmentShader: FINISH_FRAG, depthTest: false, depthWrite: false,
  });
}
