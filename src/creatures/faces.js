import * as THREE from 'three';
import { mkCanvas } from './procgen.js';

/**
 * FACES — reference observation #3, the single highest-leverage thing in the project.
 *
 * "Faces are flat vector graphics laid on a 3D form: huge hard-edged eyes, pure white
 *  sclera, thick dark outline, one saturated iris colour, exactly one round specular
 *  dot, mouth as a single curve."
 *
 * So we DRAW them. A canvas atlas of expressions is mapped onto a spherical cap that
 * conforms exactly to the head surface, which is why it reads as painted-on rather than
 * as a floating decal. Nothing here is modelled: no nose geometry, no eyelid geometry.
 */

export const EXPRESSIONS = ['neutral', 'blink', 'happy', 'wide', 'sleepy', 'chew', 'wary', 'smug'];
const COLS = 4, ROWS = 2, CELL = 384;

export function expressionOffset(name) {
  const i = Math.max(0, EXPRESSIONS.indexOf(name));
  return [(i % COLS) / COLS, 1 - (Math.floor(i / COLS) + 1) / ROWS];
}

/* ------------------------------------------------------------------ helpers */

/** '#rrggbb' -> a fully transparent version of the same colour, for gradient tails */
function fade(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0)`;
}

function ellipse(g, x, y, rx, ry, rot = 0) {
  g.beginPath();
  g.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, 6.2832);
}

/**
 * Clip away everything above a slanted lid line (this is what makes the eye read sharp).
 *
 * CONVENTION: `lid` is how much of the eye survives, measured downward from the centre
 * in units of the eye's half-height. lid = 1 keeps the whole ellipse; lid = 0 keeps the
 * bottom half. Anything below ~0.6 is a heavy, sleepy-looking lid — the reference eyes
 * (`pw_15`, `pw_12`, `pw_09`) are cut by only 10-20% of their height, not by half.
 */
function lidClip(g, cx, cy, S, slant, drop) {
  g.beginPath();
  const k = Math.tan(slant);
  const x0 = cx - S, x1 = cx + S;
  g.moveTo(x0, cy + drop + (x0 - cx) * k);
  g.lineTo(x1, cy + drop + (x1 - cx) * k);
  g.lineTo(x1, cy + S * 3);
  g.lineTo(x0, cy + S * 3);
  g.closePath();
  g.clip();
}

function drawOpenEye(g, f, S, side, o) {
  const cx = S * (0.5 + side * f.gap);
  const cy = S * f.eyeY + (o.dy || 0) * S;
  const rx = S * f.eyeR * (o.scale || 1);
  const ry = S * f.eyeR * f.tall * (o.scale || 1) * (o.squash || 1);
  const slant = (f.slant || 0) * side * (o.slantMul === undefined ? 1 : o.slantMul);
  const drop = -ry * (o.lid === undefined ? f.lid : o.lid);
  const ow = S * f.outlineW;

  g.save();
  lidClip(g, cx, cy, S, slant, drop);
  // thick dark outline: an oversized fill under an inset white fill
  g.fillStyle = f.outline;
  ellipse(g, cx, cy, rx + ow, ry + ow); g.fill();
  g.restore();

  g.save();
  lidClip(g, cx, cy, S, slant, drop + ow * 1.15);
  g.fillStyle = f.sclera;
  ellipse(g, cx, cy, rx, ry); g.fill();

  // iris — one saturated colour, sitting low and slightly inward
  const ix = cx - side * rx * (f.irisX || 0.06);
  const iy = cy + ry * (f.irisY === undefined ? 0.14 : f.irisY);
  const irx = rx * f.irisR, iry = ry * f.irisR * (f.irisTall || 1.02);
  const grd = g.createLinearGradient(ix, iy - iry, ix, iy + iry);
  grd.addColorStop(0, f.iris2 || f.iris);
  grd.addColorStop(1, f.iris);
  g.fillStyle = grd;
  ellipse(g, ix, iy, irx, iry); g.fill();

  if (f.pupil) {
    g.fillStyle = f.pupil;
    ellipse(g, ix, iy + iry * 0.08, irx * (f.pupilR || 0.44), iry * (f.pupilR || 0.44) * 1.12); g.fill();
  }
  // exactly one round specular dot
  g.fillStyle = 'rgba(255,255,255,0.97)';
  ellipse(g, ix - side * irx * 0.34, iy - iry * 0.44, irx * 0.30, irx * 0.30); g.fill();
  g.restore();

  // brow / upper lash — the thick dark line that reads as an outline at distance
  if (f.brow) {
    g.save();
    g.strokeStyle = f.outline;
    g.lineWidth = ow * 1.7;
    g.lineCap = 'round';
    const k = Math.tan(slant);
    g.beginPath();
    g.moveTo(cx - rx * 1.02, cy + drop + (-rx * 1.02) * k);
    g.lineTo(cx + rx * 1.02, cy + drop + (rx * 1.02) * k);
    g.stroke();
    g.restore();
  }
}

function drawClosedEye(g, f, S, side, mode) {
  const cx = S * (0.5 + side * f.gap);
  const cy = S * f.eyeY;
  const rx = S * f.eyeR * 0.98;
  const ry = S * f.eyeR * f.tall;
  g.save();
  g.strokeStyle = f.outline;
  g.lineWidth = S * f.outlineW * 2.0;
  g.lineCap = 'round';
  g.beginPath();
  if (mode === 'happy') {         // ⌒ — arcs curving up, the classic Pal grin
    g.moveTo(cx - rx, cy + ry * 0.30);
    g.quadraticCurveTo(cx, cy - ry * 0.85, cx + rx, cy + ry * 0.30);
  } else if (mode === 'sleepy') { // shallow downward curve
    g.moveTo(cx - rx, cy - ry * 0.10);
    g.quadraticCurveTo(cx, cy + ry * 0.55, cx + rx, cy - ry * 0.10);
  } else {                        // blink: a flat line with a tiny sag
    g.moveTo(cx - rx, cy);
    g.quadraticCurveTo(cx, cy + ry * 0.30, cx + rx, cy);
  }
  g.stroke();
  g.restore();
}

function drawMouth(g, f, S, kind) {
  const cx = S * 0.5, cy = S * f.mouthY;
  const w = S * f.mouthW, ow = S * f.outlineW;
  g.save();
  g.strokeStyle = f.outline;
  g.lineWidth = ow * (f.mouthLine || 1.45);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (kind === 'open' || kind === 'chew') {
    const h = w * (kind === 'chew' ? 0.62 : 0.86);
    g.fillStyle = f.mouthIn || '#5a2a30';
    g.beginPath();
    g.moveTo(cx - w, cy - h * 0.18);
    g.quadraticCurveTo(cx, cy + h * 1.5, cx + w, cy - h * 0.18);
    g.quadraticCurveTo(cx, cy + h * 0.12, cx - w, cy - h * 0.18);
    g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = f.tongue || '#e2848c';
    g.beginPath();
    g.ellipse(cx, cy + h * 0.62, w * 0.52, h * 0.36, 0, 0, 6.2832);
    g.fill();
  } else if (f.mouth === 'cat' || kind === 'cat') {
    // two small arcs, the "w" cat mouth
    g.beginPath();
    g.moveTo(cx - w, cy - w * 0.20);
    g.quadraticCurveTo(cx - w * 0.5, cy + w * 0.48, cx, cy - w * 0.06);
    g.quadraticCurveTo(cx + w * 0.5, cy + w * 0.48, cx + w, cy - w * 0.20);
    g.stroke();
  } else if (f.mouth === 'caret') {
    g.beginPath();                 // ︿ — the sheep's tiny worried caret
    g.moveTo(cx - w * 0.8, cy + w * 0.30);
    g.lineTo(cx, cy - w * 0.24);
    g.lineTo(cx + w * 0.8, cy + w * 0.30);
    g.stroke();
  } else {                         // single smile curve
    g.beginPath();
    g.moveTo(cx - w, cy - w * 0.22);
    g.quadraticCurveTo(cx, cy + w * 0.72, cx + w, cy - w * 0.22);
    g.stroke();
  }
  g.restore();
}

/**
 * The face PLATE — reference #3, and `pw_00` is the calibration frame: the sheep's
 * features sit on "a distinct colour patch", a big hard-ish brown oval set into the
 * white fleece. Drawing that patch here rather than painting it into the vertex colours
 * matters for two reasons: it is registered with the eyes to the pixel, and it has a
 * real edge instead of a vertex-interpolated smear.
 */
function drawPlate(g, f, S) {
  const pl = f.plate;
  const cx = S * 0.5, cy = S * pl.y, rx = S * pl.rx, ry = S * pl.ry;
  const soft = pl.soft ?? 0.14;
  g.save();
  g.translate(cx, cy);
  g.scale(1, ry / rx);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  grd.addColorStop(0, pl.color);
  grd.addColorStop(Math.max(0, 1 - soft), pl.color);
  grd.addColorStop(1, pl.edge || fade(pl.color));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(0, 0, rx, 0, 6.2832);
  g.fill();
  g.restore();
}

function drawCell(g, f, S, expr) {
  if (f.plate) drawPlate(g, f, S);
  // muzzle / face colour patch first, so features sit on it (sheep's brown face, monkey's cream)
  if (f.muzzle) {
    const m = f.muzzle;
    g.save();
    g.fillStyle = m.color;
    g.beginPath();
    g.ellipse(S * 0.5, S * m.y, S * m.rx, S * m.ry, 0, 0, 6.2832);
    g.fill();
    g.restore();
  }
  if (f.blush) {
    for (const side of [-1, 1]) {
      const x = S * (0.5 + side * (f.blushGap || 0.30)), y = S * (f.blushY || 0.60);
      const r = S * (f.blushR || 0.085);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, f.blush);
      grd.addColorStop(1, f.blush.replace(/[\d.]+\)$/, '0)'));
      g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
  }

  let mouth = f.mouth;
  for (const side of [-1, 1]) {
    switch (expr) {
      case 'blink': drawClosedEye(g, f, S, side, 'blink'); break;
      case 'happy': drawClosedEye(g, f, S, side, 'happy'); break;
      case 'sleepy': drawClosedEye(g, f, S, side, 'sleepy'); break;
      case 'wide': drawOpenEye(g, f, S, side, { scale: 1.15, lid: 1.06, slantMul: 0.25 }); break;
      case 'wary': drawOpenEye(g, f, S, side, { scale: 0.99, lid: 0.34, slantMul: 1.5 }); break;
      case 'smug': drawOpenEye(g, f, S, side, { scale: 1.0, lid: 0.26, squash: 0.86 }); break;
      case 'chew': drawOpenEye(g, f, S, side, { scale: 0.97, lid: 0.55 }); break;
      default: drawOpenEye(g, f, S, side, {}); break;
    }
  }
  if (expr === 'wide') mouth = 'open';
  if (expr === 'chew') mouth = 'chew';
  if (expr === 'happy') mouth = 'open';
  if (expr === 'wary') mouth = 'caret';
  drawMouth(g, f, S, mouth);

  if (f.nose) {
    g.save();
    g.fillStyle = f.nose.color || f.outline;
    const nx = S * 0.5, ny = S * f.nose.y, nw = S * f.nose.w;
    g.beginPath();
    g.moveTo(nx - nw, ny - nw * 0.45);
    g.quadraticCurveTo(nx, ny - nw * 0.8, nx + nw, ny - nw * 0.45);
    g.quadraticCurveTo(nx + nw * 0.35, ny + nw * 0.85, nx, ny + nw * 0.9);
    g.quadraticCurveTo(nx - nw * 0.35, ny + nw * 0.85, nx - nw, ny - nw * 0.45);
    g.fill();
    g.restore();
  }
}

/** Build the whole 4x2 expression atlas for one species. */
export function faceAtlas(face) {
  const c = mkCanvas(COLS * CELL, ROWS * CELL);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  for (let i = 0; i < EXPRESSIONS.length; i++) {
    const col = i % COLS, row = Math.floor(i / COLS);
    g.save();
    g.translate(col * CELL, row * CELL);
    g.beginPath(); g.rect(0, 0, CELL, CELL); g.clip();
    drawCell(g, face, CELL, EXPRESSIONS[i]);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1 / COLS, 1 / ROWS);
  const o = expressionOffset('neutral');
  t.offset.set(o[0], o[1]);
  return t;
}
