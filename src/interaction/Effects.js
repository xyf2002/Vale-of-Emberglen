import * as THREE from 'three';

/**
 * INTERACTION FX — every verb in this system needs a physical, wordless "that happened"
 * moment. This module owns all of them: particle bursts, emote bubbles above a
 * creature's head, floating pickup counters, ground ring pulses, and the trust gauge.
 *
 * All assets are generated in code (canvas textures, shader points). No external files.
 * Everything is pooled and allocated once at init so the update loop never garbage-
 * collects mid-frame.
 */

const POINT_VS = /* glsl */`
attribute float aSize;
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vCol;
varying float vAlpha;
void main() {
  vCol = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (500.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FS = /* glsl */`
varying vec3 vCol;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float a = smoothstep(0.25, 0.02, r2);
  if (vAlpha <= 0.001) discard;
  gl_FragColor = vec4(vCol, a * vAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** A fixed-size CPU particle pool rendered as one THREE.Points draw call. */
class Pool {
  constructor(scene, count, { additive = false, gravity = -9.0, drag = 1.4 } = {}) {
    this.count = count;
    this.gravity = gravity;
    this.drag = drag;
    this.head = 0;
    this.live = 0;

    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    for (let i = 0; i < count; i++) { pos[i * 3 + 1] = -9999; }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 11;
    scene.add(this.points);

    this.pos = pos; this.col = col; this.size = size; this.alpha = alpha;
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.baseSize = new Float32Array(count);
    this.spin = new Float32Array(count);
  }

  emit(x, y, z, vx, vy, vz, r, g, b, size, life) {
    const i = this.head;
    this.head = (this.head + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.col[i * 3] = r; this.col[i * 3 + 1] = g; this.col[i * 3 + 2] = b;
    this.baseSize[i] = size;
    this.size[i] = size;
    this.alpha[i] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
  }

  update(dt) {
    const { pos, vel, life, maxLife, alpha, size, baseSize } = this;
    let live = 0;
    const damp = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
      life[i] -= dt;
      if (life[i] <= 0) { alpha[i] = 0; pos[i * 3 + 1] = -9999; continue; }
      live++;
      const i3 = i * 3;
      vel[i3 + 1] += this.gravity * dt;
      vel[i3] *= damp; vel[i3 + 1] *= damp; vel[i3 + 2] *= damp;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const t = life[i] / maxLife[i];
      // quick pop-in, slow fade out — reads as a "snap" rather than a puff
      const grow = t > 0.86 ? (1 - t) / 0.14 : 1;
      alpha[i] = Math.min(1, t * 1.9) * grow;
      size[i] = baseSize[i] * (0.55 + 0.45 * t) * (0.4 + 0.6 * grow);
    }
    this.live = live;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// canvas-generated sprite art
// ---------------------------------------------------------------------------

const EMOTES = ['question', 'alert', 'heart', 'sparkle', 'note', 'sleep'];

function makeEmoteAtlas() {
  const CELL = 128;
  const cv = document.createElement('canvas');
  cv.width = CELL * 3; cv.height = CELL * 2;
  const c = cv.getContext('2d');

  const outline = (draw, w = 11) => {
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = 'rgba(28,22,20,0.92)'; c.lineWidth = w;
    draw(true);
    c.stroke();
  };

  const cell = (i, fn) => {
    c.save();
    c.translate((i % 3) * CELL, Math.floor(i / 3) * CELL);
    fn();
    c.restore();
  };

  // 0: "?" — noticed you
  cell(0, () => {
    c.font = 'bold 104px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = 16; c.strokeStyle = 'rgba(30,24,20,0.95)';
    c.strokeText('?', 64, 62);
    c.fillStyle = '#fff6e2'; c.fillText('?', 64, 62);
  });
  // 1: "!" — startled
  cell(1, () => {
    c.font = 'bold 104px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = 16; c.strokeStyle = 'rgba(30,24,20,0.95)';
    c.strokeText('!', 64, 62);
    c.fillStyle = '#ffd06a'; c.fillText('!', 64, 62);
  });
  // 2: heart — bonded
  cell(2, () => {
    const heart = () => {
      c.beginPath();
      c.moveTo(64, 104);
      c.bezierCurveTo(18, 72, 20, 34, 44, 28);
      c.bezierCurveTo(56, 25, 64, 36, 64, 44);
      c.bezierCurveTo(64, 36, 72, 25, 84, 28);
      c.bezierCurveTo(108, 34, 110, 72, 64, 104);
      c.closePath();
    };
    outline(heart, 13);
    const g = c.createLinearGradient(0, 20, 0, 108);
    g.addColorStop(0, '#ff8fb0'); g.addColorStop(1, '#e8446e');
    heart(); c.fillStyle = g; c.fill();
    c.beginPath(); c.ellipse(48, 48, 9, 6, -0.5, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.75)'; c.fill();
  });
  // 3: sparkle — accepting / pleased
  cell(3, () => {
    const star = (cx, cy, r, k = 0.36) => {
      c.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * k;
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.closePath();
    };
    outline(() => star(62, 58, 46), 12);
    star(62, 58, 46); c.fillStyle = '#ffe9a8'; c.fill();
    star(102, 100, 20); c.fillStyle = '#fff3cf'; c.fill();
  });
  // 4: musical note — content / following
  cell(4, () => {
    const note = () => {
      c.beginPath();
      c.ellipse(46, 92, 22, 17, -0.35, 0, Math.PI * 2);
      c.closePath();
    };
    outline(() => { note(); c.moveTo(66, 88); c.lineTo(74, 26); c.lineTo(104, 34); }, 12);
    note(); c.fillStyle = '#9fe0ff'; c.fill();
    c.beginPath(); c.moveTo(64, 90); c.lineTo(64, 26); c.lineTo(104, 34); c.lineTo(104, 48); c.lineTo(74, 40); c.lineTo(74, 92);
    c.closePath(); c.fillStyle = '#9fe0ff'; c.fill();
  });
  // 5: sleep
  cell(5, () => {
    c.font = 'bold 70px ui-sans-serif, system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = 14; c.strokeStyle = 'rgba(30,24,20,0.9)';
    c.strokeText('z', 52, 78); c.fillStyle = '#dff0ff'; c.fillText('z', 52, 78);
    c.font = 'bold 46px ui-sans-serif, system-ui, sans-serif';
    c.lineWidth = 11;
    c.strokeText('z', 96, 40); c.fillStyle = '#dff0ff'; c.fillText('z', 96, 40);
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, cols: 3, rows: 2 };
}

function makeSoftDisc(color = '255,236,180') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, `rgba(${color},0.95)`);
  g.addColorStop(0.35, `rgba(${color},0.35)`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------

export function createEffects(ctx) {
  const scene = ctx.scene;
  const sparks = new Pool(scene, 300, { additive: true, gravity: -2.2, drag: 2.1 });
  const debris = new Pool(scene, 260, { additive: false, gravity: -11.5, drag: 0.9 });

  const atlas = makeEmoteAtlas();
  const glowTex = makeSoftDisc();

  // ---- emote bubbles ----
  const emotes = [];
  for (let i = 0; i < 8; i++) {
    const tex = atlas.tex.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1 / atlas.cols, 1 / atlas.rows);
    const mat = new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: true,
      opacity: 0, sizeAttenuation: true,
    });
    const sp = new THREE.Sprite(mat);
    sp.visible = false;
    sp.renderOrder = 20;
    scene.add(sp);
    emotes.push({ sp, mat, tex, t: 0, dur: 0, anchor: null, offset: new THREE.Vector3(), scale: 0.7 });
  }

  // ---- floating counters ("+3") ----
  const floats = [];
  for (let i = 0; i < 6; i++) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 96;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
    const sp = new THREE.Sprite(mat);
    sp.visible = false; sp.renderOrder = 21;
    sp.scale.set(1.0, 0.375, 1);
    scene.add(sp);
    floats.push({ cv, ctx2d: cv.getContext('2d'), tex, mat, sp, t: 0, dur: 0, from: new THREE.Vector3() });
  }

  // ---- ground ring pulses ----
  const rings = [];
  const ringGeo = new THREE.RingGeometry(0.62, 0.78, 40);
  ringGeo.rotateX(-Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffe6b0, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: true,
    });
    const m = new THREE.Mesh(ringGeo, mat);
    m.visible = false; m.renderOrder = 10;
    scene.add(m);
    rings.push({ m, mat, t: 0, dur: 0, r0: 0.4, r1: 2.0 });
  }

  // ---- soft glow blobs (used on dropped food and on the offering hand) ----
  const glows = [];
  for (let i = 0; i < 4; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex, transparent: true, depthWrite: false, opacity: 0,
      blending: THREE.AdditiveBlending, color: 0xffd89a,
    });
    const sp = new THREE.Sprite(mat);
    sp.visible = false; sp.renderOrder = 9;
    scene.add(sp);
    glows.push({ sp, mat });
  }

  // ---- trust gauge above the creature being tamed ----
  const gaugeCv = document.createElement('canvas');
  gaugeCv.width = 256; gaugeCv.height = 72;
  const gaugeCtx = gaugeCv.getContext('2d');
  const gaugeTex = new THREE.CanvasTexture(gaugeCv);
  gaugeTex.colorSpace = THREE.SRGBColorSpace;
  const gaugeMat = new THREE.SpriteMaterial({ map: gaugeTex, transparent: true, depthWrite: false, opacity: 0 });
  const gaugeSp = new THREE.Sprite(gaugeMat);
  gaugeSp.scale.set(1.05, 0.295, 1);
  gaugeSp.visible = false;
  gaugeSp.renderOrder = 22;
  scene.add(gaugeSp);
  let gaugeShown = 0, gaugeWant = 0, gaugeDrawn = -1, gaugeFlash = 0;

  function drawGauge(v, flash) {
    const c = gaugeCtx;
    c.clearRect(0, 0, 256, 72);
    const x0 = 16, y0 = 22, w = 224, h = 28, r = 14;
    const round = (x, y, ww, hh, rr) => {
      c.beginPath();
      c.moveTo(x + rr, y);
      c.arcTo(x + ww, y, x + ww, y + hh, rr);
      c.arcTo(x + ww, y + hh, x, y + hh, rr);
      c.arcTo(x, y + hh, x, y, rr);
      c.arcTo(x, y, x + ww, y, rr);
      c.closePath();
    };
    // shell
    round(x0, y0, w, h, r);
    c.fillStyle = 'rgba(24,20,18,0.62)'; c.fill();
    c.lineWidth = 3; c.strokeStyle = 'rgba(255,246,226,0.42)'; c.stroke();
    // fill
    const fw = Math.max(0, Math.min(1, v)) * (w - 8);
    if (fw > 4) {
      c.save();
      round(x0 + 4, y0 + 4, w - 8, h - 8, r - 4); c.clip();
      const g = c.createLinearGradient(x0, 0, x0 + w, 0);
      g.addColorStop(0, '#f0b25a'); g.addColorStop(0.6, '#ffd977'); g.addColorStop(1, '#ffeeb4');
      c.fillStyle = g;
      c.fillRect(x0 + 4, y0 + 4, fw, h - 8);
      c.fillStyle = 'rgba(255,255,255,0.28)';
      c.fillRect(x0 + 4, y0 + 5, fw, (h - 8) * 0.4);
      c.restore();
    }
    // stage notches
    c.fillStyle = 'rgba(255,246,226,0.5)';
    for (const s of [0.25, 0.55, 0.82]) {
      c.fillRect(x0 + 4 + (w - 8) * s - 1.5, y0 + 6, 3, h - 12);
    }
    if (flash > 0) {
      round(x0 - 3, y0 - 3, w + 6, h + 6, r + 3);
      c.strokeStyle = `rgba(255,236,180,${flash.toFixed(3)})`;
      c.lineWidth = 6; c.stroke();
    }
    gaugeTex.needsUpdate = true;
  }
  drawGauge(0, 0);

  const tmp = new THREE.Vector3();

  const api = {
    /** short-lived symbol above a creature's head; anchor is any Object3D or Vector3 */
    emote(anchor, kind = 'question', { dur = 1.5, height = 1.0, scale = 0.62 } = {}) {
      const idx = EMOTES.indexOf(kind);
      const k = idx < 0 ? 0 : idx;
      let slot = emotes.find((e) => !e.sp.visible) || emotes[0];
      slot.tex.offset.set((k % atlas.cols) / atlas.cols, 1 - Math.floor(k / atlas.cols + 1) / atlas.rows);
      slot.anchor = anchor;
      slot.offset.set(0, height, 0);
      slot.t = 0; slot.dur = dur; slot.scale = scale;
      slot.sp.visible = true;
      slot.mat.opacity = 0;
      return slot;
    },

    /** a "+3" style counter that rises from a world position */
    count(pos, text, color = '#ffe6ae') {
      const f = floats.find((x) => !x.sp.visible) || floats[0];
      const c = f.ctx2d;
      c.clearRect(0, 0, 256, 96);
      c.font = 'bold 62px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineJoin = 'round'; c.lineWidth = 13; c.strokeStyle = 'rgba(26,20,16,0.9)';
      c.strokeText(text, 128, 50);
      const g = c.createLinearGradient(0, 14, 0, 84);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, color);
      c.fillStyle = g;
      c.fillText(text, 128, 50);
      f.tex.needsUpdate = true;
      f.from.copy(pos);
      f.t = 0; f.dur = 1.5;
      f.sp.visible = true; f.mat.opacity = 0;
    },

    /** expanding ground ring — the "something happened here" stamp */
    ring(pos, { r0 = 0.35, r1 = 1.9, dur = 0.65, color = 0xffe6b0, opacity = 0.85 } = {}) {
      const r = rings.find((x) => !x.m.visible) || rings[0];
      r.m.position.set(pos.x, pos.y + 0.06, pos.z);
      r.m.visible = true;
      r.t = 0; r.dur = dur; r.r0 = r0; r.r1 = r1;
      r.mat.color.setHex(color);
      r.mat.opacity = opacity;
      r._peak = opacity;
      return r;
    },

    /** persistent soft glow you position yourself each frame; returns a handle */
    glow(i) { return glows[i % glows.length]; },

    /** generic burst of sparks + heavier debris */
    burst(pos, {
      n = 14, color = 0xffd98a, speed = 2.4, size = 0.09, life = 0.7,
      up = 1.4, debris: nDebris = 0, debrisColor = 0x6a8a3f, spread = 1,
    } = {}) {
      const col = new THREE.Color(color);
      const rng = api.rng;
      for (let i = 0; i < n; i++) {
        const a = rng.next() * Math.PI * 2;
        const el = rng.range(0.1, 1.0);
        const s = speed * rng.range(0.45, 1.0);
        const tint = col.clone().offsetHSL(rng.range(-0.03, 0.03), 0, rng.range(-0.06, 0.12));
        sparks.emit(
          pos.x + rng.range(-0.06, 0.06) * spread, pos.y + rng.range(-0.05, 0.1), pos.z + rng.range(-0.06, 0.06) * spread,
          Math.cos(a) * s * (1 - el * 0.6), up * rng.range(0.5, 1.3), Math.sin(a) * s * (1 - el * 0.6),
          tint.r, tint.g, tint.b, size * rng.range(0.7, 1.35), life * rng.range(0.7, 1.3));
      }
      if (nDebris > 0) {
        const dc = new THREE.Color(debrisColor);
        for (let i = 0; i < nDebris; i++) {
          const a = rng.next() * Math.PI * 2;
          const s = speed * rng.range(0.5, 1.2);
          debris.emit(pos.x, pos.y + 0.05, pos.z,
            Math.cos(a) * s, up * rng.range(0.8, 1.8), Math.sin(a) * s,
            dc.r, dc.g, dc.b, size * rng.range(0.6, 1.0), life * rng.range(1.1, 1.7));
        }
      }
    },

    /** one spark, for trails */
    trail(pos, color = 0xffd98a, size = 0.07, life = 0.35) {
      const c = new THREE.Color(color);
      sparks.emit(pos.x, pos.y, pos.z, 0, 0.15, 0, c.r, c.g, c.b, size, life);
    },

    showGauge(worldPos, headHeight, value, { flash = false } = {}) {
      gaugeWant = 1;
      gaugeSp.position.set(worldPos.x, worldPos.y + headHeight + 0.52, worldPos.z);
      if (flash) gaugeFlash = 1;
      if (Math.abs(value - gaugeDrawn) > 0.004 || gaugeFlash > 0) {
        gaugeDrawn = value;
        drawGauge(value, gaugeFlash);
      }
    },

    hideGauge() { gaugeWant = 0; },

    update(dt) {
      sparks.update(dt);
      debris.update(dt);

      const cam = ctx.camera;
      for (const e of emotes) {
        if (!e.sp.visible) continue;
        e.t += dt;
        const u = e.t / e.dur;
        if (u >= 1) { e.sp.visible = false; e.mat.opacity = 0; continue; }
        if (e.anchor) {
          if (e.anchor.isVector3) tmp.copy(e.anchor);
          else if (e.anchor.position) tmp.copy(e.anchor.position);
          else if (e.anchor.getWorldPosition) e.anchor.getWorldPosition(tmp);
          e.sp.position.copy(tmp).add(e.offset);
        }
        // pop in with overshoot, hold, then drift up and fade
        const pop = u < 0.16 ? easeBack(u / 0.16) : 1;
        const fade = u > 0.72 ? 1 - (u - 0.72) / 0.28 : 1;
        e.sp.position.y += Math.sin(e.t * 6.5) * 0.012 + (u > 0.72 ? (u - 0.72) * 0.5 : 0);
        e.sp.scale.setScalar(e.scale * pop);
        e.mat.opacity = fade;
      }

      for (const f of floats) {
        if (!f.sp.visible) continue;
        f.t += dt;
        const u = f.t / f.dur;
        if (u >= 1) { f.sp.visible = false; f.mat.opacity = 0; continue; }
        const rise = 0.1 + u * 0.85;
        f.sp.position.set(f.from.x, f.from.y + rise, f.from.z);
        const pop = u < 0.14 ? easeBack(u / 0.14) : 1;
        f.sp.scale.set(1.0 * pop, 0.375 * pop, 1);
        f.mat.opacity = u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
      }

      for (const r of rings) {
        if (!r.m.visible) continue;
        r.t += dt;
        const u = r.t / r.dur;
        if (u >= 1) { r.m.visible = false; r.mat.opacity = 0; continue; }
        const k = 1 - Math.pow(1 - u, 3);
        const rr = r.r0 + (r.r1 - r.r0) * k;
        r.m.scale.setScalar(rr / 0.7);
        r.mat.opacity = (r._peak ?? 0.85) * (1 - u) * (1 - u);
      }

      gaugeFlash = Math.max(0, gaugeFlash - dt * 2.2);
      gaugeShown += (gaugeWant - gaugeShown) * Math.min(1, dt * 8);
      gaugeSp.visible = gaugeShown > 0.02;
      gaugeMat.opacity = gaugeShown;
      const gs = 0.86 + 0.14 * gaugeShown;
      gaugeSp.scale.set(1.05 * gs, 0.295 * gs, 1);
      gaugeWant = 0;
      if (cam) { /* sprites already face camera */ }
    },

    rng: ctx.rng,
    _pools: { sparks, debris },
  };

  return api;
}

function easeBack(t) {
  const c = 2.4;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}
