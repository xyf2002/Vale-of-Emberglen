import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * PROCEDURAL WEAPON MODELS — no asset files anywhere in this project, guns included.
 *
 * Both weapons are built as one merged, vertex-coloured geometry so a gun in the hand
 * costs exactly one draw call (plus one in the shadow pass). Everything is authored in
 * a right-handed local frame with **-Z as the bore axis**, +Y up, +X to the shooter's
 * right, and the trigger group at the origin — so the model can be pointed simply by
 * aiming its -Z at whatever the camera is aiming at, and the grip lands in the hand.
 *
 * The silhouettes are deliberately blunt and toy-like rather than catalogue-accurate.
 * This is a game about befriending animals; the tool that weakens one should read as
 * equipment, not as a photograph of a weapon. Chunky slab sides, an oversized ring
 * front sight and a visible orange charging handle read at 40 px in a third-person
 * frame, which is the only size any of this is ever seen at.
 *
 * Four named empties come back with the model:
 *   muzzle — where flash, smoke and the tracer's first metre are born
 *   eject  — where the case leaves, on the right side of the receiver
 *   grip   — where the firing hand's WRIST goes, so src/player can IK the right arm
 *            onto it. It sits ~3.5 cm above the grip's centreline because the hand
 *            group's origin is the wrist and the fist mesh hangs below it; targeting
 *            the grip centre directly buries the gun inside the fist.
 *   fore   — the nearest acceptable support-hand wrist, at the magwell. The support
 *            hand slides forward from here along the bore by up to `slide` metres,
 *            as far as the left arm can actually reach (see src/player/Animator.js).
 */

// Deliberately much lighter than a real gunmetal. There is no environment map in this
// renderer, so a metallic dark-grey material has nothing to reflect and resolves to a
// flat near-black silhouette — the first version read as a hole in the frame rather than
// as an object. These values put the receiver at roughly the same luminance as the
// player's jacket, which is where a held prop has to sit to be legible against grass.
const GUNMETAL = 0x50565f;
const GUNMETAL_LIGHT = 0x6b7480;
const POLYMER = 0x4c4c44;
const GRIP = 0x6a5844;
const ACCENT = 0xd4772a;      // charging handle / mag release: the readable orange
const SIGHT = 0x9aa0a8;

/** a coloured box, positioned (and optionally rotated) in the weapon's local frame */
function part(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.rotateX(rx), g.rotateY(ry), g.rotateZ(rz);
  g.translate(x, y, z);
  paint(g, color);
  return g;
}

/** a coloured cylinder along -Z (barrels, tubes) */
function tube(r, len, x, y, z, color, seg = 10) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  paint(g, color);
  return g;
}

function paint(geo, hex) {
  // NO convertSRGBToLinear() here, and it cost an afternoon to be sure of that.
  // THREE.ColorManagement is enabled, so `new Color(hex)` has ALREADY decoded the hex
  // from sRGB into the linear working space. Converting again squares the value: the
  // receiver's albedo came out at 0.007 instead of 0.080 — a factor of eleven — and the
  // whole weapon rendered as a black hole in the frame with no obvious cause. (Same
  // trap as the double-decode that was fixed in the AI props last round.)
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // merging requires an identical attribute set on every part
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return geo;
}

function pistolParts() {
  return [
    // slide + frame
    part(0.042, 0.058, 0.215, 0, 0.062, -0.055, GUNMETAL),
    part(0.046, 0.020, 0.190, 0, 0.086, -0.048, GUNMETAL_LIGHT),
    part(0.038, 0.034, 0.150, 0, 0.032, -0.038, POLYMER),
    // bore
    tube(0.011, 0.060, 0, 0.062, -0.150, 0x14161a, 8),
    // grip, raked back 15 degrees
    part(0.036, 0.130, 0.052, 0, -0.028, 0.026, GRIP, 0.26),
    // trigger guard
    part(0.020, 0.010, 0.056, 0, -0.012, -0.020, POLYMER),
    part(0.016, 0.034, 0.010, 0, 0.004, 0.006, POLYMER),
    // magazine floorplate peeking out of the grip
    part(0.030, 0.014, 0.040, 0, -0.092, 0.043, ACCENT, 0.26),
    // sights
    part(0.010, 0.014, 0.010, 0, 0.104, -0.145, SIGHT),
    part(0.026, 0.012, 0.010, 0, 0.104, 0.030, SIGHT),
    // ejection port, right side
    part(0.006, 0.024, 0.052, 0.022, 0.070, -0.030, 0x1b1d21),
  ];
}

