import * as THREE from 'three';

/**
 * GATHERABLES — berry bushes, fallen branches and loose stone, scattered in deliberate
 * clusters (never an even sprinkle; see reference brief #8) and harvestable with a short
 * channelled pluck that ends in a physical pop.
 *
 * Everything is one InstancedMesh per part, so the whole layer is ~6 draw calls.
 */

/**
 * REACH is measured from the CLUSTER CENTRE, and a berry thicket is two to four bushes
 * spread over ~2.7m. A 2.6m reach therefore meant standing inside the shrubbery before
 * the game admitted a bush was there — and a measured five-minute session harvested
 * exactly nothing, from thirty-seven ready nodes, while the HUD told the player to press
 * E at a bush. Reach is now "arm's length from the outside of the thicket".
 *
 * Berries are the taming currency, so they are also the most plentiful thing in the vale
 * and the fastest to come back. Running out must cost you a walk, never the session.
 */
const KINDS = {
  berry: { label: 'berries', item: 'berry', yieldMin: 4, yieldMax: 6, channel: 0.42, regrow: 22, color: 0xd93a5c, reach: 4.4 },
  wood: { label: 'sticks', item: 'wood', yieldMin: 2, yieldMax: 3, channel: 0.5, regrow: 70, color: 0x8a6438, reach: 3.0 },
  stone: { label: 'stone', item: 'stone', yieldMin: 1, yieldMax: 2, channel: 0.62, regrow: 90, color: 0x9aa39a, reach: 2.9 },
};

/**
 * GROUNDING A PROP FROM OUTSIDE src/world — WHY THIS IS A LOCAL COPY.
 *
 * `applyContactShade` lives in src/world/vegetation.js and src/world/props.js imports it.
 * We cannot: systems never import each other (see CLAUDE.md), and the world's public
 * surface deliberately exposes the GROUND-side half (`world.setContactPatches`) and not
 * this one, because this half is a shader patch on a material the world never sees.
 * Twenty lines duplicated is the price of the directory boundary; the two copies are
 * independent by design, so do not "unify" them.
 *
 * `sink` is where the GROUND PLANE sits relative to the INSTANCE ORIGIN, in units of
 * instance scale — not where the object sits relative to the ground. The sign trips
 * everyone: this file's bushes are composed at `terrainY - 0.05*s`, so the ground is at
 * +0.05*s in the varying's frame (sinkRel = +0.05), while its rocks are composed at
 * `terrainY + 0.16*s`, so the ground is at −0.16*s (sinkRel = NEGATIVE). Getting it
 * backwards anchors the band underground and the visible part runs at half strength —
 * MEASURED here, not read: see tools/_bushshade.mjs, which samples the bush's own pixels
 * at the base and at mid-height and reports the ratio.
 */
