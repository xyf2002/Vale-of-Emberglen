import * as THREE from 'three';

/**
 * Procedural geometry toolkit for creature craft.
 *
 * Everything a Pal is made of is a *swept surface*: a centreline path with a radius and
 * an elliptical cross-section that both vary along it. That single primitive gives us
 * the fused body-and-head blob (one continuous surface, no neck seam), leaf-shaped ears,
 * curled horns, stubby mitten limbs, arcing tails and wool lobes.
 *
 * Reference observation #1: the body must read as ONE dominant primitive. That is only
 * true if it genuinely IS one mesh — two intersecting spheres always show their seam.
 */

/** Catmull-Rom-ish cubic hermite over non-uniform keyframes. */
export function chan(stops, key, def = 0) {
  const ts = [], vs = [];
  for (const s of stops) { ts.push(s.t); vs.push(s[key] !== undefined ? s[key] : def); }
  const n = ts.length;
  if (n === 1) return () => vs[0];
  return (t) => {
    if (t <= ts[0]) return vs[0];
    if (t >= ts[n - 1]) return vs[n - 1];
    let i = 0; while (i < n - 2 && t > ts[i + 1]) i++;
    const t0 = ts[i], t1 = ts[i + 1], h = t1 - t0, s = (t - t0) / h;
    const p0 = vs[i], p1 = vs[i + 1];
    const m0 = i > 0 ? ((vs[i + 1] - vs[i - 1]) / (ts[i + 1] - ts[i - 1])) * h : p1 - p0;
    const m1 = i < n - 2 ? ((vs[i + 2] - vs[i]) / (ts[i + 2] - ts[i])) * h : p1 - p0;
    const s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
  };
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _T = new THREE.Vector3(), _N = new THREE.Vector3(), _B = new THREE.Vector3();
const _du = new THREE.Vector3(), _dv = new THREE.Vector3();

/**
 * Build a (vSeg+1) x (uSeg+1) grid of positions + normals for a swept surface.
 *
 * stops: [{ t, r, x?, y?, z?, sx?, sz?, roll? }]
 *   r  = radius, x/y/z = centreline, sx/sz = cross-section aspect (sz is the front-back
 *   axis so a "blade" ear is sx=1, sz=0.16), roll = twist of the cross-section.
 * ref: which world direction is the local "front" (theta = 0). Default -Z, our forward.
 */
export function sweepGrid({ uSeg = 26, vSeg = 30, stops, ref = [0, 0, -1], uRange = null, vRange = null, offset = 0 }) {
  const R = chan(stops, 'r', 1);
  const X = chan(stops, 'x', 0), Y = chan(stops, 'y', 0), Z = chan(stops, 'z', 0);
  const SX = chan(stops, 'sx', 1), SZ = chan(stops, 'sz', 1);
  const RO = chan(stops, 'roll', 0);
  const refV = new THREE.Vector3(...ref).normalize();
  const alt = new THREE.Vector3(0, 1, 0);
  const e = 1e-3;

  const wrapU = !uRange;
  const u0 = uRange ? uRange[0] : 0, u1 = uRange ? uRange[1] : 1;
  const v0 = vRange ? vRange[0] : 0, v1 = vRange ? vRange[1] : 1;

  const pos = [], nor = [], tanAt = [];
  for (let iv = 0; iv <= vSeg; iv++) {
    const v = v0 + (iv / vSeg) * (v1 - v0);
    const va = Math.max(0, v - e), vb = Math.min(1, v + e);
    _a.set(X(va), Y(va), Z(va));
    _b.set(X(vb), Y(vb), Z(vb));
    _T.copy(_b).sub(_a);
    if (_T.lengthSq() < 1e-12) _T.set(0, 1, 0);
    _T.normalize();
    _N.copy(refV).addScaledVector(_T, -refV.dot(_T));
    if (_N.lengthSq() < 1e-8) { _N.copy(alt).addScaledVector(_T, -alt.dot(_T)); }
    _N.normalize();
    _B.copy(_T).cross(_N).normalize();
    tanAt.push(_T.clone());

    const cx = X(v), cy = Y(v), cz = Z(v);
    const r = R(v), sx = SX(v), sz = SZ(v), ro = RO(v);
    const row = [];
    for (let iu = 0; iu <= uSeg; iu++) {
      const th = (u0 + (iu / uSeg) * (u1 - u0)) * Math.PI * 2 + ro;
      const cs = Math.cos(th) * sz * r, sn = Math.sin(th) * sx * r;
      row.push(new THREE.Vector3(
        cx + _N.x * cs + _B.x * sn,
        cy + _N.y * cs + _B.y * sn,
        cz + _N.z * cs + _B.z * sn));
    }
    pos.push(row);
  }

  for (let iv = 0; iv <= vSeg; iv++) {
    const row = [];
    for (let iu = 0; iu <= uSeg; iu++) {
      const iuA = wrapU ? (iu - 1 + uSeg) % uSeg : Math.max(0, iu - 1);
      const iuB = wrapU ? (iu + 1) % uSeg : Math.min(uSeg, iu + 1);
      _du.copy(pos[iv][iuB]).sub(pos[iv][iuA]);
      const ivA = Math.max(0, iv - 1), ivB = Math.min(vSeg, iv + 1);
      _dv.copy(pos[ivB][iu]).sub(pos[ivA][iu]);
      _c.copy(_du).cross(_dv);
      if (_c.lengthSq() < 1e-14) {
        _c.copy(tanAt[iv]).multiplyScalar(iv === 0 ? -1 : 1);
      }
      row.push(_c.normalize().clone());
    }
    nor.push(row);
  }
  if (offset !== 0) {
    for (let iv = 0; iv <= vSeg; iv++) {
      for (let iu = 0; iu <= uSeg; iu++) pos[iv][iu].addScaledVector(nor[iv][iu], offset);
    }
  }
  return { pos, nor, uSeg, vSeg };
}

/** A sphere is just a sweep — used for wool lobes, cheeks, berry-shaped noses. */
export function sphereGrid(r, uSeg = 14, vSeg = 10) {
  const stops = [];
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    stops.push({ t: i / 12, r: Math.sin(a) * r, y: -Math.cos(a) * r });
  }
  return sweepGrid({ uSeg, vSeg, stops });
}

