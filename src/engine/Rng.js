// Deterministic RNG. Every system must draw randomness from here (never Math.random)
// so that a given seed always produces the identical world — this is what makes
// blind A/B screenshot comparison between build rounds meaningful.

export class Rng {
  constructor(seed = 1337) {
    this.seed = seed >>> 0;
    this._s = this.seed || 1;
  }
  /** float in [0,1) */
  next() {
    let t = (this._s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  bool(p = 0.5) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** normally-distributed-ish value, mean 0 stddev ~1 */
  gauss() { return (this.next() + this.next() + this.next() + this.next() - 2) * 1.2; }
  /** a fresh independent stream — use so adding a system doesn't reshuffle other systems */
  fork(salt = 0) { return new Rng((this.seed ^ (0x9e3779b9 + salt * 2654435761)) >>> 0); }
}

/** Classic value-noise + fBm, seeded. Shared by terrain, scatter, clouds, fur patterns. */
export function makeNoise2D(seed = 1) {
  const p = new Uint8Array(512);
  const rng = new Rng(seed);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = rng.int(0, i); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y) => {
    switch (h & 3) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; default: return -x - y;
    }
  };
  const noise = (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = fade(x), v = fade(y);
    const A = p[X] + Y, B = p[X + 1] + Y;
    return lerp(
      lerp(grad(p[A], x, y), grad(p[B], x - 1, y), u),
      lerp(grad(p[A + 1], x, y - 1), grad(p[B + 1], x - 1, y - 1), u), v);
  };
  noise.fbm = (x, y, octaves = 5, lac = 2.03, gain = 0.5) => {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) { sum += a * noise(x * f, y * f); norm += a; a *= gain; f *= lac; }
    return sum / norm;
  };
  /** ridged fBm — good for mountain spines */
  noise.ridged = (x, y, octaves = 5, lac = 2.03, gain = 0.5) => {
    let a = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += a * (1 - Math.abs(noise(x * f, y * f))); norm += a; a *= gain; f *= lac;
    }
    return sum / norm;
  };
  return noise;
}
