import * as THREE from 'three';
import { Builder, sweepGrid, furTexture } from './procgen.js';
import { furMaterial } from './materials.js';
import { faceAtlas, expressionOffset, EXPRESSIONS } from './faces.js';
import { M } from './species.js';

/**
 * Turns a species definition into a real, riggable creature.
 *
 * One SkinnedMesh per creature, two material groups (fur + drawn face). That is 2 draw
 * calls each, which is what lets a meadow hold a dozen of them.
 *
 * The head is NOT a separate object — it is a smooth skin-weight gradient across the top
 * of a single continuous surface. That is the whole trick behind "head fused into the
 * mass with no neck" (reference observation #1): there is no seam to see because there
 * is no seam.
 */

const assets = new Map();

/* ------------------------------------------------------------------ eyes */

/**
 * EYES THAT READ AS BALLS — the thing a blind critic used to tell our creature from a
 * real one. Its words, comparing a real pal against our Woolkin:
 *
 *   "B's pink pal has spherical eyeballs with a specular catchlight, a dark limbal ring,
 *    and a soft shadow cast by the brow onto the upper iris. A's Woolkin has eyes
 *    painted onto a flat face decal."
 *
 * faces.js draws the flat vector eye that reference observation #3 asks for — huge, hard
 * outline, pure white sclera, one saturated iris, one specular dot. That is right and it
 * stays. What was missing is that in the real frames those flat graphics are still *shaded
 * as a sphere set into a socket*: dark at the limbus, dark under the brow, one hard white
 * highlight. This pass adds only those three things, on top of what faces.js drew.
 *
 * It lives here rather than in faces.js because the atlas is a plain canvas we can go back
 * over; the eye geometry below is deliberately the same arithmetic as drawOpenEye(), so if
 * that function's layout changes this must follow it.
 */
const OPEN_EYE = {
  neutral: {},
  wide: { scale: 1.15, lid: 1.06, slantMul: 0.25 },
  wary: { scale: 0.99, lid: 0.34, slantMul: 1.5 },
  smug: { scale: 1.0, lid: 0.26, squash: 0.86 },
  chew: { scale: 0.97, lid: 0.55 },
};

const hex3 = (h) => {
  const n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const shade = (h, k, a = 1) => {
  const c = hex3(h);
  return `rgba(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)},${a})`;
};

function ell(g, x, y, rx, ry) {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, 6.2832);
}

/** same lid cut faces.js uses, so the sculpt lands inside the drawn eye exactly */
function lidClip(g, cx, cy, S, slant, drop) {
  const k = Math.tan(slant);
  const x0 = cx - S, x1 = cx + S;
  g.beginPath();
  g.moveTo(x0, cy + drop + (x0 - cx) * k);
  g.lineTo(x1, cy + drop + (x1 - cx) * k);
  g.lineTo(x1, cy + S * 3);
  g.lineTo(x0, cy + S * 3);
  g.closePath();
  g.clip();
}

