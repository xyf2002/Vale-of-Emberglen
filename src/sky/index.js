import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';

/**
 * SKY & ATMOSPHERE SYSTEM — owned by the sky builder. Owns the single biggest lever on
 * whether a frame reads as "a beautiful world": sun/moon, sky gradient, clouds, fog,
 * light colour and intensity, day-night, weather.
 *
 * PUBLIC CONTRACT:
 *   timeOfDay            0..1 (0 midnight, 0.25 dawn, 0.5 noon, 0.72 golden, 0.85 dusk)
 *   setTimeOfDay(t)
 *   getSunDirection() -> THREE.Vector3 (unit, points FROM ground TOWARD sun)
 *   getSunColor() -> THREE.Color
 *   setWeather(name, amount0to1)   'clear' | 'cloudy' | 'rain' | 'fog'
 *   sunLight -> THREE.DirectionalLight   (others may read for shadow config)
 *
 * ADDITIONS (safe to use, additive only):
 *   getKeyDirection()   -> unit vector the shadow-casting key light comes from
 *                          (== sun by day, moon/twilight-clamped at night)
 *   getSkyColor()       -> zenith colour, linear
 *   getHorizonColor()   -> horizon colour, linear (== fog colour)
 *   getFogColor()       -> THREE.Color, linear
 *   getAmbientColor()   -> sky ambient tint, linear
 *   sunElevationDeg     -> number
 *   isNight             -> boolean
 *
 * IMPLEMENTATION NOTES
 * --------------------
 * The sky is a Preetham analytic single-scattering model evaluated per pixel on a
 * camera-locked dome, plus a hand-authored night sky (deep blue gradient, stars, moon)
 * that the scattering cross-fades into through twilight. The *same* model is mirrored in
 * JS (skyRadianceJS) so that:
 *   - scene.fog colour is literally the sky colour at the horizon => distant terrain
 *     dissolves into the sky instead of into a grey curtain (aerial perspective),
 *   - the sun light colour is the atmospheric transmittance along the sun ray, so it
 *     reddens at low sun for free,
 *   - the ambient/hemisphere colour is the actual zenith radiance.
 * Everything the shader emits is *linear radiance*; ACES tone mapping is applied by the
 * standard three chunks exactly as it is for every other material in the scene, so the
 * fog colour and the sky pixel land on the same value after grading.
 */

// ---------------------------------------------------------------------------
// Preetham constants (shared by GLSL and JS mirrors — keep them in sync!)
// ---------------------------------------------------------------------------
const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF_ANGLE = 1.6110731556870734;
const STEEPNESS = 1.5;
const EE = 1000.0;
const RAYLEIGH_ZENITH = 8.4e3;
const MIE_ZENITH = 1.25e3;

const SKY_GLSL_COMMON = /* glsl */`
const vec3 UPV = vec3(0.0, 1.0, 0.0);
const float PI_ = 3.141592653589793;
const vec3 TOTAL_RAYLEIGH = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 MIE_CONST = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float CUTOFF_ANGLE = 1.6110731556870734;
const float STEEPNESS = 1.5;
const float EE = 1000.0;
const float RAYLEIGH_ZENITH = 8.4E3;
const float MIE_ZENITH = 1.25E3;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - exp(-((CUTOFF_ANGLE - acos(zenithAngleCos)) / STEEPNESS)));
}
vec3 totalMie(float T) {
  float c = (0.2 * T) * 10E-18;
  return 0.434 * c * MIE_CONST;
}
float rayleighPhase(float cosTheta) { return THREE_OVER_SIXTEENPI * (1.0 + cosTheta * cosTheta); }
float hgPhase(float cosTheta, float g) {
  float g2 = g * g;
  float inv = 1.0 / pow(max(0.0, 1.0 - 2.0 * g * cosTheta + g2), 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inv);
}
`;

// ---------------------------------------------------------------------------

const VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */`
precision highp float;
varying vec3 vWorld;

uniform vec3  uSunDir;        // true sun direction (may be below horizon)
uniform vec3  uSunSkyDir;     // sun direction clamped just below the horizon, for scattering
uniform vec3  uMoonDir;
uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieG;
uniform float uSunFade;
uniform float uScatterScale;  // 1 by day -> 0 at night
uniform float uNightAmt;      // 0 by day -> 1 at night
uniform float uSkyGain;
uniform float uHorizonWash;
uniform vec3  uNightZenith;
uniform vec3  uNightHorizon;
uniform float uStarAmt;
uniform float uMoonAmt;
uniform float uTime;
uniform float uCloudCov;      // 0 = none, 1 = overcast
uniform float uCloudSharp;
uniform float uCloudAlt;
uniform float uCloudGain;
uniform float uCirrusAmt;
uniform float uWindAngle;
uniform float uHaze;          // extra low-altitude milkiness

${SKY_GLSL_COMMON}

// ---- procedural noise -----------------------------------------------------
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm4(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; p += 11.7; a *= 0.5; }
  return s * 1.0666;
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.11; p += 7.3; a *= 0.5; }
  return s * 1.1428;
}
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// ---- the atmosphere -------------------------------------------------------
vec3 scatter(vec3 dir, vec3 sunDir) {
  float rayleighCoefficient = uRayleigh;
  vec3 betaR = TOTAL_RAYLEIGH * rayleighCoefficient;
  vec3 betaM = totalMie(uTurbidity) * uMieCoefficient;
  float sunE = sunIntensity(dot(sunDir, UPV));

  float zenithAngle = acos(max(0.0, dot(UPV, dir)));
  float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(max(1e-4, 93.885 - ((zenithAngle * 180.0) / PI_)), -1.253));
  float sR = RAYLEIGH_ZENITH * inv;
  float sM = MIE_ZENITH * inv;
  vec3 Fex = exp(-(betaR * sR + betaM * sM));

  float cosTheta = dot(dir, sunDir);
  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = betaR * rPhase;
  float mPhase = hgPhase(cosTheta, uMieG);
  vec3 betaMTheta = betaM * mPhase;

  vec3 ratio = (betaRTheta + betaMTheta) / (betaR + betaM);
  vec3 Lin = pow(sunE * ratio * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(sunE * ratio * Fex, vec3(0.5)),
             clamp(pow(1.0 - dot(UPV, sunDir), 5.0), 0.0, 1.0));

  vec3 L0 = vec3(0.1) * Fex;
  // sun disc + tight corona (kept generous so bloom has something to grab)
  float disc = smoothstep(0.99986, 0.99997, cosTheta);
  L0 += sunE * 17000.0 * Fex * disc;
  float corona = pow(max(0.0, cosTheta), 900.0);
  L0 += sunE * 260.0 * Fex * corona;

  vec3 tex = (Lin + L0) * 0.04 + vec3(0.0, 0.0003, 0.00075);
  return pow(max(tex, vec3(0.0)), vec3(1.0 / (1.2 + 1.2 * uSunFade)));
}

vec3 nightSky(vec3 dir) {
  float h = clamp(dir.y, 0.0, 1.0);
  vec3 base = mix(uNightHorizon, uNightZenith, pow(h, 0.55));
  // ------------------------------------------------------------------------
  // THE RECTANGULAR STAR PATCH.
  //
  // A critic called this "a hard-clipped rectangular patch that exposes the sky as a
  // plane with a texture on it", and the shape of the bug is visible in the numbers:
  // the field faded in over dir.y 0.10 -- a band SIX DEGREES tall -- so on a
  // near-level dusk camera the stars went from absent to full density across about
  // forty pixels, and the mountains cut the bottom off that band into a straight
  // edge. Every star was also the same angular size, which reads as a printed
  // texture rather than as depth.
  //
  // The ramp now spans 40 degrees (dir.y 0.02 -> 0.62), so density genuinely
  // increases with altitude the way a real sky does and there is no edge to find.
  // Magnitude drives SIZE as well as brightness, and a second sparser layer of
  // bright stars sits on top, so the field has a population rather than a density.
  // ------------------------------------------------------------------------
  if (uStarAmt > 0.001 && dir.y > -0.02) {
    float alt = smoothstep(0.02, 0.62, dir.y);
    for (int L = 0; L < 2; L++) {
      float scale = L == 0 ? 260.0 : 128.0;
      float cut = L == 0 ? 0.9705 : 0.9942;
      vec3 sp = dir * scale;
      vec3 cell = floor(sp);
      float r = hash31(cell + float(L) * 17.0);
      if (r > cut) {
        vec3 c = (cell + 0.5 + (vec3(hash31(cell + 3.1), hash31(cell + 7.7), hash31(cell + 12.3)) - 0.5) * 0.7) / scale;
        float d = length(normalize(c) - dir);
        float mag = hash31(cell + 21.0);
        // bright stars are physically bigger on screen; a uniform radius is the
        // single loudest tell that a starfield is a noise function
        float rad = (L == 0 ? 0.0019 : 0.0034) * (0.55 + mag * 1.5);
        float tw = 0.72 + 0.28 * sin(uTime * (1.4 + mag * 3.0) + mag * 40.0);
        float s = smoothstep(rad, 0.0, d) * (0.20 + mag * mag * (L == 0 ? 1.7 : 3.4)) * tw;
        vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.91, 0.78), hash31(cell + 5.5));
        base += tint * s * uStarAmt * (L == 0 ? alt : mix(0.35, 1.0, alt));
      }
    }
    // a faint band of unresolved stars, so the sky between the points is not empty
    float bandT = abs(dot(dir, normalize(vec3(0.42, 0.62, -0.66))));
    float band = pow(1.0 - clamp(bandT, 0.0, 1.0), 7.0);
    band *= 0.55 + 0.45 * fbm3(dir.xz * 5.5 + dir.y * 3.0);
    base += vec3(0.028, 0.030, 0.042) * band * uStarAmt * alt;
  }
  // moon
  float md = dot(dir, uMoonDir);
  float mdisc = smoothstep(0.99955, 0.99985, md);
  float mglow = pow(max(0.0, md), 220.0) * 0.55 + pow(max(0.0, md), 14.0) * 0.06;
  base += (vec3(1.15, 1.13, 1.02) * mdisc * 2.4 + vec3(0.42, 0.50, 0.68) * mglow) * uMoonAmt;
  return base;
}

// ---- high cirrus / veil ---------------------------------------------------
vec4 cloudLayer(vec3 dir, vec3 sunDir, vec3 sunTint, vec3 ambTint) {
  float y = dir.y;
  if (y < 0.004) return vec4(0.0);
  float fade = smoothstep(0.004, 0.135, y);
  vec2 base = dir.xz / max(y, 0.004) * uCloudAlt;

  // --- layer A : broad thin veil ---
  vec2 pa = base * 0.00021;
  pa = rot2(pa, uWindAngle);
  pa += vec2(uTime * 0.0042, uTime * 0.0013);
  float va = fbm4(pa * 0.75);
  float veil = smoothstep(0.50 - uCloudCov * 0.42, 0.94 - uCloudCov * 0.44, va);

  // --- layer B : stretched cirrus streaks ---
  vec2 pb = rot2(base * 0.00040, uWindAngle);
  pb.y *= 0.17;                       // squash across-wind -> long streaks
  pb += vec2(uTime * 0.010, 0.0);
  float warp = fbm3(pb * 0.5) * 0.9;
  float nb = fbm4(pb * 1.15 + vec2(warp, warp * 0.25));
  float fine = fbm3(vec2(pb.x * 4.2, pb.y * 1.1));
  float cb = nb * 0.78 + fine * 0.22;
  float streak = smoothstep(0.56 - uCloudCov * 0.34, 0.86 - uCloudCov * 0.30, cb);
  streak = pow(streak, uCloudSharp);

  float dens = clamp(veil * 0.42 + streak * uCirrusAmt, 0.0, 1.0) * fade;
  if (dens <= 0.002) return vec4(0.0);

  // shading: thin high cloud is basically forward-scattering white
  float sp = max(0.0, dot(dir, sunDir));
  float glow = pow(sp, 22.0);
  vec3 lit = mix(ambTint * 1.5, sunTint, 0.55 + 0.45 * glow);
  vec3 col = lit * (0.86 + 0.55 * glow) * uCloudGain;
  // slight self-occlusion so it isn't a flat decal
  col *= mix(1.0, 0.80, smoothstep(0.35, 1.0, dens));

  float alpha = dens * (0.55 + 0.45 * smoothstep(0.0, 0.6, dens));
  return vec4(col, clamp(alpha, 0.0, 1.0));
}

void main() {
  vec3 dir = normalize(vWorld - cameraPosition);

  vec3 day = scatter(dir, uSunSkyDir) * uScatterScale;
  vec3 night = nightSky(dir) * uNightAmt;
  vec3 col = day + night;

  // --- horizon wash-out: the thing that actually sells scale -------------
  float hz = pow(1.0 - clamp(abs(dir.y), 0.0, 1.0), 5.0);
  float below = smoothstep(0.02, -0.16, dir.y);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 wash = mix(col, vec3(lum) * vec3(1.02, 1.03, 1.06), 0.62);
  col = mix(col, wash, clamp(hz * uHorizonWash, 0.0, 1.0));
  col *= mix(1.0, 1.0 + uHaze * 0.55, hz);
  // ground-side of the dome tucks under the fog colour so there is never a seam
  col = mix(col, col * 0.86, below * 0.5);

  // -- slight chroma lift so the day sky reads blue (reference skies sit at
  // chroma ~0.22; the Rayleigh wash alone lands ~0.15) ---------------------
  col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, 1.22);

  // --- clouds ------------------------------------------------------------
  vec3 sunTint = scatter(normalize(uSunSkyDir + UPV * 0.02), uSunSkyDir) * uScatterScale * 1.15
               + vec3(0.05, 0.055, 0.07) * uNightAmt;
  vec3 ambTint = scatter(UPV, uSunSkyDir) * uScatterScale + uNightZenith * uNightAmt * 3.0;
  vec4 cl = cloudLayer(dir, uSunSkyDir, sunTint, ambTint);
  col = mix(col, cl.rgb, cl.a);

  col *= uSkyGain;

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// JS mirror of the analytic model (no clouds/stars — used for fog + light colour)
// ---------------------------------------------------------------------------
function sunIntensityJS(cz) {
  cz = Math.min(1, Math.max(-1, cz));
  return EE * Math.max(0, 1 - Math.exp(-((CUTOFF_ANGLE - Math.acos(cz)) / STEEPNESS)));
}

const _tmpA = [0, 0, 0];
function scatterJS(dx, dy, dz, sx, sy, sz, p, out) {
  const betaR = [
    TOTAL_RAYLEIGH[0] * p.rayleigh, TOTAL_RAYLEIGH[1] * p.rayleigh, TOTAL_RAYLEIGH[2] * p.rayleigh,
  ];
  const c = 0.2 * p.turbidity * 10e-18 * 0.434 * p.mieCoefficient;
  const betaM = [MIE_CONST[0] * c, MIE_CONST[1] * c, MIE_CONST[2] * c];
  const sunE = sunIntensityJS(sy);

  const zenithAngle = Math.acos(Math.max(0, dy));
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(Math.max(1e-4, 93.885 - (zenithAngle * 180) / Math.PI), -1.253));
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;

  const cosTheta = dx * sx + dy * sy + dz * sz;
  const ct = cosTheta * 0.5 + 0.5;
  const rPhase = 0.05968310365946075 * (1 + ct * ct);
  const g2 = p.mieG * p.mieG;
  const mPhase = 0.07957747154594767 * ((1 - g2) / Math.pow(Math.max(0, 1 - 2 * p.mieG * cosTheta + g2), 1.5));

  const upDotSun = Math.max(-1, Math.min(1, sy));
  const mixT = Math.min(1, Math.max(0, Math.pow(1 - upDotSun, 5)));
  const exponent = 1 / (1.2 + 1.2 * p.sunFade);

  for (let i = 0; i < 3; i++) {
    const Fex = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
    const ratio = (betaR[i] * rPhase + betaM[i] * mPhase) / (betaR[i] + betaM[i]);
    let Lin = Math.pow(Math.max(0, sunE * ratio * (1 - Fex)), 1.5);
    const t2 = Math.pow(Math.max(0, sunE * ratio * Fex), 0.5);
    Lin *= 1 + (t2 - 1) * mixT;
    const L0 = 0.1 * Fex;
    const add = i === 0 ? 0 : i === 1 ? 0.0003 : 0.00075;
    const tex = (Lin + L0) * 0.04 + add;
    out[i] = Math.pow(Math.max(0, tex), exponent);
  }
  return out;
}

/** transmittance along the sun ray — gives the sun its colour for free */
function sunTransmittanceJS(sy, p, out) {
  const betaR = [
    TOTAL_RAYLEIGH[0] * p.rayleigh, TOTAL_RAYLEIGH[1] * p.rayleigh, TOTAL_RAYLEIGH[2] * p.rayleigh,
  ];
  const c = 0.2 * p.turbidity * 10e-18 * 0.434 * p.mieCoefficient;
  const betaM = [MIE_CONST[0] * c, MIE_CONST[1] * c, MIE_CONST[2] * c];
  const y = Math.max(sy, 0.008);
  const zenithAngle = Math.acos(Math.min(1, y));
  const inv = 1 / (Math.cos(zenithAngle) + 0.15 * Math.pow(Math.max(1e-4, 93.885 - (zenithAngle * 180) / Math.PI), -1.253));
  const sR = RAYLEIGH_ZENITH * inv;
  const sM = MIE_ZENITH * inv;
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(betaR[i] * sR + betaM[i] * sM));
  return out;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------
// Weather presets
// ---------------------------------------------------------------------------
const WEATHER = {
  clear:  { cloudCov: 0.10, cirrus: 0.85, turbidity: 2.6, haze: 0.10, fogMul: 1.00, sunMul: 1.00, ambMul: 1.00, sat: 1.00 },
  cloudy: { cloudCov: 0.62, cirrus: 0.95, turbidity: 5.0, haze: 0.45, fogMul: 1.55, sunMul: 0.55, ambMul: 1.25, sat: 0.88 },
  rain:   { cloudCov: 0.90, cirrus: 0.60, turbidity: 8.0, haze: 0.75, fogMul: 2.60, sunMul: 0.22, ambMul: 1.10, sat: 0.72 },
  fog:    { cloudCov: 0.40, cirrus: 0.55, turbidity: 6.5, haze: 1.00, fogMul: 4.20, sunMul: 0.42, ambMul: 1.30, sat: 0.78 },
};

/**
 * Sun elevation curve.
 *
 * The stub used elev = sin(2pi(t-0.25)), whose zero crossings sit at exactly 0.25 and
 * 0.75 — which is why the documented "golden hour" (0.72) was already nearly overhead
 * and "dusk" (0.85) was 38 degrees below the horizon with the world pitch black.
 *
 * Here the daylight arc is widened to t in [0.205, 0.805].
 *
 * THE ARC WAS TOO TALL AND TOO POINTED. Two numbers set its shape: the noon peak and
 * the exponent that decides how fast it falls away from noon. At 63 deg / ^1.6 the
 * documented times landed at 0.29 -> 16, 0.34 -> 33, 0.45 -> 49, 0.60 -> 51, 0.63 -> 44.
 * Four of the five daylight shots were therefore lit from 33-51 degrees, and a key that
 * steep is the worst possible angle for readable form: a 12 m tree at 51 deg throws a
 * 10 m shadow that its own canopy hides, so a hillside covered in trees renders as one
 * smooth unbroken green. It is also why cast shadow contributed nothing measurable to
 * the image even after the shadow map itself was fixed -- the shadows existed, they
 * were just tucked underneath the things casting them.
 *
 * 48 deg / ^1.0 keeps the same silhouette but flattens the top and lifts the shoulders:
 *   0.29 -> 23, 0.34 -> 31, 0.45 -> 46, 0.50 -> 48 (noon), 0.60 -> 42, 0.63 -> 38,
 *   0.72 -> 21 (golden hour, the 18-25 deg band the critique asked for),
 *   0.80 -> sunset, 0.86 -> ~-7 (civil twilight / blue hour), 0.0 -> -38 (true night).
 *
 * The lifted morning shoulder is load-bearing, not cosmetic. With the terrain casting
 * shadow (see world/index.js) the over-shoulder shot's meadow sits behind a 138 m ridge
 * 388 m up-sun, which subtends 18.4 degrees: at the old 16 deg morning key the ENTIRE
 * valley floor was inside that ridge's shadow and no tree could rake anything across
 * it. 23 degrees clears the ridge by a comfortable margin and hands the meadow its key
 * back. Noon loses 15% of its illumination on flat ground, low morning gains 22%, which
 * pulls the daylight ground/sky ratios toward the middle of the reference band instead
 * of out of either end of it.
 */
const RISE_T = 0.205;
const SET_T = 0.805;
const DAY_HALF = (SET_T - RISE_T) * 0.5;      // 0.30
const DAY_MID = (SET_T + RISE_T) * 0.5;       // 0.505
const NIGHT_HALF = 0.5 - DAY_HALF;            // 0.20
const MAX_ELEV = 48 * Math.PI / 180;
const MIN_ELEV = -38 * Math.PI / 180;
const DAY_SHAPE = 0.9;

/**
 * How far back the key light is parked from the shadow focus point. It has to clear
 * the deepest the ground can get in light space: for an ortho half-size S at sun
 * elevation e the ground spans +/- S/tan(e) metres of depth, which at S = 150 and the
 * 16 deg morning key is +/- 520 m. 620 keeps the whole box in front of the near plane.
 */
const KEY_DIST = 620;

function sunElevation(t) {
  let u = t - DAY_MID;
  if (u > 0.5) u -= 1; else if (u < -0.5) u += 1;
  const a = Math.abs(u);
  if (a <= DAY_HALF) {
    const k = Math.cos((Math.PI * 0.5) * (a / DAY_HALF));
    return MAX_ELEV * Math.pow(Math.max(0, k), DAY_SHAPE);
  }
  const v = Math.min(1, (a - DAY_HALF) / NIGHT_HALF);
  const k = Math.sin((Math.PI * 0.5) * v);
  return MIN_ELEV * (k * k);
}

/**
 * Azimuth sweep, rotated so the key is not sitting on the camera's shoulder.
 *
 * MEASURED, per shot, as the angle between the camera's forward vector and the
 * direction to the sun (180 = sun exactly behind the lens, 90 = side light):
 *
 *      vista_golden 172.9    creature_group 179.1    interaction_feed 172.7
 *
 * Three of the five daylight shots were lit from within eight degrees of dead behind
 * the camera. That is the single most complete explanation of "nothing casts a shadow
 * onto anything else": every shadow in those frames falls directly AWAY from the
 * lens, which puts it exactly behind the thing casting it, where that thing hides it.
 * It is also why bushes and creatures looked like they were hovering — a contact
 * shadow thrown straight away from the camera is not a contact shadow you can see.
 *
 * The world is composed around one axis (terrain.js) and every wide shot looks along
 * it, so this was not bad luck, it was structural: the sun's arc and the composition
 * axis were nearly parallel. Rotating the whole arc by AZ_OFFSET swings the key
 * across that axis instead of along it, which puts four of the five daylight shots
 * into 60-120 degree cross light.
 */
const AZ_OFFSET = -67 * Math.PI / 180;

function sunAzimuthPhase(t) {
  let u = t - DAY_MID;
  if (u > 0.5) u -= 1; else if (u < -0.5) u += 1;
  if (Math.abs(u) <= DAY_HALF) return Math.PI * (0.5 + 0.5 * (u / DAY_HALF)) + AZ_OFFSET;
  const s = Math.sign(u) || 1;
  const v = (Math.abs(u) - DAY_HALF) / NIGHT_HALF;
  return (s > 0 ? Math.PI * (1 + 0.5 * v) : Math.PI * (-0.5 * v)) + AZ_OFFSET;
}

export function createSky() {
  let ctx;
  const state = {
    timeOfDay: 0.3,
    weather: 'clear',
    weatherAmount: 0,
    daySpeed: 1 / 900,
    paused: false,
  };

  let sun, hemi, fill, dome, domeMat, pmrem, envScene, envMesh, envRT = null;
  let lastEnvKey = -1e9;
  let envTimer = 0;

  const sunDir = new THREE.Vector3(0, 1, 0);
  const keyDir = new THREE.Vector3(0, 1, 0);
  const moonDir = new THREE.Vector3(0, -1, 0);
  const fogColor = new THREE.Color(0.6, 0.7, 0.8);
  const zenithColor = new THREE.Color(0.2, 0.35, 0.6);
  const horizonColor = new THREE.Color(0.7, 0.8, 0.9);
  const ambientColor = new THREE.Color(0.3, 0.4, 0.55);
  const sunColor = new THREE.Color(1, 1, 1);
  // 0 in full day -> 1 after the sun is properly down. Published so world props that
  // only exist after dark (night motes) key off the same curve the sky itself uses,
  // rather than re-deriving "is it night" from the clock and drifting out of sync.
  let nightAmount = 0;

  // smoothed weather blend
  const wx = { ...WEATHER.clear };
  let wxTarget = { ...WEATHER.clear };

  const P = { turbidity: 2.6, rayleigh: 2.0, mieCoefficient: 0.0045, mieG: 0.80, sunFade: 0 };

  function weatherTargets() {
    const base = WEATHER.clear;
    const w = WEATHER[state.weather] ?? base;
    const a = clamp01(state.weatherAmount);
    const out = {};
    for (const k of Object.keys(base)) out[k] = lerp(base[k], w[k], a);
    return out;
  }

  function applyWeather(dt) {
    wxTarget = weatherTargets();
    const k = dt > 0 ? 1 - Math.exp(-dt * 0.7) : 1;
    for (const key of Object.keys(wxTarget)) wx[key] = lerp(wx[key], wxTarget[key], k);
  }

  function apply() {
    const t = state.timeOfDay;
    const elev = sunElevation(t);
    const az = sunAzimuthPhase(t);
    const ce = Math.cos(elev), se = Math.sin(elev);
    sunDir.set(Math.cos(az) * ce, se, Math.sin(az) * ce).normalize();
    moonDir.set(-sunDir.x, -sunDir.y, -sunDir.z);
    // keep the moon a bit off the exact anti-solar point so it isn't a perfect mirror
    moonDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.42).normalize();

    const y = sunDir.y;
    const day = clamp01(y);

    // --- how much analytic scattering survives, and how much night shows through ---
    const scatterScale = smoothstep(-0.235, 0.030, y);
    const nightAmt = smoothstep(0.075, -0.085, y);
    nightAmount = nightAmt;
    const starAmt = smoothstep(0.010, -0.075, y);
    const moonAmt = smoothstep(0.020, -0.060, y) * 0.9;

    // scattering sun is clamped just below the horizon so twilight keeps a warm band
    const skyY = Math.max(y, -0.055);
    const sHoriz = Math.sqrt(Math.max(1e-6, 1 - skyY * skyY));
    const hn = Math.hypot(sunDir.x, sunDir.z) || 1;
    const sunSky = new THREE.Vector3(
      (sunDir.x / hn) * sHoriz, skyY, (sunDir.z / hn) * sHoriz,
    ).normalize();

    P.turbidity = wx.turbidity;
    P.mieCoefficient = 0.0038 + wx.haze * 0.006;
    P.rayleigh = 2.15 - day * 0.35;
    P.sunFade = smoothstep(0.02, 0.55, y);

    // ------------------------------------------------------------------
    // CPU mirror: fog / zenith / ambient / sun colour
    // ------------------------------------------------------------------
    // Calibration constant (measured 2026-08): the Preetham model over-emits,
    // producing horizon radiance ~2.4 linear / zenith ~1.6 at noon, which after
    // ACES clips the whole sky and turns the fog white. 0.40 lands zenith at
    // ~0.6 linear (clear blue) and horizon at ~0.95 (pale, not clipped), keeping
    // the sky from blowing the top of daylight frames. Must stay in sync between
    // the GLSL dome (uSkyGain), this JS mirror and the PMREM env.
    const gain = 0.40;
    const horizA = scatterJS(sunSky.x * 0.985, 0.045, sunSky.z * 0.985, sunSky.x, sunSky.y, sunSky.z, P, [0, 0, 0]);
    const horizB = scatterJS(-sunSky.x * 0.985, 0.045, -sunSky.z * 0.985, sunSky.x, sunSky.y, sunSky.z, P, [0, 0, 0]);
    const horizC = scatterJS(sunSky.z * 0.985, 0.045, -sunSky.x * 0.985, sunSky.x, sunSky.y, sunSky.z, P, [0, 0, 0]);
    const zen = scatterJS(0, 1, 0, sunSky.x, sunSky.y, sunSky.z, P, [0, 0, 0]);

    const nz = [0.0050, 0.0128, 0.0390];
    const nh = [0.0215, 0.0395, 0.0850];

    const hRaw = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      hRaw[i] = (horizA[i] * 0.34 + horizB[i] * 0.33 + horizC[i] * 0.33) * scatterScale + nh[i] * nightAmt;
    }
    // apply the same horizon wash the shader does (hz == 1 at the horizon)
    const lumH = hRaw[0] * 0.2126 + hRaw[1] * 0.7152 + hRaw[2] * 0.0722;
    const washT = clamp01(0.62 * clamp01(0.92));
    const hazeMul = 1 + wx.haze * 0.55;
    const wtint = [1.02, 1.03, 1.06];
    // fog colour must sit below the sky's own horizon radiance (aerial perspective
    // darkens the ground haze toward a blue-grey, not white) — 0.62 keeps the far
    // terrain from flattening into a white void and preserves the horizon band.
    const fcTrim = 0.62;
    const fc = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      fc[i] = lerp(hRaw[i], lumH * wtint[i], washT) * hazeMul * gain * fcTrim;
    }
    // saturation trim in bad weather
    const lf = fc[0] * 0.2126 + fc[1] * 0.7152 + fc[2] * 0.0722;
    for (let i = 0; i < 3; i++) fc[i] = lerp(lf, fc[i], wx.sat);

    fogColor.setRGB(fc[0], fc[1], fc[2], THREE.LinearSRGBColorSpace);
    horizonColor.copy(fogColor);

    const zc = [0, 0, 0];
    for (let i = 0; i < 3; i++) zc[i] = zen[i] * scatterScale * gain + nz[i] * nightAmt;
    zenithColor.setRGB(zc[0], zc[1], zc[2], THREE.LinearSRGBColorSpace);

    // ambient = mostly zenith, lifted toward the horizon (that's where the light is)
    const amb = [0, 0, 0];
    for (let i = 0; i < 3; i++) amb[i] = lerp(zc[i], fc[i], 0.42);
    const ambMax = Math.max(amb[0], amb[1], amb[2], 1e-5);
    ambientColor.setRGB(amb[0] / ambMax, amb[1] / ambMax, amb[2] / ambMax, THREE.LinearSRGBColorSpace);

    // ---- sun colour from atmospheric transmittance ----
    const tr = sunTransmittanceJS(y, P, [0, 0, 0]);
    const trMax = Math.max(tr[0], tr[1], tr[2], 1e-6);
    let sr = tr[0] / trMax, sg = tr[1] / trMax, sb = tr[2] / trMax;
    // never let it go fully monochromatic-red; keep a little life in the shadows' fill
    sr = lerp(1.0, sr, 0.95); sg = lerp(1.0, sg, 0.97); sb = lerp(1.0, sb, 0.99);
    // a touch of warmth even at noon, the way a graded game frame reads
    // (measured: pushing this to 0.05/0.17 over a wider band moves the captured
    // saturation by 0.001 — the post grade's own saturation curve absorbs it, so
    // there is nothing to win here and it is left at the calibrated value)
    const warm = 1 - smoothstep(0.15, 0.75, y);
    sr = Math.min(1.0, sr * (1 + warm * 0.04));
    sb *= 1 - warm * 0.06;

    // ---- twilight / night key direction ----
    const moonBlend = smoothstep(-0.075, -0.20, y);
    const twilightY = Math.max(y, 0.075);
    const th = Math.sqrt(Math.max(1e-6, 1 - twilightY * twilightY));
    keyDir.set((sunDir.x / hn) * th, twilightY, (sunDir.z / hn) * th).normalize();
    keyDir.lerp(moonDir, moonBlend).normalize();

    // ---- intensities ----
    const sunUp = smoothstep(-0.02, 0.06, y);
    // ------------------------------------------------------------------
    // THE KEY / FILL RATIO IS THE CEILING ON WHAT SHADOW CAN DO.
    //
    // A shadow can only ever remove the KEY's contribution. Measured on the
    // near-field meadow of the over-shoulder shot at a 23 deg morning key, with the
    // fill lights zeroed and then the key zeroed in turn:
    //
    //     full lighting      86.7 / 255
    //     key removed        63.4      -> the key is worth 27% of the image
    //     fill removed       36.6      -> the fill is worth 58% of it
    //
    // The unshadowed fill was out-contributing the shadow-casting key by roughly two
    // to one on the ground, so even a perfect, geometrically flawless, pitch-black
    // shadow could take at most a quarter of the meadow's luminance away. That is the
    // real reason `renderer.shadowMap.enabled = false` moved the mean pixel by 0.36:
    // there was almost nothing there for shadow to remove. Every other finding in this
    // round -- the frustum, the sun azimuth, the terrain not casting -- sat downstream
    // of this one.
    //
    // The key goes up and the hemisphere fill comes down by matching amounts (see
    // hemi.intensity below), so LIT ground lands at the same luminance it did before
    // (which is what the ground/sky ratio guardrail measures) while SHADOWED ground
    // falls much further. 2.60 at the new 48 deg noon peak puts lit grass at the same
    // ~1.9 linear the old 2.15-at-63-deg did, so the clip guardrail is undisturbed.
    // ------------------------------------------------------------------
    const dayKey = 3.05 * Math.pow(clamp01(y * 3.0), 0.92);
    const twilightKey = 1.0 * (1 - moonBlend) * (1 - sunUp);
    const moonKey = 0.42 * moonBlend;
    sun.intensity = (dayKey * sunUp + twilightKey + moonKey) * wx.sunMul;

    if (moonBlend > 0.5) {
      sunColor.setRGB(0.52, 0.62, 0.92, THREE.LinearSRGBColorSpace);
    } else if (sunUp < 0.5) {
      const k = smoothstep(0.06, -0.075, y);
      sunColor.setRGB(lerp(sr, 0.62, k), lerp(sg, 0.68, k), lerp(sb, 0.95, k), THREE.LinearSRGBColorSpace);
    } else {
      sunColor.setRGB(sr, sg, sb, THREE.LinearSRGBColorSpace);
    }
    sun.color.copy(sunColor);

    // ------------------------------------------------------------------
    // SHADOW STRENGTH THROUGH TWILIGHT.
    //
    // Below the horizon the "key" is a fiction: keyDir is clamped to 4 deg and stands
    // in for a sky that is, by then, an almost perfectly diffuse dome. Letting the
    // terrain cast hard shadow off that fictional 4 deg direction blankets the entire
    // world in a single flat shadow -- measured on the dusk shot as mean luminance
    // 50 -> 43 and local contrast 3.2 -> 1.9, i.e. the frame lost most of what little
    // structure it had. shadow.intensity is exactly the knob for this: full shadow
    // once the sun is properly up, faded out as it sets.
    // ------------------------------------------------------------------
    sun.shadow.intensity = 0.20 + 0.80 * smoothstep(0.02, 0.16, y);

    // Hemisphere fill — reference #9 wants real shadow structure, so the ambient
    // must stay well below the key. The pendulum has now swung both ways: 0.33 in r01
    // crushed open shadows into a flat blue-grey, and the 0.51 it was raised to in
    // response put the fill at roughly twice the key on flat ground, at which point
    // shadow stopped being able to change the image at all (see dayKey above). The
    // DAYLIGHT term is what was too big, so that is what comes down; the base term,
    // which is all that is left at dusk and through the night, is untouched, and the
    // dusk shot's mean luminance guardrail with it.
    const skyLum = Math.max(0.02, zc[0] * 0.2126 + zc[1] * 0.7152 + zc[2] * 0.0722);
    hemi.color.copy(ambientColor);
    hemi.groundColor.setRGB(
      lerp(0.10, 0.26, day) * 1.0,
      lerp(0.10, 0.23, day) * 0.92,
      lerp(0.12, 0.16, day) * 0.85,
      THREE.LinearSRGBColorSpace,
    );
    hemi.intensity = (lerp(0.30, 0.16, clamp01(y * 2.2)) + 0.22 * Math.pow(clamp01(skyLum * 1.8), 0.9)) * wx.ambMul;

    // a very low cool fill so night silhouettes never crush to pure black
    fill.color.copy(zenithColor);
    fill.intensity = 0.09 + 0.62 * nightAmt;

    // ------------------------------------------------------------------
    // fog
    // ------------------------------------------------------------------
    const baseDensity = 0.0021;
    const lowSunMist = (1 - smoothstep(0.05, 0.32, y)) * 0.00075;
    const density = (baseDensity + lowSunMist) * wx.fogMul;
    if (!ctx.scene.fog || !ctx.scene.fog.isFogExp2) {
      ctx.scene.fog = new THREE.FogExp2(0x000000, density);
    }
    ctx.scene.fog.density = density;
    ctx.scene.fog.color.copy(fogColor);
    ctx.scene.background = null;

    // ------------------------------------------------------------------
    // shader uniforms
    // ------------------------------------------------------------------
    const u = domeMat.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uSunSkyDir.value.copy(sunSky);
    u.uMoonDir.value.copy(moonDir);
    u.uTurbidity.value = P.turbidity;
    u.uRayleigh.value = P.rayleigh;
    u.uMieCoefficient.value = P.mieCoefficient;
    u.uMieG.value = P.mieG;
    u.uSunFade.value = P.sunFade;
    u.uScatterScale.value = scatterScale;
    u.uNightAmt.value = nightAmt;
    u.uStarAmt.value = starAmt;
    u.uMoonAmt.value = moonAmt;
    u.uSkyGain.value = gain;
    u.uHorizonWash.value = 0.80;
    u.uHaze.value = wx.haze;
    u.uNightZenith.value.setRGB(nz[0], nz[1], nz[2], THREE.LinearSRGBColorSpace);
    u.uNightHorizon.value.setRGB(nh[0], nh[1], nh[2], THREE.LinearSRGBColorSpace);
    u.uCloudCov.value = wx.cloudCov;
    u.uCirrusAmt.value = wx.cirrus;
    u.uCloudGain.value = lerp(0.85, 1.05, clamp01(y * 3.0));
    u.uTime.value = ctx.elapsed ?? 0;

    // ------------------------------------------------------------------
    // sun position + shadow frustum
    // ------------------------------------------------------------------
    sun.position.copy(sun.target.position).addScaledVector(keyDir, KEY_DIST);
  }

  /** snap the shadow camera to the light-space texel grid — kills shimmer */
  const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _p = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  function focusShadow(px, py, pz) {
    const half = sun.shadow.camera.right;
    const texel = (half * 2) / sun.shadow.mapSize.x;
    _r.set(0, 1, 0).cross(keyDir);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
    _r.normalize();
    _u.copy(keyDir).cross(_r).normalize();
    _p.set(px, py, pz);
    const a = _p.dot(_r), b = _p.dot(_u);
    const da = a - Math.round(a / texel) * texel;
    const db = b - Math.round(b / texel) * texel;
    sun.target.position.copy(_p).addScaledVector(_r, -da).addScaledVector(_u, -db);
    sun.target.updateMatrixWorld();
    sun.position.copy(sun.target.position).addScaledVector(keyDir, KEY_DIST);
    sun.updateMatrixWorld();
  }

  /**
   * Where to centre the shadow box.
   *
   * It used to be the player's feet, which spends half the map behind the camera.
   * A third-person camera looks FORWARD, so pushing the centre ~45% of a half-box
   * down the view axis roughly doubles the amount of on-screen ground the shadow map
   * covers, at zero cost. The player stays comfortably inside the box (the offset is
   * always less than half its half-size), so their own shadow is never lost.
   */
  function focusForCamera(cam, px, py, pz) {
    if (!cam) { focusShadow(px, py, pz); return; }
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-8) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const ahead = sun.shadow.camera.right * 0.45;
    focusShadow(cam.position.x + _fwd.x * ahead, py, cam.position.z + _fwd.z * ahead);
  }

  function refreshEnv(force = false) {
    if (!pmrem) return;
    const key = sunDir.y * 10 + wx.cloudCov + wx.haze;
    if (!force && Math.abs(key - lastEnvKey) < 0.045) return;
    lastEnvKey = key;
    const r = ctx.renderer;
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    try {
      const rt = pmrem.fromScene(envScene, 0.0, 10, 20000);
      if (envRT) envRT.dispose();
      envRT = rt;
      ctx.scene.environment = rt.texture;
      ctx.scene.environmentIntensity = 0.30;
    } catch (e) {
      pmrem = null;
    }
    r.toneMapping = prevTone;
  }

  return {
    name: 'sky',
    order: ORDER.SKY,
    get timeOfDay() { return state.timeOfDay; },
    get sunLight() { return sun; },
    get sunElevationDeg() { return Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180 / Math.PI; },
    get isNight() { return sunDir.y < -0.02; },

    init(c) {
      ctx = c;

      // ---- key light ----
      sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.castShadow = true;
      // The frustum below is 3.9x wider than it used to be. At the quality tier's own
      // map size that would put a shadow texel at 13.7 cm of ground -- wider than a
      // bush's contact shadow -- and the point of widening the frustum was to stop
      // losing shadows, not to trade the near-field ones away for far-field ones.
      // Doubling holds the texel near where it was, at 6.8 cm. The shadow pass is
      // depth-only, so this costs fill rate and not a single extra triangle.
      const m = Math.min(4096, c.quality.shadowMapSize * 2);
      // ------------------------------------------------------------------
      // THE SHADOW FRUSTUM WAS TOO SMALL AND TOO CLOSE.
      //
      // It used to be a 144 m box with the light parked 250 m away and far = 520.
      // Two things fell out of that, and together they are why "nothing in any frame
      // casts a shadow onto anything else":
      //
      //   1. An ORTHOGRAPHIC shadow box of half-size S only covers S/sin(elev) metres
      //      of GROUND along the sun azimuth. At the vista shot's 51 deg key that is
      //      93 m: the tree-covered hillside the critic pointed at sits at 150-300 m,
      //      entirely outside the shadow map, so it could not be broken up by shadow
      //      no matter what else was fixed. Every wide shot was showing terrain that
      //      the shadow map had never heard of.
      //   2. far = 520 with the light 250 m out meant the ground could only be +/-270 m
      //      deep in light space. Widening the box without moving the light back just
      //      clips the far half of it away.
      //
      // So: a much bigger box, the light pushed well back, and a depth range that
      // actually bounds it. 2048 over 280 m is 13.7 cm/texel -- coarser than the old
      // 7 cm, which cost nothing visible, because at 7 cm the map was resolving
      // individual grass tufts inside a frame that had no shadows in it at all.
      // ------------------------------------------------------------------
      const s = c.quality.tier === 'high' ? 150 : 140;
      sun.shadow.mapSize.set(m, m);
      sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
      sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
      sun.shadow.camera.near = 10; sun.shadow.camera.far = KEY_DIST * 2 - 10;
      // shadow.bias is in NORMALISED depth, so it scales with (far - near): the old
      // -0.00035 over a 519 m range was 0.18 m of depth push. Held at ~0.10 m here.
      sun.shadow.bias = -0.00009;
      // normalBias is a CONSTANT world-space push along the surface normal, so the
      // depth it actually buys is normalBias * sin(elevation) -- 4 cm at the 16 deg
      // morning key. It can never be the terrain's acne fix (the terrain needs a
      // SLOPE-SCALED offset; see ground.customDepthMaterial in world/index.js). Kept
      // here only to stop small props shadowing their own facing side.
      sun.shadow.normalBias = 0.12;
      sun.shadow.camera.updateProjectionMatrix();
      c.scene.add(sun, sun.target);

      hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a4433, 0.6);
      c.scene.add(hemi);
      fill = new THREE.AmbientLight(0x9fb8dd, 0.1);
      c.scene.add(fill);

      // ---- sky dome ----
      domeMat = new THREE.ShaderMaterial({
        uniforms: {
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uSunSkyDir: { value: new THREE.Vector3(0, 1, 0) },
          uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
          uTurbidity: { value: 2.6 },
          uRayleigh: { value: 2.0 },
          uMieCoefficient: { value: 0.0045 },
          uMieG: { value: 0.8 },
          uSunFade: { value: 0 },
          uScatterScale: { value: 1 },
          uNightAmt: { value: 0 },
          uSkyGain: { value: 1 },
          uHorizonWash: { value: 0.92 },
          uNightZenith: { value: new THREE.Color(0.0050, 0.0128, 0.039) },
          uNightHorizon: { value: new THREE.Color(0.0215, 0.0395, 0.085) },
          uStarAmt: { value: 0 },
          uMoonAmt: { value: 0 },
          uTime: { value: 0 },
          uCloudCov: { value: 0.1 },
          uCloudSharp: { value: 1.35 },
          uCloudAlt: { value: 3400 },
          uCloudGain: { value: 1 },
          uCirrusAmt: { value: 0.85 },
          uWindAngle: { value: 0.6 },
          uHaze: { value: 0.1 },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true,
        fog: false,
      });

      const geo = new THREE.SphereGeometry(3200, 48, 32);
      dome = new THREE.Mesh(geo, domeMat);
      dome.frustumCulled = false;
      // drawn last among opaque objects so terrain rejects most sky pixels on depth
      dome.renderOrder = 1000;
      dome.matrixAutoUpdate = false;
      dome.onBeforeRender = (renderer, scene, camera) => {
        dome.position.copy(camera.position);
        dome.updateMatrix();
        dome.updateMatrixWorld(true);
      };
      c.scene.add(dome);

      // ---- image-based lighting generated from the same sky ----
      try {
        pmrem = new THREE.PMREMGenerator(c.renderer);
        pmrem.compileEquirectangularShader?.();
        envScene = new THREE.Scene();
        envMesh = new THREE.Mesh(new THREE.SphereGeometry(3200, 32, 20), domeMat);
        envMesh.frustumCulled = false;
        envScene.add(envMesh);
      } catch (e) {
        pmrem = null;
      }

      state.timeOfDay = 0.3;
      applyWeather(0);
      apply();
      refreshEnv(true);
    },

    update(dt, c) {
      if (!state.paused) state.timeOfDay = (state.timeOfDay + dt * state.daySpeed) % 1;
      applyWeather(dt);
      apply();

      const p = c.get('player')?.position;
      focusForCamera(c.camera, p?.x ?? c.camera.position.x, p?.y ?? 0, p?.z ?? c.camera.position.z);

      envTimer += dt;
      if (envTimer > 0.4) { envTimer = 0; refreshEnv(false); }
    },

    // ---- public contract -------------------------------------------------
    setTimeOfDay(t) {
      state.timeOfDay = ((t % 1) + 1) % 1;
      applyWeather(0);
      apply();
      const p = ctx?.get('player')?.position;
      if (p) focusForCamera(ctx?.camera, p.x, p.y, p.z);
      refreshEnv(true);
    },
    getSunDirection() { return sunDir.clone(); },
    getSunColor() { return sunColor.clone(); },
    setWeather(name, amount = 1) {
      state.weather = WEATHER[name] ? name : 'clear';
      state.weatherAmount = clamp01(amount);
      applyWeather(0);
      apply();
      refreshEnv(true);
    },

    // ---- additive helpers ------------------------------------------------
    getKeyDirection() { return keyDir.clone(); },
    getMoonDirection() { return moonDir.clone(); },
    getSkyColor() { return zenithColor.clone(); },
    getHorizonColor() { return horizonColor.clone(); },
    getFogColor() { return fogColor.clone(); },
    getAmbientColor() { return ambientColor.clone(); },
    getNightAmount() { return nightAmount; },
    setDaySpeed(s) { state.daySpeed = s; },
    setPaused(v) { state.paused = !!v; },

    snapshot() {
      return {
        timeOfDay: +state.timeOfDay.toFixed(4),
        weather: state.weather,
        sunY: +sunDir.y.toFixed(3),
        sunElevDeg: +(Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180 / Math.PI).toFixed(1),
        sunIntensity: +sun.intensity.toFixed(2),
        fog: '#' + fogColor.getHexString(),
      };
    },
  };
}
