import * as THREE from 'three';

/**
 * HABITAT PROPS — the things behaviour is *about*.
 *
 * A motion critic caught the previous build naming destinations that did not exist
 * ("the south-east lookout rock" over open grass). This module exists so that every
 * destination the AI can name is a mesh a screenshot can show.
 *
 * Two halves:
 *   scanScene()  — find real geometry already in the scene (trees, boulders, shrubs,
 *                  ruins) by decomposing InstancedMesh matrices. Nothing is assumed
 *                  about src/world/ beyond THREE's own object model, because that
 *                  directory is being rewritten by another agent.
 *   place*()     — build a prop where a kind is missing. Measured on this seed, the
 *                  starting meadow has ZERO trees and ZERO rocks inside 30 m of the
 *                  player, so this is the main path, not an edge case.
 *
 * Everything is deterministic: rng comes from ctx.rng.fork().
 */

// NOT .convertSRGBToLinear(). With three's colour management on (the default since r152)
// `new THREE.Color(hex)` ALREADY decodes the sRGB literal to linear, so converting again
// squares the transfer curve: 0x4f7331 lands at (0.007, 0.026, 0.002) instead of
// (0.078, 0.171, 0.030) — measured. That is why these props rendered as near-black
// lozenges and were the darkest thing in two of our comparison shots, in violation of
// the reference rule that shadows and foliage are never black.
// This is the second time this exact double-decode has appeared in the project; the
// first was linear values written into an sRGB-tagged canvas in world/materials.js.
const C = (hex) => new THREE.Color(hex);
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ───────────────────────────────────────────────── geometry helpers */

/** merge non-indexed geometries carrying position/normal/color */
function mergeGeos(list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    const p = g.attributes.position, m = g.attributes.normal, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      const k = (o + i) * 3;
      pos[k] = p.getX(i); pos[k + 1] = p.getY(i); pos[k + 2] = p.getZ(i);
      nor[k] = m.getX(i); nor[k + 1] = m.getY(i); nor[k + 2] = m.getZ(i);
      col[k] = c.getX(i); col[k + 1] = c.getY(i); col[k + 2] = c.getZ(i);
    }
    o += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/** give a geometry vertex colours around `hex`, with fbm variation */
function paint(g, hex, jitter, noise) {
  const p = g.attributes.position;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nm = g.attributes.normal;
  const base = C(hex);
  const arr = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const n = noise ? noise.fbm(p.getX(i) * 1.7 + 11, p.getZ(i) * 1.7 - 4, 3) : 0;
    // light the up-faces a touch so a flat-shaded blob still reads as volume
    const v = 1 + n * jitter + nm.getY(i) * 0.10;
    c.copy(base).multiplyScalar(clamp(v, 0.55, 1.5));
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function lambert() {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/* ───────────────────────────────────────────────── the props themselves */

/**
 * A faceted, stratified boulder. Same construction idea as the world's own rocks
 * (icosahedron, banded in Y, fbm-swollen) so it sits next to them without reading
 * as a different artist's work.
 */
function boulderGeometry(rng, noise, r) {
  const g = new THREE.IcosahedronGeometry(r, 1).toNonIndexed();
  const p = g.attributes.position;
  const sx = rng.range(0.85, 1.30), sy = rng.range(0.62, 0.95), sz = rng.range(0.85, 1.30);
  const ph = rng.range(0, 10);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // `- ph` before the rescale: without it the phase that decorrelates the banding
    // becomes a translation and lifts the whole boulder by 0.45*ph*r — see the long note
    // in src/world/props.js, which had the identical bug. The origin stays grounded, so
    // nothing in object space flags it; only the geometry bounding box does.
    const band = (Math.round((y / r + ph) * 2.6) / 2.6 - ph) * r;
    y = y + (band - y) * 0.45;
    const d = 1 + 0.26 * noise.fbm(x * 2.1 + ph, z * 2.1 - ph, 3);
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sz);
  }
  g.computeVertexNormals();
  return paint(g, 0x9b978a, 0.22, noise);
}