const _m3 = new THREE.Matrix3();
const _p = new THREE.Vector3(), _n = new THREE.Vector3();

/** Accumulates many grids into one indexed, skinned, vertex-coloured BufferGeometry. */
export class Builder {
  constructor() {
    this.pos = []; this.nor = []; this.uv = []; this.col = [];
    this.si = []; this.sw = [];
    this.idx = [[], []];         // group 0 = fur, group 1 = face decal
    this.count = 0;
  }

  /**
   * @param grid    from sweepGrid/sphereGrid
   * @param matrix  THREE.Matrix4 placing the part (negative determinant = mirrored)
   * @param paint   (u,v,p,n) => [r,g,b]
   * @param weight  (p, v) => [ [boneIndex, w], ... ]   (up to 4)
   * @param group   0 fur | 1 face
   * @param uvRect  [u0,v0,u1,v1] for face decals; omitted = tiled fur uv
   */
  addGrid(grid, { matrix, paint, weight, group = 0, uvRect = null, uvScale = [1, 1] }) {
    const { pos, nor, uSeg, vSeg } = grid;
    const M = matrix || new THREE.Matrix4();
    _m3.setFromMatrix4(M).invert().transpose();
    const flip = M.determinant() < 0;
    const base = this.count;
    for (let iv = 0; iv <= vSeg; iv++) {
      for (let iu = 0; iu <= uSeg; iu++) {
        const u = iu / uSeg, v = iv / vSeg;
        _p.copy(pos[iv][iu]).applyMatrix4(M);
        _n.copy(nor[iv][iu]).applyMatrix3(_m3).normalize();
        if (flip) _n.negate();
        this.pos.push(_p.x, _p.y, _p.z);
        this.nor.push(_n.x, _n.y, _n.z);
        if (uvRect) {
          this.uv.push(uvRect[0] + u * (uvRect[2] - uvRect[0]), uvRect[1] + v * (uvRect[3] - uvRect[1]));
        } else {
          this.uv.push(u * uvScale[0], v * uvScale[1]);
        }
        const c = paint ? paint(u, v, _p, _n) : [1, 1, 1];
        this.col.push(c[0], c[1], c[2]);
        const w = weight ? weight(_p, v, u) : [[0, 1]];
        for (let k = 0; k < 4; k++) {
          this.si.push(w[k] ? w[k][0] : 0);
          this.sw.push(w[k] ? w[k][1] : 0);
        }
        this.count++;
      }
    }
    const stride = uSeg + 1;
    const out = this.idx[group];
    for (let iv = 0; iv < vSeg; iv++) {
      for (let iu = 0; iu < uSeg; iu++) {
        const a = base + iv * stride + iu, b = a + 1, c2 = a + stride + 1, d = a + stride;
        if (flip) out.push(a, c2, b, a, d, c2);
        else out.push(a, b, c2, a, c2, d);
      }
    }
    return this;
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    const all = this.idx[0].concat(this.idx[1]);
    g.setIndex(all);
    g.addGroup(0, this.idx[0].length, 0);
    if (this.idx[1].length) g.addGroup(this.idx[0].length, this.idx[1].length, 1);
    g.computeBoundingSphere();
    g.boundingSphere.radius *= 1.9;   // deformation headroom so skinning never pops out
    return g;
  }
}

