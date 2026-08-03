import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './util.js';
import { mergeGeos, paint, makeAerialMaterial, applyMossShader, setAerialPivot } from './materials.js';
import { AX, AZ, PX, PZ, LAKE } from './terrain.js';

const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();
const toWorld = (u, v) => [u * AX + v * PX, u * AZ + v * PZ];

/* ================================================================= ROCKS ====== */

function rockGeometry(rng, noise, detail = 1) {
  const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const p = g.attributes.position;
  const sx = rng.range(0.75, 1.4), sy = rng.range(0.5, 0.95), sz = rng.range(0.75, 1.4);
  const ph = rng.range(0, 10);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // stratified: flatten in y and cut faceted steps so it reads as rock, not a potato
    const band = Math.round((y + ph) * 2.6) / 2.6;
    y = lerp(y, band, 0.45);
    const d = 1 + 0.30 * noise.fbm(x * 2.1 + ph, z * 2.1 - ph, 3) + 0.16 * noise.fbm(y * 3.4, x * 3.4, 2);
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sz);
  }
  g.computeVertexNormals();
  const n = p.count;
  const arr = new Float32Array(n * 3);
  const a = C(0x8e8e85), b = C(0xa9a597), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const t = clamp(0.5 + 0.5 * noise.fbm(p.getX(i) * 1.4, p.getZ(i) * 1.4, 2), 0, 1);
    c.copy(a).lerp(b, t);
    const v = 0.86 + 0.28 * t;
    arr[i * 3] = c.r * v; arr[i * 3 + 1] = c.g * v; arr[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

export function createRocks(ctx, T, rng) {
  const noise = ctx.noise;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  applyMossShader(mat, 0x6b8a3a, { amount: 1.0 });

  const smallGeos = [];
  for (let i = 0; i < 4; i++) smallGeos.push(rockGeometry(rng, noise, 0));
  const bigGeos = [];
  for (let i = 0; i < 3; i++) bigGeos.push(rockGeometry(rng, noise, 1));

  const lists = [...smallGeos, ...bigGeos].map(() => []);
  const q = clamp(ctx.quality.grassDensity ?? 1, 0.35, 1.5);

  // scattered pebbles and stones, favouring slopes and worn ground
  const nSmall = Math.round(560 * q);
  for (let i = 0; i < nSmall * 2; i++) {
    if (lists.slice(0, 4).reduce((a, b) => a + b.length, 0) >= nSmall) break;
    const a = rng.next() * Math.PI * 2;
    const r = 6 + Math.sqrt(rng.next()) * 330;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = T.heightAt(x, z);
    if (y < T.waterLevel - 0.4) continue;
    const sl = T.slopeAt(x, z);
    const bias = 0.18 + sl * 1.6 + T.dirtAt(x, z) * 0.5;
    if (rng.next() > clamp(bias, 0, 1)) continue;
    lists[rng.int(0, 3)].push({ x, y, z, s: rng.range(0.16, 0.85), rot: rng.next() * Math.PI * 2, tilt: rng.range(0, 0.3) });
  }
  // boulders — bigger, rarer, clumped near cliffs and the shoreline
  const nBig = Math.round(90 * q);
  for (let i = 0; i < nBig * 4; i++) {
    if (lists.slice(4).reduce((a, b) => a + b.length, 0) >= nBig) break;
    const a = rng.next() * Math.PI * 2;
    const r = 14 + Math.sqrt(rng.next()) * 330;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = T.heightAt(x, z);
    if (y < T.waterLevel - 1.5) continue;
    const sl = T.slopeAt(x, z);
    const nearLake = smoothstep(LAKE.r + 22, LAKE.r - 4, Math.hypot(x - LAKE.x, z - LAKE.z));
    const bias = 0.06 + sl * 1.5 + nearLake * 0.45;
    if (rng.next() > clamp(bias, 0, 1)) continue;
    lists[4 + rng.int(0, 2)].push({ x, y, z, s: rng.range(1.2, 4.6), rot: rng.next() * Math.PI * 2, tilt: rng.range(0, 0.22) });
  }

  const geos = [...smallGeos, ...bigGeos];
  const meshes = [];
  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const e = new THREE.Euler();
  let count = 0;
  for (let i = 0; i < geos.length; i++) {
    const list = lists[i];
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(geos[i], mat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let k = 0; k < list.length; k++) {
      const p = list[k];
      e.set(p.tilt * rng.range(-1, 1), p.rot, p.tilt * rng.range(-1, 1));
      qt.setFromEuler(e);
      m4.compose({ x: p.x, y: p.y - p.s * 0.30, z: p.z }, qt, { x: p.s, y: p.s, z: p.s });
      mesh.setMatrixAt(k, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);
    count += list.length;
  }
  return { meshes, count, material: mat };
}

/* ================================================================= RUINS ====== */

/** a small mossy stone ruin — the pw_15 backdrop, and the thing that makes the
 *  meadow read as "somewhere with a history" rather than a noise field. */
export function createRuin(ctx, T, rng, cx, cz, scale = 1) {
  const noise = ctx.noise;
  const parts = [];
  const stone = [0xa8a294, 0x9a9488, 0xb3ac9c];

  const block = (w, h, d, x, y, z, ry, tilt = 0) => {
    const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1).toNonIndexed();
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i,
        p.getX(i) * (1 + 0.05 * noise.fbm(p.getY(i) * 3 + x, p.getZ(i) * 3, 2)),
        p.getY(i) * (1 + 0.03 * noise.fbm(p.getX(i) * 3, p.getZ(i) * 3 + z, 2)),
        p.getZ(i) * (1 + 0.05 * noise.fbm(p.getX(i) * 3 - z, p.getY(i) * 3, 2)));
    }
    g.computeVertexNormals();
    g.rotateZ(tilt);
    g.rotateY(ry);
    g.translate(x, y, z);
    return paint(g, stone[rng.int(0, 2)], 0.09, noise);
  };

  const baseY = T.heightAt(cx, cz);
  const rot = rng.next() * Math.PI * 2;
  // two standing columns + a fallen lintel + rubble
  const colH = 4.6 * scale;
  for (let i = 0; i < 2; i++) {
    const sx = (i ? 1 : -1) * 1.9 * scale;
    let y = 0;
    const courses = 5;
    for (let k = 0; k < courses; k++) {
      const hgt = colH / courses;
      const w = 1.15 * scale * (1 - k * 0.05);
      parts.push(block(w, hgt * 0.97, w, sx + rng.range(-0.06, 0.06), y + hgt / 2, rng.range(-0.06, 0.06), rng.range(-0.1, 0.1), rng.range(-0.02, 0.02)));
      y += hgt;
      if (i === 1 && k === 3) break; // one column is broken
    }
  }
  // lintel across the top of the taller column, half collapsed
  parts.push(block(4.6 * scale, 0.8 * scale, 1.15 * scale, -0.6 * scale, colH + 0.35 * scale, 0, 0.06, -0.05));
  // fallen block on the ground
  parts.push(block(2.2 * scale, 0.75 * scale, 1.1 * scale, 3.1 * scale, 0.30 * scale, 1.5 * scale, 0.9, 0.08));
  parts.push(block(1.4 * scale, 0.55 * scale, 1.0 * scale, -3.0 * scale, 0.22 * scale, -1.8 * scale, 2.1, -0.12));
  // low broken wall stub
  for (let k = 0; k < 5; k++) {
    parts.push(block(1.25 * scale, 0.55 * scale, 0.85 * scale, -2.4 * scale + k * 1.28 * scale, 0.26 * scale + (k % 2) * 0.5 * scale, -3.6 * scale, rng.range(-0.08, 0.08)));
  }

  const geo = mergeGeos(parts);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  applyMossShader(mat, 0x62823a, { amount: 1.15 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.y = rot;
  mesh.position.set(cx, baseY - 0.35, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ================================================================= WATER ====== */

export function createWater(ctx, T) {
  const R = LAKE.r + 14;
  const SEG = 84;
  const geo = new THREE.PlaneGeometry(R * 2, R * 2, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  const depth = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + LAKE.x, z = p.getZ(i) + LAKE.z;
    depth[i] = T.waterLevel - T.heightAt(x, z);
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uDeep: { value: new THREE.Color(0x1d4a52).convertSRGBToLinear() },
        uShallow: { value: new THREE.Color(0x5fa9a8).convertSRGBToLinear() },
        uSky: { value: new THREE.Color(0xbcd8f0).convertSRGBToLinear() },
        uSun: { value: new THREE.Vector3(0.3, 0.8, 0.3) },
        uSunCol: { value: new THREE.Color(0xffffff) },
      },
    ]),
    vertexShader: /* glsl */`
      #include <fog_pars_vertex>
      attribute float aDepth;
      varying float vDepth; varying vec3 vW;
      void main() {
        vDepth = aDepth;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        vec4 mvPosition = viewMatrix * w;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <fog_pars_fragment>
      uniform float uTime; uniform vec3 uDeep, uShallow, uSky, uSun, uSunCol;
      varying float vDepth; varying vec3 vW;
      void main() {
        if (vDepth < 0.02) discard;
        // two crossing ripple trains -> analytic normal
        vec2 q1 = vW.xz * 0.32 + vec2(uTime * 0.22, uTime * 0.11);
        vec2 q2 = vW.xz * 0.71 + vec2(-uTime * 0.16, uTime * 0.27);
        float amp = 0.045;
        vec3 n = normalize(vec3(
          -(cos(q1.x + q1.y) * amp + cos(q2.x - q2.y * 1.4) * amp * 0.6),
          1.0,
          -(cos(q1.x + q1.y) * amp + -cos(q2.x - q2.y * 1.4) * amp * 0.6)));
        vec3 V = normalize(cameraPosition - vW);
        float fres = pow(1.0 - clamp(dot(V, n), 0.0, 1.0), 3.4);
        float shallow = 1.0 - clamp(vDepth / 3.4, 0.0, 1.0);
        vec3 body = mix(uDeep, uShallow, shallow * shallow);
        vec3 col = mix(body, uSky, clamp(0.18 + fres * 0.82, 0.0, 1.0));
        // sun glint
        vec3 H = normalize(normalize(uSun) + V);
        col += uSunCol * pow(max(dot(n, H), 0.0), 220.0) * 1.6;
        // shoreline lightening + a thin foam line
        float edge = smoothstep(1.1, 0.05, vDepth);
        col = mix(col, uShallow * 1.25, edge * 0.55);
        float foam = smoothstep(0.30, 0.10, vDepth) * smoothstep(0.02, 0.10, vDepth);
        col = mix(col, vec3(0.95), foam * 0.5);
        float alpha = smoothstep(0.02, 0.45, vDepth) * (0.72 + fres * 0.28);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(LAKE.x, T.waterLevel, LAKE.z);
  mesh.renderOrder = 2;
  mesh.name = 'water';
  return { mesh, material: mat };
}

/* =============================================================== MOTES ======== */

/**
 * Night motes — drifting warm points of light over the meadow.
 *
 * The dusk frame is the weakest thing we render: 1.7 local contrast and 146 distinct
 * colours against pw_16's 5.2 and 422. The difference is not exposure — both frames
 * average 50 — it is that pw_16 is a DARK frame with warm practical lights in it,
 * while ours is a flat blue multiply over a daylight image. Reference observation for
 * `dusk_mood` is explicit: "does the world hold up when the sun is not doing the work
 * for you", and pw_16 answers it with lanterns.
 *
 * We have no village to hang lanterns on, so the practicals are the fauna: slow warm
 * motes at knee-to-head height. One additively blended draw call, no lights, no
 * shadow cost. They are keyed entirely off the sky's night amount so they are exactly
 * invisible in all five daylight shots.
 */
export function createMotes(ctx, T, rng) {
  const N = Math.round(360 * clamp(ctx.quality.grassDensity ?? 1, 0.4, 1.5));
  const geo = new THREE.PlaneGeometry(1, 1);
  const uniforms = { uAmt: { value: 0 }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: /* glsl */`
      uniform float uTime; uniform float uAmt;
      attribute vec3 aSeed;
      varying vec2 vUvM; varying vec3 vTint; varying float vPulse;
      void main() {
        vUvM = uv;
        vTint = instanceColor;
        // each mote breathes on its own phase; a field that pulses in unison reads
        // as an effect, a field that does not reads as insects
        float ph = aSeed.z * 6.2831;
        vPulse = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.7 + aSeed.x * 1.1) + ph));
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        // slow lateral drift and a lazy vertical bob
        mv.x += sin(uTime * (0.16 + aSeed.x * 0.12) + ph) * 0.9;
        mv.y += sin(uTime * (0.23 + aSeed.y * 0.14) + ph * 1.7) * 0.45;
        float s = length(instanceMatrix[0].xyz) * (0.55 + 0.75 * vPulse);
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uAmt;
      varying vec2 vUvM; varying vec3 vTint; varying float vPulse;
      void main() {
        float d = length(vUvM - 0.5) * 2.0;
        if (d > 1.0) discard;
        // hot core, wide soft halo — a point practical, not a sprite disc
        float core = pow(1.0 - clamp(d, 0.0, 1.0), 6.0);
        float halo = pow(1.0 - clamp(d, 0.0, 1.0), 2.0) * 0.30;
        vec3 c = vTint * (core * 4.2 + halo * 1.4);
        gl_FragColor = vec4(c * uAmt * vPulse, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });

  const seeds = new Float32Array(N * 3);
  const mesh = new THREE.InstancedMesh(geo, mat, N);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.name = 'motes';

  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const col = new THREE.Color();
  // amber, honey and a few cool green ones so the field is not one hue
  const TINTS = [0xffc46a, 0xffb04a, 0xffd894, 0xbfe07a];
  let n = 0;
  for (let i = 0; i < N * 4 && n < N; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = 3 + Math.sqrt(rng.next()) * 78;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const gy = T.heightAt(x, z);
    if (gy < T.waterLevel + 0.4) continue;
    if (T.slopeAt(x, z) > 0.42) continue;
    const y = gy + 0.35 + Math.pow(rng.next(), 1.7) * 2.3;
    const s = rng.range(0.16, 0.38);
    m4.compose({ x, y, z }, qt, { x: s, y: s, z: s });
    mesh.setMatrixAt(n, m4);
    col.setHex(TINTS[rng.int(0, TINTS.length - 1)]).multiplyScalar(rng.range(0.7, 1.35));
    mesh.setColorAt(n, col);
    seeds[n * 3] = rng.next(); seeds[n * 3 + 1] = rng.next(); seeds[n * 3 + 2] = rng.next();
    n++;
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));

  return {
    mesh, count: n,
    update(elapsed, nightAmt) {
      uniforms.uTime.value = elapsed;
      uniforms.uAmt.value = nightAmt;
      mesh.visible = nightAmt > 0.004;
    },
  };
}

