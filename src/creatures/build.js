import * as THREE from 'three';
import { Builder, sweepGrid, furTexture } from './procgen.js';
import { furMaterial } from './materials.js';
import { faceAtlas, expressionOffset } from './faces.js';
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
  });
  const faceTex = faceAtlas(def.face);

  const asset = { def, geometry, furMat, faceTex, boneInverses, locals, bi };
  assets.set(def.id, asset);
  return asset;
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