/* --------------------------------------------------------------- textures */

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Fur fuzz. Reference observation #4: "fine flocked noise". This is a near-white
 * multiplier map, tiled small, that breaks the plastic evenness of a smooth surface.
 * Deterministic: driven by the passed rng.
 */
export function furTexture(rng, { size = 256, contrast = 0.11, streak = 0.55, tufts = 0 } = {}) {
  const c = mkCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.lineCap = 'round';
  const n = Math.round(size * size * 0.055);
  for (let i = 0; i < n; i++) {
    const x = rng.next() * size, y = rng.next() * size;
    const d = (rng.next() - 0.5) * 2;
    const v = Math.round(255 * (1 - Math.max(0, d) * contrast * 2.6));
    const w = Math.round(255 * (1 + Math.max(0, -d) * contrast * 1.4));
    const shade = d > 0 ? v : Math.min(255, w);
    g.strokeStyle = `rgba(${shade},${shade},${shade},${0.16 + rng.next() * 0.3})`;
    g.lineWidth = 0.7 + rng.next() * 1.5;
    const len = (0.4 + rng.next() * 2.4) * streak;
    const ang = -1.35 + (rng.next() - 0.5) * 1.1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  }
  // low-frequency clumping so the fuzz has structure rather than TV static
  for (let i = 0; i < tufts; i++) {
    const x = rng.next() * size, y = rng.next() * size, r = size * (0.03 + rng.next() * 0.09);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = rng.bool() ? 232 : 255;
    grd.addColorStop(0, `rgba(${dark},${dark},${dark},0.30)`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Contact shadow decal. Reference observation #9: a small, tight, distinctly darker
 * ellipse directly under the feet with a hard-ish inner core and ~0.2 m of falloff.
 * Without this every creature floats.
 */
export function contactShadowTexture() {
  const S = 96;
  const c = mkCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  // "distinctly darker, with a hard-ish inner core and ~0.2 m of falloff" — but this is
  // a MULTIPLY decal, so alpha 0.86 means multiplying the ground by 0.14, i.e. black.
  // A contact shadow that reads as a hole is as wrong as no contact shadow at all.
  grd.addColorStop(0.00, 'rgba(52,44,58,0.62)');
  grd.addColorStop(0.34, 'rgba(70,62,76,0.50)');
  grd.addColorStop(0.66, 'rgba(140,134,146,0.20)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 6.2832); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export { mkCanvas };