function placeBoulder(ctx, world, rng, x, z) {
  const r = rng.range(1.05, 1.75);
  const parts = [boulderGeometry(rng, ctx.noise, r)];
  // a smaller shoulder stone so the silhouette is not one egg
  const sr = r * rng.range(0.35, 0.55);
  const sg = boulderGeometry(rng, ctx.noise, sr);
  const sa = rng.range(0, TAU);
  sg.translate(Math.cos(sa) * r * 0.95, -r * 0.18, Math.sin(sa) * r * 0.95);
  parts.push(sg);
  const mesh = new THREE.Mesh(mergeGeos(parts), lambert());
  const y = world.heightAt(x, z);
  mesh.position.set(x, y - r * 0.26, z);
  mesh.rotation.y = rng.range(0, TAU);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'ai:boulder';
  ctx.scene.add(mesh);
  return { kind: 'boulder', name: 'the mossy boulder', pos: new THREE.Vector3(x, y, z), radius: r * 1.15, height: r * 1.3, mesh, source: 'ai' };
}

/** A fallen log: something to browse along, shelter beside and step over. */
function placeLog(ctx, world, rng, x, z) {
  const len = rng.range(3.4, 5.0);
  const r0 = rng.range(0.30, 0.42);
  const parts = [];
  const trunk = new THREE.CylinderGeometry(r0 * 0.78, r0, len, 9, 3).toNonIndexed();
  // taper + sag so it is not an extruded pipe
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const t = tp.getY(i) / len + 0.5;
    const bend = Math.sin(t * Math.PI) * r0 * 0.5;
    tp.setXYZ(i, tp.getX(i) * (1 + 0.10 * Math.sin(t * 9)), tp.getY(i), tp.getZ(i) + bend * 0.4);
  }
  trunk.computeVertexNormals();
  trunk.rotateZ(Math.PI / 2);
  parts.push(paint(trunk, 0x6d5a44, 0.26, ctx.noise));

  // two snapped branch stubs
  for (let i = 0; i < 2; i++) {
    const br = new THREE.CylinderGeometry(0.07, 0.13, rng.range(0.7, 1.2), 6, 1).toNonIndexed();
    br.rotateZ(rng.range(0.5, 1.1) * (i ? 1 : -1));
    br.rotateY(rng.range(0, TAU));
    br.translate(rng.range(-len * 0.35, len * 0.35), r0 * 0.6, rng.range(-0.2, 0.2));
    br.computeVertexNormals();
    parts.push(paint(br, 0x5f4e3b, 0.22, ctx.noise));
  }
  // a mossy cap along the top
  const moss = new THREE.CylinderGeometry(r0 * 0.66, r0 * 0.72, len * 0.7, 8, 1, true).toNonIndexed();
  moss.rotateZ(Math.PI / 2);
  moss.translate(0, r0 * 0.42, 0);
  moss.computeVertexNormals();
  parts.push(paint(moss, 0x5c7a35, 0.30, ctx.noise));

  const mesh = new THREE.Mesh(mergeGeos(parts), lambert());
  const y = world.heightAt(x, z);
  mesh.position.set(x, y + r0 * 0.72, z);
  mesh.rotation.y = rng.range(0, TAU);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'ai:log';
  ctx.scene.add(mesh);
  return {
    kind: 'log', name: 'the fallen log', pos: new THREE.Vector3(x, y, z),
    radius: 0.85, height: r0 * 1.6, axis: mesh.rotation.y, length: len, mesh, source: 'ai',
  };
}