function applyContactShade(mat, opts = {}) {
  const { rangeAbs = 0.10, rangeRel = 0.25, dark = 0.46, sinkAbs = 0, sinkRel = 0 } = opts;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  const f = (v) => v.toFixed(4);
  mat.onBeforeCompile = function (sh, renderer) {
    if (prev) prev.call(this, sh, renderer);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCH; varying float vCS;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 cwp_ = vec4(transformed, 1.0);
          float cbase_ = 0.0;
          vCS = 1.0;
          #ifdef USE_INSTANCING
            cwp_ = instanceMatrix * cwp_;
            cbase_ = instanceMatrix[3].y;
            vCS = length(instanceMatrix[0].xyz);
          #endif
          vCH = cwp_.y - cbase_;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCH; varying float vCS;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float gy_ = ${f(sinkAbs)} + ${f(sinkRel)} * vCS;
          float rg_ = ${f(rangeAbs)} + ${f(rangeRel)} * vCS;
          diffuseColor.rgb *= mix(${f(dark)}, 1.0, smoothstep(0.0, max(rg_, 1e-3), vCH - gy_));
        }`);
  };
  const tag = `ict${rangeAbs}_${rangeRel}_${dark}_${sinkAbs}_${sinkRel}`;
  mat.customProgramCacheKey = prevKey ? () => prevKey.call(mat) + tag : () => tag;
  return mat;
}

/**
 * Average face normals across coincident vertices.
 *
 * WHY THIS EXISTS — it is the whole of r12's "A's bushes are visibly flat-shaded
 * icosahedra, you can count the triangles, the facet edges are hard". The material has
 * `flatShading: false` and always did, which is why nobody looked here: the FLATNESS IS
 * IN THE GEOMETRY. `THREE.IcosahedronGeometry` is non-indexed, and
 * `computeVertexNormals()` on a non-indexed geometry writes the face normal to all three
 * of a triangle's vertices — i.e. it produces flat shading no matter what the material
 * says. Every lobe went through that twice (once per lobe, once on the merge).
 *
 * Welding by position instead costs nothing at runtime and no triangles, and it removes
 * the hard facet edges while keeping the lumpy silhouette the displacement gives. Note
 * the weld is PER LOBE, deliberately: welding across the merged clump would average
 * normals across the seams where two lobes interpenetrate and smear the clump back into
 * one egg, which is the shape this geometry exists to avoid.
 */
function smoothNormals(g) {
  const p = g.attributes.position.array;
  const n = g.attributes.position.count;
  const out = new Float32Array(n * 3);
  const map = new Map();
  const key = (i) => `${Math.round(p[i * 3] * 8192)},${Math.round(p[i * 3 + 1] * 8192)},${Math.round(p[i * 3 + 2] * 8192)}`;
  const acc = [];
  for (let i = 0; i < n; i++) {
    const k = key(i);
    let s = map.get(k);
    // `s` is the BASE INDEX into acc (stepping 0, 3, 6, ...), NOT an ordinal slot — so it
    // must never be multiplied by 3 again when it is read back. It was, and every lookup
    // ran off the end of acc: acc[s] came back `undefined`, arithmetic on it produced NaN,
    // and TWO THIRDS OF EVERY BUSH'S NORMALS WERE NaN. A NaN normal does not render as an
    // obvious error, it renders as a surface with no key light — so the bushes came out
    // blue-black (rgb 31,35,52) and looked exactly like contact shading turned up too far.
    // Two rounds of palette and contact-shade edits changed the frame by literally zero
    // bytes before the attribute itself was measured. If shading looks wrong, check the
    // normals for NaN before touching a colour.
    if (s === undefined) { s = acc.length; map.set(k, s); acc.push(0, 0, 0); }
    out[i * 3] = s;   // base index parked in x, rewritten below
  }
  for (let t = 0; t < n; t += 3) {
    const ax = p[t * 3], ay = p[t * 3 + 1], az = p[t * 3 + 2];
    const bx = p[t * 3 + 3], by = p[t * 3 + 4], bz = p[t * 3 + 5];
    const cx = p[t * 3 + 6], cy = p[t * 3 + 7], cz = p[t * 3 + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    // unnormalised cross product, so bigger triangles weigh more — which is what keeps
    // a sliver at the pole from dominating the average
    const fx = e1y * e2z - e1z * e2y;
    const fy = e1z * e2x - e1x * e2z;
    const fz = e1x * e2y - e1y * e2x;
    for (let v = 0; v < 3; v++) {
      const s = out[(t + v) * 3];
      acc[s] += fx; acc[s + 1] += fy; acc[s + 2] += fz;
    }
  }
  for (let i = 0; i < n; i++) {
    const s = out[i * 3];
    let x = acc[s], y = acc[s + 1], z = acc[s + 2];
    const L = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / L; out[i * 3 + 1] = y / L; out[i * 3 + 2] = z / L;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return g;
}

/**
 * Foliage: four overlapping displaced lobes merged into one geometry, so the silhouette
 * is a clump of rounded masses rather than one smooth egg — the same "convex body,
 * detail only in the appendages" logic the creatures use, applied to a shrub.
 */
function bushGeometry(noise, seed) {
  const LOBES = [
    [0.00, 0.44, 0.00, 0.50, 2],
    [0.30, 0.26, 0.10, 0.38, 1],
    [-0.26, 0.24, -0.16, 0.35, 1],
    [0.04, 0.20, -0.30, 0.32, 1],
  ];
  const top = new THREE.Color(0x6d8c3e);
  const mid = new THREE.Color(0x476026);
  // `bot` IS NOT FREE TO BE AS DARK AS IT LOOKS ON PAPER. It is multiplied a second time
  // by the contact-shade band, which covers the lower ~36% of the visible bush — exactly
  // where `bot` is applied. Authored at 0x27351a the two stack to a near-zero albedo and
  // the sky ambient takes over, so the base of every bush rendered BLUE-BLACK (measured
  // rgb 31,35,52 in r14 interaction_feed, against 78,102,56 in r13). Vertex-colour AO and
  // shader AO must be budgeted together; either alone is fine.
  const bot = new THREE.Color(0x3c5223);
  const c = new THREE.Color();
  const parts = [];

  for (let L = 0; L < LOBES.length; L++) {
    const [ox, oy, oz, r, det] = LOBES[L];
    const g = new THREE.IcosahedronGeometry(r, det);
    const p = g.attributes.position;
    const colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const n = noise((x + ox) * 4.4 + seed + L, (z + oz) * 4.4 - seed) * 0.55
        + noise((y + oy) * 7.3 - seed, (x + ox) * 7.3 + L) * 0.3;
      const k = 1 + n * 0.3;
      const px = x * k + ox, py = y * k * 0.92 + oy, pz = z * k + oz;
      p.setXYZ(i, px, py, pz);
      const up = THREE.MathUtils.clamp(py / 0.85, 0, 1);
      if (up > 0.5) c.copy(mid).lerp(top, (up - 0.5) * 2);
      else c.copy(bot).lerp(mid, up * 2);
      c.offsetHSL(n * 0.025, n * 0.05, n * 0.06);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    // NOT computeVertexNormals() — see smoothNormals(). This geometry is non-indexed, so
    // the built-in writes a face normal to every vertex and the shrub renders flat-shaded
    // with countable facets however the material is configured.
    smoothNormals(g);
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false) ?? parts[0];
  // and NOT here either: the merge only copies the normals the lobes already carry.
  merged.computeBoundingSphere();
  return merged;
}

/** tiny local merge so we do not depend on the examples/ tree */
function mergeGeometries(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    const gp = g.attributes.position.array;
    const gc = g.attributes.color.array;
    const gn = g.attributes.normal.array;
    const idx = g.index;
    if (idx) {
      // expand indexed -> non-indexed so the merge stays trivial
      for (let i = 0; i < idx.count; i++) {
        const v = idx.getX(i);
        pos[o * 3] = gp[v * 3]; pos[o * 3 + 1] = gp[v * 3 + 1]; pos[o * 3 + 2] = gp[v * 3 + 2];
        col[o * 3] = gc[v * 3]; col[o * 3 + 1] = gc[v * 3 + 1]; col[o * 3 + 2] = gc[v * 3 + 2];
        nrm[o * 3] = gn[v * 3]; nrm[o * 3 + 1] = gn[v * 3 + 1]; nrm[o * 3 + 2] = gn[v * 3 + 2];
        o++;
      }
    } else {
      for (let v = 0; v < g.attributes.position.count; v++) {
        pos[o * 3] = gp[v * 3]; pos[o * 3 + 1] = gp[v * 3 + 1]; pos[o * 3 + 2] = gp[v * 3 + 2];
        col[o * 3] = gc[v * 3]; col[o * 3 + 1] = gc[v * 3 + 1]; col[o * 3 + 2] = gc[v * 3 + 2];
        nrm[o * 3] = gn[v * 3]; nrm[o * 3 + 1] = gn[v * 3 + 1]; nrm[o * 3 + 2] = gn[v * 3 + 2];
        o++;
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, o * 3), 3));
  out.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, o * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm.subarray(0, o * 3), 3));
  return out;
}

/** angular rock with moss baked into the upward faces only (brief #8) */
function rockGeometry(noise, seed) {
  const g = new THREE.IcosahedronGeometry(0.5, 1);
  const p = g.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const stone = new THREE.Color(0x7f8479);
  const moss = new THREE.Color(0x5c7238);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = noise(x * 2.6 + seed, z * 2.6 + seed);
    const k = 1 + n * 0.42;
    p.setXYZ(i, x * k * 1.25, y * k * 0.78, z * k);
    const up = THREE.MathUtils.clamp(y / 0.45, 0, 1);
    const mossAmt = THREE.MathUtils.clamp((up - 0.25) * 1.6 + n * 0.4, 0, 1) * 0.85;
    c.copy(stone).lerp(moss, mossAmt);
    c.offsetHSL(0, 0, n * 0.05);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return g;
}

function branchGeometry() {
  const g = new THREE.CylinderGeometry(0.028, 0.045, 0.95, 5, 1);
  g.rotateZ(Math.PI / 2);
  const p = g.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const a = new THREE.Color(0x7a5a33), b = new THREE.Color(0x4e3a22);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const t = (p.getX(i) / 0.95) + 0.5;
    c.copy(b).lerp(a, THREE.MathUtils.clamp(t, 0, 1));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

export function createResources(ctx, world, fx) {
  const rng = ctx.rng.fork(0x51be7);
  const noise = ctx.noise;
  const nodes = [];

  const MAX_BUSH = 180, MAX_BERRY = 1250, MAX_ROCK = 90, MAX_BRANCH = 120;

  const bushMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94, metalness: 0, flatShading: false });
  // Object-side contact occlusion. Bushes are composed at `terrainY - 0.05*s` below, so
  // the ground plane sits at +0.05*s above the instance origin -> sinkRel = +0.05. The
  // band covers roughly the bottom third of the ~0.95*s of shrub that is above ground.
  // dark 0.46 -> 0.66: the bush already carries a vertical vertex-colour ramp down to
  // `bot`, so this band is the SECOND darkening on the same pixels. See the note by `bot`.
  applyContactShade(bushMat, { rangeAbs: 0.06, rangeRel: 0.26, dark: 0.66, sinkRel: 0.05 });
  const berryMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: false, roughness: 0.42, metalness: 0 });
  const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true });
  // ...and rocks are composed at `terrainY + 0.16*s`, i.e. the ground is BELOW the
  // instance origin: sinkRel is negative here and positive above. Same file, same
  // mechanism, opposite sign — this is the trap the header note is about.
  applyContactShade(rockMat, { rangeAbs: 0.05, rangeRel: 0.30, dark: 0.46, sinkRel: -0.16 });
  const branchMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  // NO object-side band on the branches — measured negative result. A stick is a 9 cm
  // cylinder lying on the ground, so ANY band deep enough to be visible swallows the
  // whole prop and just renders it uniformly darker; there is no "lower surface" to
  // occlude. Their grounding is entirely the ground-side patch.

  const bushes = new THREE.InstancedMesh(bushGeometry(noise, 3.7), bushMat, MAX_BUSH);
  // 6x4 was chosen when berries were tiny background dressing; r12's blind critic named
  // them specifically — "the berries are literal faceted polyhedra rather than spheres" —
  // and in creature_group the near thicket's berries are 30-40 px across, which is plenty
  // to count six meridians on. 10x7 triples the triangles of a part that is 36 tris to
  // begin with; the whole layer is still one instanced draw.
  const berries = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 10, 7), berryMat, MAX_BERRY);
  const rocks = new THREE.InstancedMesh(rockGeometry(noise, 11.3), rockMat, MAX_ROCK);
  const branches = new THREE.InstancedMesh(branchGeometry(), branchMat, MAX_BRANCH);

  // named so a probe can find them without guessing at vertex counts — see
  // tools/_bushshade.mjs, which swaps the bush material for an unshaded clone to
  // measure the object-side contact band as an exact A/B
  bushes.name = 'gatherBush';
  berries.name = 'gatherBerry';
  rocks.name = 'gatherRock';
  branches.name = 'gatherBranch';

  for (const m of [bushes, berries, rocks, branches]) {
    m.castShadow = true;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.count = 0;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    ctx.scene.add(m);
  }
  berries.castShadow = false;
  // an 8cm sphere hanging inside a bush is already in that bush's shadow; sampling the
  // shadow map for each of a thousand of them buys nothing and costs fill
  berries.receiveShadow = false;
  branches.castShadow = false;
  berries.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BERRY * 3), 3);
  berries.instanceColor.setUsage(THREE.DynamicDrawUsage);

  const M = new THREE.Matrix4();
  const Q = new THREE.Quaternion();
  const E = new THREE.Euler();
  const V = new THREE.Vector3();
  const S = new THREE.Vector3();
  const berryCol = new THREE.Color();

  let bushN = 0, berryN = 0, rockN = 0, branchN = 0;
  let harvested = 0;   // instrument: how many nodes the player has actually stripped

  function setInst(mesh, i, x, y, z, rx, ry, rz, sx, sy, sz) {
    E.set(rx, ry, rz); Q.setFromEuler(E);
    V.set(x, y, z); S.set(sx, sy, sz);
    M.compose(V, Q, S);
    mesh.setMatrixAt(i, M);
  }

  // ---- placement -----------------------------------------------------------

  function placeCluster(kind, cx, cz) {
    const y = world?.heightAt?.(cx, cz) ?? 0;
    const node = {
      id: nodes.length + 1, kind,
      position: new THREE.Vector3(cx, y, cz),
      def: KINDS[kind],
      label: KINDS[kind].label,
      ready: true, channel: 0, cool: 0, shake: 0, shakeSeed: rng.next() * 10,
      parts: [], berryIdx: [], patches: [],
    };

    if (kind === 'berry') {
      const n = rng.int(2, 4);
      for (let i = 0; i < n && bushN < MAX_BUSH; i++) {
        const a = rng.next() * Math.PI * 2, r = i === 0 ? 0 : rng.range(0.5, 1.35);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const gy = world?.heightAt?.(x, z) ?? 0;
        const s = rng.range(0.95, 1.35) * (i === 0 ? 1.22 : 1);
        const ry = rng.next() * 6.28;
        const idx = bushN++;
        const by0 = gy - s * 0.05;
        node.parts.push({ mesh: bushes, i: idx, x, y: by0, z, ry, s });
        setInst(bushes, idx, x, by0, z, 0, ry, 0, s, s * 0.96, s);
        // Ground-side patch, PER BUSH not per cluster. The widest lobe reaches 0.79 in
        // local units, so anything at or under s*0.79 is entirely roofed by the shrub and
        // moves no pixels at all; +0.30 m of skirt is the part a camera can actually see.
        node.patches.push({ x, z, r: s * 0.85 + 0.30, dark: 0.62 });
        // berries hung on the outside of the upper lobes, 6-10 per bush
        const nb = rng.int(6, 10);
        for (let b = 0; b < nb && berryN < MAX_BERRY; b++) {
          const ba = rng.next() * Math.PI * 2;
          const bel = rng.range(0.1, 0.95);
          const rr = s * (0.26 + 0.42 * Math.sqrt(Math.max(0, 1 - bel * bel)));
          const bx = x + Math.cos(ba) * rr;
          const bz = z + Math.sin(ba) * rr;
          const byy = by0 + s * (0.16 + bel * 0.7);
          const bi = berryN++;
          const sc = rng.range(0.85, 1.35);
          setInst(berries, bi, bx, byy, bz, 0, 0, 0, sc, sc, sc);
          berryCol.setHSL((rng.range(0.965, 1.015) + 1) % 1, rng.range(0.86, 0.98), rng.range(0.28, 0.4));
          berries.setColorAt(bi, berryCol);
          node.berryIdx.push({ i: bi, x: bx, y: byy, z: bz, s: sc, on: true });
        }
      }
    } else if (kind === 'wood') {
      const n = rng.int(3, 5);
      for (let i = 0; i < n && branchN < MAX_BRANCH; i++) {
        const a = rng.next() * Math.PI * 2, r = i === 0 ? 0 : rng.range(0.15, 0.72);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const gy = world?.heightAt?.(x, z) ?? 0;
        const idx = branchN++;
        const s = rng.range(0.75, 1.25);
        const ry = rng.next() * 6.28;
        const rz = rng.range(-0.16, 0.16);
        setInst(branches, idx, x, gy + 0.05 * s, z, rng.range(-0.1, 0.1), ry, rz, s, s, s);
        node.parts.push({ mesh: branches, i: idx, x, y: gy + 0.05 * s, z, ry, rz, s });
        // A stick is 0.95 m long and 9 cm thick, and the patch is a disc — so it is the
        // one family here where the patch is deliberately NARROWER than the prop's long
        // axis. A disc sized to the half-length would darken a 0.7 m circle of open grass
        // either side of a 9 cm twig, and 3-5 of them per cluster stack.
        node.patches.push({ x, z, r: s * 0.34 + 0.20, dark: 0.74 });
      }
    } else {
      const n = rng.int(2, 4);
      for (let i = 0; i < n && rockN < MAX_ROCK; i++) {
        const a = rng.next() * Math.PI * 2, r = i === 0 ? 0 : rng.range(0.4, 1.0);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        const gy = world?.heightAt?.(x, z) ?? 0;
        const s = rng.range(0.42, 0.95) * (i === 0 ? 1.3 : 1);
        const ry = rng.next() * 6.28;
        const idx = rockN++;
        setInst(rocks, idx, x, gy + s * 0.16, z, rng.range(-0.12, 0.12), ry, rng.range(-0.12, 0.12), s, s, s);
        node.parts.push({ mesh: rocks, i: idx, x, y: gy + s * 0.16, z, ry, s });
        // stone reaches 0.5*1.25*1.42 = 0.89 local at its widest, and it is the one prop
        // here with a hard edge against the ground, so the patch is tight and strong
        node.patches.push({ x, z, r: s * 0.80 + 0.26, dark: 0.58 });
      }
    }

    if (!node.parts.length) return null;
    nodes.push(node);
    return node;
  }

  // ---- ground-side contact occlusion ---------------------------------------
  //
  // The world owns the ground, so the world draws the patch; this system owns the props,
  // so it says where. `world.setContactPatches(tag, patches)` replaces the whole tagged
  // set, which is why this rebuilds the list wholesale rather than tracking deltas — it
  // runs once at populate and once per harvest, i.e. a few dozen times a session.
  //
  // Harvested wood and stone sink out of sight (see harvest()), so their patches have to
  // go with them or the vale is left with unexplained dark discs. Berry bushes stay put
  // when stripped — only the fruit leaves — so theirs never move.
  let contactDirty = false;
  let contactCount = 0;

  function syncContact() {
    contactDirty = false;
    if (!world?.setContactPatches) return 0;
    const list = [];
    for (const n of nodes) {
      if (!n.ready && n.kind !== 'berry') continue;
      for (const p of n.patches) list.push(p);
    }
    contactCount = world.setContactPatches('gatherables', list) ?? 0;
    return list.length;
  }

  function scatter(kind, count, near, radius) {
    let made = 0;
    // Berry thickets are allowed to sit closer together than anything else — a hedgerow of
    // two pockets six metres apart still reads as one pocket of berries, and the currency
    // needs to be somewhere the player can stumble into rather than navigate to.
    const sep = kind === 'berry' ? 6 : 8;
    for (let t = 0; t < count * 14 && made < count; t++) {
      const spot = world?.sampleSpawn?.(rng, { maxSlope: 0.26, near, radius });
      if (!spot) continue;
      // keep clusters apart so they read as pockets, not noise
      let tooClose = false;
      for (const n of nodes) {
        if (n.position.distanceToSquared({ x: spot.x, y: n.position.y, z: spot.z }) < sep * sep) { tooClose = true; break; }
      }
      if (tooClose) continue;
      if (placeCluster(kind, spot.x, spot.z)) made++;
    }
    return made;
  }

  return {
    nodes,
    kinds: KINDS,

    /**
     * Seed the world; call after the player AND the creatures exist.
     *
     * `grazing` is the list of places animals actually are. Berries go there. That is not
     * a convenience — it is the ecology the whole loop rests on: the creatures are near the
     * berries because they eat them, so the thing you need is always within sight of the
     * thing you want, and "I have run out" is a twenty-second detour rather than the end
     * of the session.
     */
    populate(playerPos, grazing = []) {
      if (playerPos) {
        scatter('berry', 7, playerPos, 44);
        scatter('wood', 3, playerPos, 52);
        scatter('stone', 2, playerPos, 58);
      }
      for (const p of grazing) scatter('berry', 1, p, 12);
      scatter('berry', 13);
      scatter('wood', 9);
      scatter('stone', 7);
      bushes.count = bushN; berries.count = berryN; rocks.count = rockN; branches.count = branchN;
      for (const m of [bushes, berries, rocks, branches]) m.instanceMatrix.needsUpdate = true;
      if (berries.instanceColor) berries.instanceColor.needsUpdate = true;
      syncContact();
      return nodes.length;
    },

    /** nearest harvestable node within reach of a position */
    nearest(pos, extra = 0, onlyReady = false) {
      let best = null, bd = Infinity;
      for (const n of nodes) {
        if (onlyReady && !n.ready) continue;
        const reach = n.def.reach + extra;
        const d = n.position.distanceToSquared(pos);
        if (d < reach * reach && d < bd) { bd = d; best = n; }
      }
      return best;
    },

    /** nearest node of a kind that currently has something on it, at any distance */
    nearestReadyOf(kind, pos) {
      let best = null, bd = Infinity;
      for (const n of nodes) {
        if (n.kind !== kind || !n.ready) continue;
        const d = n.position.distanceToSquared(pos);
        if (d < bd) { bd = d; best = n; }
      }
      return best ? { node: best, dist: Math.sqrt(bd) } : null;
    },

    beginGather(node) {
      if (!node || !node.ready || node.channel > 0) return false;
      node.channel = node.def.channel;
      node.shake = 1;
      return true;
    },

    cancelGather(node) {
      if (node && node.channel > 0) { node.channel = 0; node.shake = 0.35; }
    },

    /** advance channels + shake + regrowth. returns array of completed harvests */
    update(dt) {
      const done = [];
      for (const n of nodes) {
        if (n.channel > 0) {
          n.channel -= dt;
          n.shake = Math.min(1, n.shake + dt * 3.2);
          // steady drip of leaf motes while plucking
          if (fx && rng.next() < dt * 26) {
            fx.trail(
              { x: n.position.x + rng.range(-0.5, 0.5), y: n.position.y + rng.range(0.3, 0.9), z: n.position.z + rng.range(-0.5, 0.5) },
              n.kind === 'berry' ? 0xd8f0a0 : n.kind === 'wood' ? 0xc9a878 : 0xcfd6c8, 0.05, 0.4);
          }
          if (n.channel <= 0) {
            n.channel = 0;
            done.push(harvest(n));
          }
        }
        if (n.shake > 0 && n.channel <= 0) n.shake = Math.max(0, n.shake - dt * 2.6);
        if (n.shake > 0) animate(n);
        if (!n.ready) {
          n.cool -= dt;
          if (n.cool <= 0) regrow(n);
        }
      }
      if (contactDirty) syncContact();
      return done;
    },

    snapshot() {
      return {
        nodes: nodes.length,
        ready: nodes.filter((n) => n.ready).length,
        byKind: nodes.reduce((a, n) => (a[n.kind] = (a[n.kind] || 0) + 1, a), {}),
        readyBerry: nodes.filter((n) => n.kind === 'berry' && n.ready).length,
        harvested,
        // instrument: how many patches the world's contact field is carrying in total
        // once ours are folded in, so a probe can prove they registered
        contactPatches: contactCount,
        ownPatches: nodes.reduce((a, n) => a + ((n.ready || n.kind === 'berry') ? n.patches.length : 0), 0),
      };
    },
  };

  function animate(n) {
    const t = ctx.elapsed * 17 + n.shakeSeed * 7;
    const amp = n.shake * 0.075;
    for (const p of n.parts) {
      const wob = Math.sin(t + p.i * 1.7) * amp;
      const wob2 = Math.cos(t * 0.83 + p.i) * amp * 0.7;
      if (p.mesh === bushes) setInst(bushes, p.i, p.x + wob * 0.35, p.y + Math.abs(wob) * 0.2, p.z + wob2 * 0.35, wob, p.ry, wob2, p.s, p.s * 0.96 * (1 - n.shake * 0.05), p.s);
      else if (p.mesh === branches) setInst(branches, p.i, p.x, p.y + Math.abs(wob) * 0.4, p.z, wob * 0.5, p.ry, p.rz + wob2, p.s, p.s, p.s);
      else setInst(rocks, p.i, p.x + wob * 0.2, p.y, p.z + wob2 * 0.2, 0, p.ry, 0, p.s, p.s, p.s);
      p.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  function harvest(n) {
    const amount = rng.int(n.def.yieldMin, n.def.yieldMax);
    harvested++;
    n.ready = false;
    n.cool = n.def.regrow;
    n.shake = 1;
    // wood and stone sink out of the world when taken; their ground patches go too
    if (n.kind !== 'berry') contactDirty = true;

    const centre = n.position;
    if (n.kind === 'berry') {
      // pop the actual berries off the bush, one particle burst each
      const live = n.berryIdx.filter((b) => b.on);
      const take = live.slice(0, Math.max(amount, 3));
      for (const b of live) {
        b.on = false;
        setInst(berries, b.i, b.x, b.y, b.z, 0, 0, 0, 0.0001, 0.0001, 0.0001);
      }
      berries.instanceMatrix.needsUpdate = true;
      for (const b of take) {
        fx?.burst({ x: b.x, y: b.y, z: b.z }, {
          n: 5, color: 0xff5a7d, speed: 1.6, size: 0.075, life: 0.5, up: 1.5,
          debris: 2, debrisColor: 0xb8264a,
        });
      }
      fx?.burst({ x: centre.x, y: centre.y + 0.55, z: centre.z }, { n: 10, color: 0xffe2a0, speed: 1.5, size: 0.07, life: 0.55, up: 1.1, debris: 5, debrisColor: 0x4e6b2c, spread: 6 });
    } else if (n.kind === 'wood') {
      for (const p of n.parts) setInst(branches, p.i, p.x, p.y - 0.4, p.z, 0, p.ry, p.rz, 0.0001, 0.0001, 0.0001);
      branches.instanceMatrix.needsUpdate = true;
      fx?.burst({ x: centre.x, y: centre.y + 0.2, z: centre.z }, { n: 10, color: 0xe0c08a, speed: 1.9, size: 0.07, life: 0.5, up: 1.3, debris: 8, debrisColor: 0x6b4a2a, spread: 4 });
    } else {
      for (const p of n.parts) setInst(rocks, p.i, p.x, p.y - 0.5, p.z, 0, p.ry, 0, 0.0001, 0.0001, 0.0001);
      rocks.instanceMatrix.needsUpdate = true;
      fx?.burst({ x: centre.x, y: centre.y + 0.25, z: centre.z }, { n: 9, color: 0xdfe4d8, speed: 1.7, size: 0.075, life: 0.45, up: 1.2, debris: 9, debrisColor: 0x7c8378, spread: 4 });
    }

    fx?.ring(centre, { r0: 0.3, r1: 1.7, dur: 0.6, color: n.kind === 'berry' ? 0xffb3c4 : 0xffe0aa, opacity: 0.7 });
    return { node: n, kind: n.kind, item: n.def.item, amount, position: centre };
  }

  function regrow(n) {
    n.ready = true;
    n.shake = 0.5;
    if (n.kind !== 'berry') contactDirty = true;
    if (n.kind === 'berry') {
      for (const b of n.berryIdx) { b.on = true; setInst(berries, b.i, b.x, b.y, b.z, 0, 0, 0, b.s, b.s, b.s); }
      berries.instanceMatrix.needsUpdate = true;
    } else if (n.kind === 'wood') {
      for (const p of n.parts) setInst(branches, p.i, p.x, p.y, p.z, 0, p.ry, p.rz, p.s, p.s, p.s);
      branches.instanceMatrix.needsUpdate = true;
    } else {
      for (const p of n.parts) setInst(rocks, p.i, p.x, p.y, p.z, 0, p.ry, 0, p.s, p.s, p.s);
      rocks.instanceMatrix.needsUpdate = true;
    }
    fx?.ring(n.position, { r0: 0.2, r1: 1.1, dur: 0.8, color: 0xbfe89a, opacity: 0.35 });
  }
}
