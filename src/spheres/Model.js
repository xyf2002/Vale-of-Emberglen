import * as THREE from 'three';

/**
 * THE BOND SPHERE, built in code.
 *
 * Not a plastic toy: a lacquered seed-pod. Bone-white crown, moss-dark base, a brass
 * seam and one amber eye that lights when something is inside it. The silhouette does
 * the work (a hard bright/dark split at the equator) and the colour only confirms it.
 *
 * SIZE. This was 0.145 m radius — 29 cm across, a beach ball, and in the hand it read
 * as the traveller carrying a pumpkin. It is now 0.062 (12.4 cm across): a large
 * grapefruit, which is about what a thrown capture device should be and still reads
 * against grass at the six metres the throw is usually taken from. Anything smaller
 * stops being legible in flight; the trail and the landing ring carry it after that.
 *
 * Everything is shared between pooled instances — one geometry set, one material set —
 * so having three of these in flight costs three times the draw calls and none of the
 * memory. The halves hinge apart around the seam; the band and the button ride on the
 * lower half so the seam never floats unattached when it opens.
 */

export const SHELL_R = 0.062;

/** speckled lacquer, so the shell is not a flat vinyl blob under a strong key light */
function lacquerTexture(rng, base, speck, n = 220) {
  const S = 96;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  g.fillStyle = speck;
  for (let i = 0; i < n; i++) {
    const x = rng.next() * S, y = rng.next() * S, r = 0.4 + rng.next() * 1.5;
    g.globalAlpha = 0.05 + rng.next() * 0.16;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
}

/** vertical ramp for the capture beam — bright at the sphere mouth, dissolving at the far end */
function beamTexture() {
  const W = 8, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.00, 'rgba(255,255,255,0.00)');
  grd.addColorStop(0.18, 'rgba(255,236,190,0.55)');
  grd.addColorStop(0.50, 'rgba(255,214,140,0.20)');
  grd.addColorStop(0.72, 'rgba(255,240,205,0.85)');
  grd.addColorStop(1.00, 'rgba(255,255,255,1.00)');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  // travelling rungs, so the beam reads as *pulling* rather than as a static cone
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i < 6; i++) g.fillRect(0, (i / 6) * H, W, 2.5);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2);
  return tex;
}

export function createSphereFactory(rng) {
  const geo = {
    top: new THREE.SphereGeometry(SHELL_R, 22, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    bot: new THREE.SphereGeometry(SHELL_R, 22, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    // the seam's thickness is a FRACTION of the shell, not a constant: at the old
    // 0.145 m radius 0.0165 was a fine brass line, and at 0.062 it would be a tyre
    band: new THREE.TorusGeometry(SHELL_R * 1.012, SHELL_R * 0.114, 6, 26),
    button: new THREE.SphereGeometry(SHELL_R * 0.248, 12, 8),   // fraction, not a constant
    core: new THREE.SphereGeometry(SHELL_R * 0.78, 12, 8),
  };
  geo.band.rotateX(Math.PI / 2);

  const mat = {
    // The map already carries the colour. Leaving `color` tinted as well multiplies the
    // two and crushes the dark half to near black — the same double-decode trap that ate
    // the AI props last round.
    top: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.46, metalness: 0.04,
      map: lacquerTexture(rng, '#e9e2d0', '#a89c81'),
    }),
    bot: new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.52, metalness: 0.06,
      map: lacquerTexture(rng, '#3d7357', '#12301f'),
    }),
    band: new THREE.MeshStandardMaterial({ color: 0xc8a44e, roughness: 0.30, metalness: 0.72 }),
    button: new THREE.MeshStandardMaterial({
      color: 0xffcf6e, roughness: 0.25, metalness: 0.1,
      emissive: new THREE.Color(0xffb347), emissiveIntensity: 0.5,
    }),
    core: new THREE.MeshBasicMaterial({
      color: 0xffd489, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  };

  const beamMat = new THREE.MeshBasicMaterial({
    map: beamTexture(), color: 0xffe6b4, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  // Open-ended cone: narrow at the sphere mouth, flared where it wraps the creature.
  // radiusTop sits at +h/2, so after the translate the WIDE end is the far (creature)
  // end and the narrow end is the origin — which is where the sphere is.
  const beamGeo = new THREE.CylinderGeometry(0.42, 0.055, 1, 14, 1, true);
  beamGeo.translate(0, 0.5, 0);   // origin at the sphere end, grows along +Y

  return {
    /** one poolable sphere. Nothing here is per-frame allocated after this call. */
    create() {
      const root = new THREE.Group();
      root.name = 'bond_sphere';      // probes find it by name; nothing else reads this
      const shell = new THREE.Group();
      root.add(shell);

      const top = new THREE.Mesh(geo.top, mat.top);
      const bot = new THREE.Mesh(geo.bot, mat.bot);
      const band = new THREE.Mesh(geo.band, mat.band);
      const button = new THREE.Mesh(geo.button, mat.button);
      // the eye sits on the seam, proud of the shell, and rides the lower half
      button.position.set(0, 0, SHELL_R * 0.96);
      // per-sphere clone so one wobbling sphere does not light up every other one
      button.material = mat.button.clone();
      const core = new THREE.Mesh(geo.core, mat.core.clone());

      top.castShadow = bot.castShadow = true;
      band.castShadow = true;
      core.renderOrder = 3;

      bot.add(band);
      bot.add(button);
      shell.add(top); shell.add(bot); shell.add(core);

      const beam = new THREE.Mesh(beamGeo, beamMat.clone());
      beam.visible = false;
      beam.renderOrder = 4;
      beam.frustumCulled = false;

      root.visible = false;

      return {
        root, shell, top, bot, band, button, core, beam,
        /** 0 = shut, 1 = fully hinged open */
        setOpen(k) {
          const e = k * k * (3 - 2 * k);
          top.position.y = SHELL_R * 0.72 * e;
          top.rotation.x = -1.05 * e;
          bot.position.y = -SHELL_R * 0.33 * e;
          bot.rotation.x = 0.38 * e;
        },
        /** 0..1 — how hot the eye and the inner core burn */
        setGlow(k) {
          button.material.emissiveIntensity = 0.5 + k * 3.6;
          core.material.opacity = k * 0.85;
          core.scale.setScalar(0.9 + k * 0.35);
        },
        /** `w` widens the cone to hold apparent width on a long throw — see the
         *  stand-off note in index.js onHit(). 1 at the authored range. */
        setBeam(on, len, k, w = 1) {
          beam.visible = on;
          if (!on) return;
          const r = (0.55 + k * 0.75) * w;
          beam.scale.set(r, Math.max(0.001, len), r);
          beam.material.opacity = Math.min(1, k * (0.85 + w * 0.15));
        },
        dispose() {
          button.material.dispose(); core.material.dispose(); beam.material.dispose();
        },
      };
    },
    dispose() {
      for (const g of Object.values(geo)) g.dispose();
      for (const m of Object.values(mat)) { m.map?.dispose?.(); m.dispose(); }
      beamGeo.dispose(); beamMat.map?.dispose(); beamMat.dispose();
    },
  };
}