/** A low leafy thicket — browse, and the nearest thing to shade in an open meadow. */
function placeThicket(ctx, world, rng, x, z) {
  const parts = [];
  const n = rng.int(3, 4);
  let rad = 0;
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.55, 0.95);
    const g = new THREE.IcosahedronGeometry(r, 1).toNonIndexed();
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const d = 1 + 0.30 * ctx.noise.fbm(p.getX(k) * 2.6 + i * 7, p.getZ(k) * 2.6, 3);
      p.setXYZ(k, p.getX(k) * d, p.getY(k) * d * 0.82, p.getZ(k) * d);
    }
    g.computeVertexNormals();
    const a = (i / n) * TAU + rng.range(-0.5, 0.5);
    const rr = i === 0 ? 0 : rng.range(0.4, 0.85);
    g.translate(Math.cos(a) * rr, r * 0.62 + rng.range(-0.1, 0.15), Math.sin(a) * rr);
    rad = Math.max(rad, rr + r);
    parts.push(paint(g, i % 2 ? 0x4f7331 : 0x5d8038, 0.30, ctx.noise));
  }
  const mesh = new THREE.Mesh(mergeGeos(parts), lambert());
  const y = world.heightAt(x, z);
  mesh.position.set(x, y - 0.12, z);
  mesh.rotation.y = rng.range(0, TAU);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.name = 'ai:thicket';
  ctx.scene.add(mesh);
  return { kind: 'thicket', name: 'the thicket', pos: new THREE.Vector3(x, y, z), radius: rad * 0.95, height: 1.3, mesh, source: 'ai' };
}

/**
 * A stone-ringed spring. The lake is 170 m away on this seed, so without one of these
 * "drinking" is a state no screenshot can ever show. Only ever placed on ground flat
 * enough that a level disc reads as water sitting in a dip.
 */
function placePuddle(ctx, world, rng, x, z) {
  const r = rng.range(1.5, 2.1);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const h = world.heightAt(x + Math.cos(a) * r * 0.8, z + Math.sin(a) * r * 0.8);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  const c = world.heightAt(x, z);
  lo = Math.min(lo, c); hi = Math.max(hi, c);
  if (!Number.isFinite(lo) || hi - lo > 0.42) return null;      // too lumpy to fake a pool

  const group = new THREE.Group();
  group.name = 'ai:spring';

  // wet mud shelf, following the ground so nothing z-fights
  const shelf = new THREE.CircleGeometry(r * 1.32, 26).toNonIndexed();
  shelf.rotateX(-Math.PI / 2);
  const sp = shelf.attributes.position;
  for (let i = 0; i < sp.count; i++) {
    const px = sp.getX(i), pz = sp.getZ(i);
    const d = Math.hypot(px, pz) / (r * 1.32);
    sp.setY(i, world.heightAt(x + px, z + pz) - lo + 0.012 - (1 - d) * 0.10);
  }
  shelf.computeVertexNormals();
  group.add(new THREE.Mesh(paint(shelf, 0x54452f, 0.20, ctx.noise), lambert()));

  // the water itself: flat, slightly sunk, so the rim of the dip crops it naturally
  const disc = new THREE.CircleGeometry(r, 28);
  disc.rotateX(-Math.PI / 2);
  const wm = new THREE.MeshLambertMaterial({
    color: C(0x3d757c), transparent: true, opacity: 0.86, depthWrite: false,
  });
  const water = new THREE.Mesh(disc, wm);
  water.position.y = 0.055;
  water.renderOrder = 1;
  group.add(water);

  // a ring of stones, so it reads as a spring rather than a decal
  const stones = [];
  const sn = rng.int(9, 14);
  for (let i = 0; i < sn; i++) {
    const a = (i / sn) * TAU + rng.range(-0.16, 0.16);
    const sr = rng.range(0.14, 0.30);
    const g = boulderGeometry(rng, ctx.noise, sr);
    const rr = r * rng.range(1.02, 1.22);
    g.translate(Math.cos(a) * rr, world.heightAt(x + Math.cos(a) * rr, z + Math.sin(a) * rr) - lo - sr * 0.35, Math.sin(a) * rr);
    stones.push(g);
  }
  const sm = new THREE.Mesh(mergeGeos(stones), lambert());
  sm.castShadow = true; sm.receiveShadow = true;
  group.add(sm);

  group.position.set(x, lo, z);
  ctx.scene.add(group);
  return {
    kind: 'water', name: 'the spring', pos: new THREE.Vector3(x, lo, z),
    radius: r, height: 0.1, surfaceY: lo + 0.055, mesh: group, source: 'ai',
  };
}