function rifleParts() {
  return [
    // receiver
    part(0.052, 0.076, 0.300, 0, 0.070, -0.060, GUNMETAL),
    part(0.056, 0.022, 0.270, 0, 0.110, -0.055, GUNMETAL_LIGHT),
    // handguard + barrel
    part(0.048, 0.052, 0.240, 0, 0.066, -0.320, POLYMER),
    tube(0.013, 0.320, 0, 0.066, -0.400, 0x14161a, 8),
    tube(0.020, 0.060, 0, 0.066, -0.545, GUNMETAL_LIGHT, 8),   // flash hider
    // ring front sight — the single most readable feature at distance
    part(0.010, 0.052, 0.012, -0.021, 0.122, -0.430, SIGHT),
    part(0.010, 0.052, 0.012, 0.021, 0.122, -0.430, SIGHT),
    part(0.052, 0.010, 0.012, 0, 0.146, -0.430, SIGHT),
    // low-profile optic
    part(0.032, 0.030, 0.086, 0, 0.140, -0.090, GUNMETAL_LIGHT),
    part(0.024, 0.020, 0.008, 0, 0.142, -0.134, 0x243036),
    // charging handle, deliberately orange so the reload's third phase reads
    part(0.014, 0.014, 0.048, 0.030, 0.104, 0.055, ACCENT),
    // pistol grip
    part(0.038, 0.120, 0.050, 0, -0.014, 0.052, GRIP, 0.30),
    // trigger guard
    part(0.022, 0.010, 0.060, 0, 0.010, -0.010, POLYMER),
    // magazine, curved forward
    part(0.034, 0.150, 0.056, 0, -0.036, -0.030, ACCENT, -0.14),
    // stock
    part(0.040, 0.048, 0.150, 0, 0.056, 0.150, POLYMER),
    part(0.044, 0.086, 0.036, 0, 0.030, 0.216, POLYMER, -0.10),
    // ejection port
    part(0.006, 0.026, 0.060, 0.027, 0.080, -0.040, 0x1b1d21),
  ];
}

const LAYOUT = {
  pistol: {
    parts: pistolParts, scale: 1.0,
    muzzle: [0, 0.062, -0.182], eject: [0.045, 0.074, -0.028],
    // a pistol is held in a thumbs-forward cup: the support wrist is barely 4 cm from
    // the firing wrist and has almost nowhere to slide to
    grip: [0, 0.014, 0.028], fore: [-0.036, -0.014, 0.014], slide: 0.03,
  },
  rifle: {
    parts: rifleParts, scale: 1.0,
    muzzle: [0, 0.066, -0.580], eject: [0.052, 0.082, -0.040],
    grip: [0, 0.026, 0.050], fore: [0, 0.030, -0.050], slide: 0.30,
  },
};

/**
 * Build one weapon. Returns a group with the mesh plus two empties; the caller drives
 * `group.position/quaternion` and reads world positions off `muzzle` / `eject`.
 */
export function buildWeaponModel(id) {
  const layout = LAYOUT[id];
  if (!layout) return null;

  const geo = mergeGeometries(layout.parts(), false);
  geo.computeBoundingSphere();

  // metalness stays low for the same reason the palette is light: with no IBL, metal is
  // black. A near-dielectric response with a little sheen is the honest choice here.
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.10,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.name = `weapon_${id}`;

  const group = new THREE.Group();
  group.name = `weapon_${id}_rig`;
  group.add(mesh);
  group.scale.setScalar(layout.scale);

  const muzzle = new THREE.Object3D();
  muzzle.position.fromArray(layout.muzzle);
  group.add(muzzle);

  const eject = new THREE.Object3D();
  eject.position.fromArray(layout.eject);
  group.add(eject);

  const grip = new THREE.Object3D();
  grip.position.fromArray(layout.grip);
  group.add(grip);

  const fore = new THREE.Object3D();
  fore.position.fromArray(layout.fore);
  group.add(fore);

  return {
    group, mesh, mat, muzzle, eject, grip, fore, slide: layout.slide,
    triangles: geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3,
  };
}