function sculptEye(g, f, S, side, o) {
  const cx = S * (0.5 + side * f.gap);
  const cy = S * f.eyeY + (o.dy || 0) * S;
  const rx = S * f.eyeR * (o.scale || 1);
  const ry = S * f.eyeR * f.tall * (o.scale || 1) * (o.squash || 1);
  const slant = (f.slant || 0) * side * (o.slantMul === undefined ? 1 : o.slantMul);
  const drop = -ry * (o.lid === undefined ? f.lid : o.lid);
  const ow = S * f.outlineW;
  const ix = cx - side * rx * (f.irisX || 0.06);
  const iy = cy + ry * (f.irisY === undefined ? 0.14 : f.irisY);
  const irx = rx * f.irisR, iry = ry * f.irisR * (f.irisTall || 1.02);

  g.save();
  lidClip(g, cx, cy, S, slant, drop + ow * 1.15);
  ell(g, cx, cy, rx, ry);
  g.clip();

  // 1. LIMBAL RING. Real eyes are darkest exactly where the cornea meets the sclera,
  //    and it is the single cheapest cue that the iris is curved rather than printed.
  g.strokeStyle = shade(f.iris, 0.22, 0.94);
  g.lineWidth = Math.max(1, irx * 0.24);
  ell(g, ix, iy, irx * 0.93, iry * 0.93);
  g.stroke();

  // 2. THE EYEBALL IS A BALL. A soft darkening toward the rim of the whole eye, so the
  //    sclera stops being a flat white paper cut-out.
  {
    const rr = Math.max(rx, ry) * 1.02;
    const grd = g.createRadialGradient(cx, cy, rr * 0.50, cx, cy, rr);
    grd.addColorStop(0, 'rgba(28,20,32,0)');
    grd.addColorStop(1, 'rgba(28,20,32,0.30)');
    g.fillStyle = grd;
    ell(g, cx, cy, rx, ry);
    g.fill();
  }

  // 3. BROW SHADOW onto the upper sclera and the top of the iris, following the lid's
  //    slant so it belongs to the face rather than to the screen.
  {
    g.save();
    g.translate(cx, cy);
    g.rotate(slant);
    const grd = g.createLinearGradient(0, -ry * 1.05, 0, ry * 0.10);
    grd.addColorStop(0, 'rgba(34,22,30,0.46)');
    grd.addColorStop(0.55, 'rgba(34,22,30,0.16)');
    grd.addColorStop(1, 'rgba(34,22,30,0)');
    g.fillStyle = grd;
    g.fillRect(-rx * 1.6, -ry * 1.6, rx * 3.2, ry * 3.2);
    g.restore();
  }

  // 4. ONE specular catchlight (reference #3 is explicit: exactly one round dot), redrawn
  //    on top of the shadow so it stays a hard white terminal highlight. Placed up and
  //    outboard, straddling the limbus, which is where a highlight lands on a sphere lit
  //    from above.
  {
    const hx = ix - side * irx * 0.38, hy = iy - iry * 0.52, hr = irx * 0.30;
    const halo = g.createRadialGradient(hx, hy, hr * 0.7, hx, hy, hr * 2.0);
    halo.addColorStop(0, 'rgba(255,255,255,0.30)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = halo;
    ell(g, hx, hy, hr * 2.0, hr * 2.0);
    g.fill();
    g.fillStyle = '#ffffff';
    ell(g, hx, hy, hr, hr);
    g.fill();
  }
  g.restore();
}

/**
 * The face PLATE sits *in* the head, not on it. faces.js draws it as a flat colour oval,
 * and flat is exactly what the critic caught: "the brown mask has a hard vector edge that
 * doesn't follow the head's curvature". In pw_00 the sheep's brown face is visibly darker
 * around its whole perimeter, because the fleece overhangs it. That occlusion ring is what
 * turns a sticker into a recess, and it costs one gradient.
 *
 * `source-atop` is load-bearing: it paints only where the atlas is already opaque, so the
 * ring can never bleed outside the plate into the alpha-tested transparent area.
 */
function recessPlate(g, f, S) {
  const pl = f.plate || f.muzzle;
  if (!pl) return;
  const rx = S * pl.rx, ry = S * pl.ry;
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.translate(S * 0.5, S * pl.y);
  g.scale(1, ry / rx);
  const grd = g.createRadialGradient(0, 0, rx * 0.58, 0, 0, rx * 1.02);
  grd.addColorStop(0, 'rgba(26,12,8,0)');
  grd.addColorStop(0.72, 'rgba(26,12,8,0.13)');
  grd.addColorStop(1, 'rgba(26,12,8,0.42)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, rx * 1.02, 0, 6.2832);
  g.fill();
  g.restore();
}

function sculptFaceAtlas(tex, face) {
  const canvas = tex.image;
  if (!canvas || !canvas.getContext) return tex;
  const COLS = 4, ROWS = 2;
  const S = canvas.width / COLS;
  const g = canvas.getContext('2d');
  for (let i = 0; i < EXPRESSIONS.length && i < COLS * ROWS; i++) {
    const name = EXPRESSIONS[i];
    g.save();
    g.translate((i % COLS) * S, Math.floor(i / COLS) * S);
    g.beginPath(); g.rect(0, 0, S, S); g.clip();
    recessPlate(g, face, S);
    const o = OPEN_EYE[name];
    if (o) for (const side of [-1, 1]) sculptEye(g, face, S, side, o);
    g.restore();
  }
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ build */

export function speciesAsset(def, rng) {
  if (assets.has(def.id)) return assets.get(def.id);

  const B = new Builder();
  const bi = {};
  def.boneSpec.forEach((b, i) => { bi[b.name] = i; });
  const res = def.build(B, bi) || {};

  // the drawn face: a patch of the *same* parametric surface, offset a hair proud of it
  if (res.stops) {
    B.addGrid(sweepGrid({
      uSeg: 30, vSeg: 30, stops: res.stops,
      uRange: [-def.faceU, def.faceU], vRange: def.faceV, offset: 0.0022,
    }), { matrix: M(), weight: res.weight, group: 1, paint: () => [1, 1, 1] });
  }

  const geometry = B.toGeometry();

  // bind-pose bone inverses (bind pose has no rotation, so this is just -translation)
  const world = def.boneSpec.map((b) => b.at);
  const boneInverses = world.map((at) => new THREE.Matrix4().makeTranslation(-at[0], -at[1], -at[2]));
  const locals = def.boneSpec.map((b) => {
    if (!b.parent) return b.at;
    const p = world[def.boneSpec.findIndex((x) => x.name === b.parent)];
    return [b.at[0] - p[0], b.at[1] - p[1], b.at[2] - p[2]];
  });

  const fuzz = furTexture(rng, {
    size: 384, contrast: def.fur.contrast, streak: def.fur.streak ?? 0.6, tufts: def.fur.tufts ?? 60,
  });
  const furMat = furMaterial({
    map: fuzz, sheen: def.fur.sheen, rim: def.fur.rim,
    fill: def.fur.fill, wrap: def.fur.wrap, fuzz: def.fur.fuzz,
    ...formLighting(def),
  });
  const faceTex = sculptFaceAtlas(faceAtlas(def.face), def.face);

  const asset = { def, geometry, furMat, faceTex, boneInverses, locals, bi };
  assets.set(def.id, asset);
  return asset;
}

/**
 * How hard this species' form is allowed to be modelled by light. See the long note in
 * materials.js for why the defaults exist at all; these are the per-species deviations.
 *
 *   - Woolkin is a ball of overlapping lobes and reads as a single flat disc unless the
 *     ambient falls off hard from crown to belly, so it gets the deepest sky occlusion.
 *   - Mosshorn is a low barrel whose whole underside is within 40 cm of the grass.
 *   - Dewhare flares to the ground with no visible legs, so its ground line is the
 *     silhouette; too much occlusion there and it looks amputated.
 *
 * NOTE FOR ANYONE TUNING GROUND OCCLUSION: this object is spread over furMaterial's
 * arguments, so IT WINS. Raising `groundAO` on the furMaterial signature does nothing
 * for woolkin, mosshorn or dewhare — that cost r13 one probe run to notice. Change it
 * here, or here as well.
 *
 * r13 raised every ground line. The meadow carpet is 0.30-0.60 m tall, so a Woolkin's
 * lower third is literally inside the grass, and the old ramps (0.30 of normalised body
 * height on a 0.95 m creature is ~28 cm) finished at or below the blade tips — the
 * visible bottom of the body was as bright as its back, which is half of why two blind
 * critics in a row said it floats. The other half is the ground, handled by
 * CONTACT_LAYERS in materials.js.
 */
function formLighting(def) {
  switch (def.id) {
    case 'woolkin': return { key: 2.05, ambFloor: 0.23, groundAO: 0.62, groundAOh: 0.38 };
    case 'mosshorn': return { key: 2.00, ambFloor: 0.30, groundAO: 0.56, groundAOh: 0.42 };
    // dewhare's silhouette IS its ground line — it flares to the floor with no legs, so
    // this one stays shallow. Pushed past ~0.40 it stops reading as a creature standing
    // in grass and starts reading as a creature with no bottom.
    case 'dewhare': return { key: 1.95, ambFloor: 0.34, groundAO: 0.38, groundAOh: 0.20 };
    default: return { key: 2.10, ambFloor: 0.28, groundAO: 0.50, groundAOh: 0.28 };
  }
}

export function instantiate(asset) {
  const { def, geometry, furMat, faceTex, boneInverses, locals } = asset;
  const root = new THREE.Group();
  root.name = `creature:${def.id}`;

  // `root` is the PLACEMENT node — position and the facing other systems ask for; the
  // AI and the taming arc both write root.rotation.y directly. `pose` is the creature
  // system's own presentation offset on top of it: the torso's lag behind that
  // requested facing, and the standing stance. Reference #12 — a Pal is never squared
  // dead-on to what it is looking at; the head does the last 20-30 degrees.
  const pose = new THREE.Group();
  pose.name = 'pose';
  root.add(pose);

  const bones = def.boneSpec.map((b, i) => {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.position.set(locals[i][0], locals[i][1], locals[i][2]);
    return bone;
  });
  def.boneSpec.forEach((b, i) => {
    if (b.parent) bones[def.boneSpec.findIndex((x) => x.name === b.parent)].add(bones[i]);
  });
  pose.add(bones[0]);

  const tex = faceTex.clone();
  tex.needsUpdate = true;
  const faceMat = furMaterial({
    map: tex, sheen: 0.05, rim: def.fur.rim * 0.7,
    fill: def.fur.fill, wrap: def.fur.wrap, fuzz: def.fur.fuzz * 0.5, transparent: true,
    // The face patch is a piece of the head surface, so it has to be lit by exactly the
    // same law as the fur underneath it or the drawn face detaches into a floating decal
    // — which is the "hard vector edge that doesn't follow the head's curvature" the
    // critic saw. The one exception is the ground-line term: the face is never near the
    // ground, and applying it would darken a chin that has nothing under it.
    ...formLighting(def), groundAO: 0.0,
  });
  faceMat.alphaTest = 0.02;
  faceMat.depthWrite = false;
  faceMat.polygonOffset = true;
  faceMat.polygonOffsetFactor = -2;
  faceMat.polygonOffsetUnits = -2;

  const mesh = new THREE.SkinnedMesh(geometry, [furMat, faceMat]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.renderOrder = 1;
  mesh.bind(new THREE.Skeleton(bones, boneInverses), new THREE.Matrix4());
  pose.add(mesh);

  const B = {};
  bones.forEach((b) => { B[b.name] = b; });
  return { root, pose, mesh, bones: B, faceMat, faceTex: tex };
}

export function setExpression(rig, name) {
  if (rig._expr === name) return;
  rig._expr = name;
  const o = expressionOffset(name);
  rig.faceTex.offset.set(o[0], o[1]);
}