export const PLACERS = { boulder: placeBoulder, log: placeLog, thicket: placeThicket, water: placePuddle };

/* ───────────────────────────────────────────────── scanning what exists */

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Classify real scene geometry by SHAPE, not by name — nothing in src/world/ is named,
 * and that file is being rewritten while this runs. Height and squatness are stable
 * facts about a mesh no matter who authored it.
 */
function classify(h, w, geoType) {
  if (h < 0.75) return null;                              // grass, flowers, pebbles, berries
  if (h >= 2.8 && h >= w * 0.75) return 'tree';
  if (/Icosahedron/.test(geoType) && h >= 0.8) return 'boulder';
  if (h < 2.8) return 'thicket';
  return null;
}

/** Real props within `radius` of `centre`. Cheap enough to run once at boot. */
export function scanScene(ctx, centre, radius) {
  const found = [];
  const r2 = radius * radius;
  ctx.scene.traverse((o) => {
    if (o.isInstancedMesh) {
      // dynamic scatter fields (grass) and shadow decals are not props
      if (o.parent?.name === 'grass' || o.count > 900 || o.count === 0) return;
      if (o.geometry?.type === 'PlaneGeometry') return;
      const g = o.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
      if (!Number.isFinite(sy)) return;
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, _m); _m.decompose(_p, _q, _s);
        const dx = _p.x - centre.x, dz = _p.z - centre.z;
        if (dx * dx + dz * dz > r2) continue;
        const h = sy * _s.y, w = Math.max(sx * _s.x, sz * _s.z);
        const kind = classify(h, w, g.type);
        if (!kind) continue;
        found.push({
          kind, source: 'world',
          name: kind === 'tree' ? 'the tree' : kind === 'boulder' ? 'the boulder' : 'the shrub',
          pos: new THREE.Vector3(_p.x, _p.y, _p.z),
          radius: Math.max(0.45, w * 0.5), height: h,
        });
      }
    } else if (o.isMesh && !o.isInstancedMesh) {
      // large hand-placed masonry (the ruins) — big, opaque, vertex-coloured, near the ground
      if (!o.geometry?.boundingSphere) o.geometry?.computeBoundingSphere?.();
      const bs = o.geometry?.boundingSphere;
      if (!bs) return;
      if (o.name || o.parent?.name === 'landmarks') return;
      if (!o.material?.vertexColors) return;
      if (bs.radius < 3 || bs.radius > 22) return;
      const dx = o.position.x - centre.x, dz = o.position.z - centre.z;
      if (dx * dx + dz * dz > r2) return;
      found.push({
        kind: 'ruin', source: 'world', name: 'the old ruin',
        pos: new THREE.Vector3(o.position.x, o.position.y, o.position.z),
        radius: bs.radius * 0.55, height: bs.radius,
      });
    }
  });
  return found;
}

/** A standable point on the actual lake shore, or null if the lake is out of reach. */
export function lakeShore(world, from, maxDist) {
  const lake = world?.landmarks?.lake;
  if (!lake || !Number.isFinite(lake.x)) return null;
  const dx = from.x - lake.x, dz = from.z - lake.z;
  const d = Math.hypot(dx, dz) || 1;
  // walk in from outside along the line of approach until the ground drops under water
  const ux = dx / d, uz = dz / d;
  let shore = null;
  for (let t = lake.r + 16; t > 2; t -= 0.5) {
    const x = lake.x + ux * t, z = lake.z + uz * t;
    const h = world.heightAt(x, z);
    if (h <= world.waterLevel + 0.35) { shore = { x: lake.x + ux * (t + 1.1), z: lake.z + uz * (t + 1.1) }; break; }
  }
  if (!shore) return null;
  if (Math.hypot(shore.x - from.x, shore.z - from.z) > maxDist) return null;
  return {
    kind: 'water', source: 'world', name: 'the lake shore',
    pos: new THREE.Vector3(shore.x, world.heightAt(shore.x, shore.z), shore.z),
    radius: 1.4, height: 0.1, surfaceY: world.waterLevel,
  };
}