/* =========================================================== LANDMARKS ======== */

/**
 * The 1–3 km silhouettes required by reference observation #7. These use the aerial
 * material (fog off, haze capped) so they never dissolve completely into the sky.
 */
export function createLandmarks(ctx, T, rng) {
  const noise = ctx.noise;
  const group = new THREE.Group();
  group.name = 'landmarks';
  const mats = [];

  // ---- mesa / plateau silhouettes, mostly arrayed around the vista axis ----
  const parts = [];
  const specs = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const spreadA = (i / (N - 1) - 0.5) * 2.4;          // radians off the vista axis
    const ang = Math.atan2(AZ, AX) + spreadA + rng.range(-0.18, 0.18);
    const dist = rng.range(1250, 2750);
    specs.push({ ang, dist, h: rng.range(240, 560), r: rng.range(180, 420) });
  }
  for (const s of specs) {
    const x = Math.cos(s.ang) * s.dist, z = Math.sin(s.ang) * s.dist;
    // ------------------------------------------------------------------
    // The far ranges read as "flat paper cutouts: single-facet white silhouettes,
    // no rock striation, no snow line, no shading break" in every wide frame.
    // Two causes, both here: 12 segments over a 400 m plateau put a polygon edge
    // every 30 degrees of silhouette, and the vertex colour was a pure function of
    // height (0.82 + 0.24 t) — literally a vertical gradient with no rock in it.
    //
    // 22 x 9 costs ~400 triangles per mesa (9 mesas = 3.6k, one draw call) and the
    // colour now carries horizontal bedrock courses, a broken snow line and a
    // large-scale light/dark shoulder, all sized against the measured sd of
    // noise.fbm (0.20, centred on 0) rather than assumed to be 0..1.
    // ------------------------------------------------------------------
    const seg = 22, rings = 9;
    const verts = [], cols = [], idx = [];
    const c = new THREE.Color();
    const ROCK = new THREE.Color(0xf2f4f6);
    const WARM = new THREE.Color(0xf7f0e4);
    const SNOW = new THREE.Color(0xffffff);
    for (let ri = 0; ri <= rings; ri++) {
      const t = ri / rings;
      // stepped, near-vertical sided plateau
      const rr = s.r * (1 - Math.pow(t, 2.4) * 0.72) * (1 - t * 0.06);
      const yy = s.h * Math.pow(t, 0.72);
      for (let si = 0; si <= seg; si++) {
        const a = (si / seg) * Math.PI * 2;
        const wob = 1 + 0.22 * noise.fbm(Math.cos(a) * 2 + s.ang * 3, Math.sin(a) * 2 - t * 2, 2);
        const px = x + Math.cos(a) * rr * wob, pz = z + Math.sin(a) * rr * wob;
        verts.push(px, yy - 20, pz);
        // horizontal courses: a function of HEIGHT only, so they wrap the mesa the
        // way sedimentary bands do instead of blotching it
        const band = noise.fbm(yy * 0.035 + s.ang * 7, yy * 0.011 + 4.4, 3);
        // which face of the mesa this is — puts a lit shoulder and a shaded one on
        // the same rock, which is the shading break the silhouette was missing
        const face = noise.fbm(Math.cos(a) * 1.4 + s.ang * 5, Math.sin(a) * 1.4 - 2.2, 2);
        const snowT = Math.max(0, Math.min(1, (yy - (s.h * 0.62 + band * 90)) / (s.h * 0.3)));
        c.copy(ROCK).lerp(WARM, Math.max(0, Math.min(1, 0.5 + face * 1.5)));
        c.lerp(SNOW, snowT * 0.85);
        const v = (0.80 + 0.20 * t) * (1 + 0.42 * band + 0.30 * face) * (1 - snowT * 0.05);
        cols.push(c.r * v, c.g * v, c.b * v);
      }
    }
    const row = seg + 1;
    for (let ri = 0; ri < rings; ri++) {
      for (let si = 0; si < seg; si++) {
        const a = ri * row + si, b = a + 1, d = a + row, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    parts.push(g.toNonIndexed());
  }

  // ---- two leaning monolith slabs (the pw_11 / pw_02 signature) ----
  for (let i = 0; i < 3; i++) {
    const ang = Math.atan2(AZ, AX) + rng.range(-0.75, 0.75);
    const dist = rng.range(900, 1700);
    const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
    const L = rng.range(300, 520), W = rng.range(60, 110), Tk = rng.range(38, 70);
    const g = new THREE.BoxGeometry(W, L, Tk, 1, 4, 1).toNonIndexed();
    const p = g.attributes.position;
    for (let k = 0; k < p.count; k++) {
      const yy = p.getY(k) / L + 0.5;
      p.setX(k, p.getX(k) * (1 - yy * 0.35));
      p.setZ(k, p.getZ(k) * (1 - yy * 0.25));
    }
    g.computeVertexNormals();
    g.rotateZ(rng.range(0.35, 0.75) * (rng.bool() ? 1 : -1));
    g.rotateY(rng.next() * Math.PI);
    g.translate(x, L * 0.30, z);
    parts.push(paint(g, 0xb9bcc0));
  }

  const mesaMat = makeAerialMaterial({ color: 0x9aa7ad, maxHaze: 0.855, desat: 0.60, form: 0.80 });
  mats.push(mesaMat);
  const mesaGeo = mergeGeos(parts);
  setAerialPivot(mesaMat, mesaGeo);
  const mesa = new THREE.Mesh(mesaGeo, mesaMat);
  mesa.frustumCulled = false;
  group.add(mesa);

  // ---- mid-distance ruined tower: the man-made landmark every wide Palworld shot has ----
  const towerParts = [];
  const [tx, tz] = toWorld(620, 40);
  const ty = T.analytic(tx, tz);
  let y = 0;
  const courses = 22;
  for (let i = 0; i < courses; i++) {
    const t = i / courses;
    const w = lerp(17, 8.5, t) * (1 - Math.pow(t, 3) * 0.3);
    const hgt = 3.4;
    // top few courses are broken away on one side
    const broken = t > 0.80 ? (i % 2 === 0 ? 0.5 : 0.85) : 1;
    const g = new THREE.BoxGeometry(w, hgt * 0.97, w * broken, 1, 1, 1);
    g.translate(0, y + hgt / 2, w * (1 - broken) * -0.5);
    g.rotateY(t * 0.25);
    towerParts.push(paint(g, 0xffffff));
    y += hgt;
  }
  const buttressA = new THREE.BoxGeometry(5, 26, 5).translate(11, 13, 0);
  towerParts.push(paint(buttressA, 0xffffff));
  const buttressB = new THREE.BoxGeometry(5, 18, 5).translate(-10, 9, 4);
  towerParts.push(paint(buttressB, 0xffffff));
  const towerMat = makeAerialMaterial({ color: 0x9d9c95, maxHaze: 0.80, desat: 0.5 });
  mats.push(towerMat);
  const towerGeo = mergeGeos(towerParts);
  setAerialPivot(towerMat, towerGeo);
  const tower = new THREE.Mesh(towerGeo, towerMat);
  tower.position.set(tx, ty - 3, tz);
  tower.frustumCulled = false;
  group.add(tower);

  return { group, mats, tower: { x: tx, z: tz } };
}
