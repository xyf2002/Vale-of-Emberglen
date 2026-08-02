import * as THREE from 'three';
import { Game } from './engine/Game.js';
import { createWorld } from './world/index.js';
import { createSky } from './sky/index.js';
import { createPlayer } from './player/index.js';
import { createCreatures } from './creatures/index.js';
import { createAI } from './ai/index.js';
import { createInteraction } from './interaction/index.js';
import { createUI } from './ui/index.js';
import { createAudio } from './audio/index.js';
import { createPost } from './post/index.js';
import { installCaptureApi } from './engine/Capture.js';

const params = new URLSearchParams(location.search);
const capture = params.get('capture') === '1';
const seed = Number(params.get('seed') ?? 20240719);

const errors = [];
window.addEventListener('error', (e) => errors.push({ type: 'error', msg: String(e.message), stack: e.error?.stack }));
window.addEventListener('unhandledrejection', (e) => errors.push({ type: 'reject', msg: String(e.reason?.message ?? e.reason), stack: e.reason?.stack }));

const container = document.getElementById('app');
const game = new Game({ container, seed, capture });

// Registration order here is only for readability — actual update order comes from
// each system's `order` field (see engine/Game.js ORDER).
game.register(createWorld());
game.register(createSky());
game.register(createPlayer());
game.register(createCreatures());
game.register(createAI());
game.register(createInteraction());
game.register(createUI());
game.register(createAudio());
game.register(createPost());

const bar = document.getElementById('boot-bar');
const msg = document.getElementById('boot-msg');
const BOOT_TEXT = {
  world: 'raising the hills…', sky: 'hanging the sun…', player: 'waking the traveller…',
  creatures: 'hatching the pals…', ai: 'teaching them to be curious…',
  interaction: 'filling your satchel…', ui: 'inking the journal…',
  audio: 'tuning the wind…', post: 'grading the light…', ready: 'ready',
};

installCaptureApi(game, { errors, THREE });

game.init((p, name) => {
  if (bar) bar.style.width = `${Math.round(p * 100)}%`;
  if (msg) msg.textContent = BOOT_TEXT[name] ?? name;
}).then(() => {
  window.__game.ready = true;
  if (capture) {
    // Harness owns the clock. The boot overlay must be gone *immediately* — if it
    // lingers, every capture is a screenshot of the loading screen and the whole
    // A/B pipeline silently compares title cards.
    document.getElementById('boot')?.remove();
    game.render();
  } else {
    document.getElementById('boot')?.classList.add('hidden');
    setTimeout(() => document.getElementById('boot')?.remove(), 800);
    game.start();
  }
}).catch((err) => {
  errors.push({ type: 'init', msg: String(err?.message ?? err), stack: err?.stack });
  window.__game.ready = 'failed';
  if (msg) { msg.textContent = 'failed to start — see console'; msg.style.color = '#ff8a8a'; }
  console.error(err);
});

if (import.meta.env?.DEV) window.THREE = THREE;
