import { ORDER } from '../engine/Game.js';

/**
 * UI SYSTEM — owned by the UI builder. DOM overlay in #ui-root (not WebGL), so it can be
 * styled properly. Owns HUD, interaction prompts, notifications, the creature journal,
 * and the opening moments that teach the player how to play without a wall of text.
 *
 * PUBLIC CONTRACT:
 *   notify(text, opts)            transient toast
 *   showPrompt({text,key}|null)   contextual action prompt
 *   setJournalOpen(bool)
 *   snapshot()  -> must include { visibleText: string[] } so critics can assert what
 *                  the player is actually being told at a given moment.
 *
 * STUB: a prompt line and a toast stack.
 */
export function createUI() {
  let ctx, root, promptEl, toastEl;
  const toasts = [];
  let currentPrompt = null;

  return {
    name: 'ui',
    order: ORDER.UI,

    init(c) {
      ctx = c;
      root = document.getElementById('ui-root');
      root.innerHTML = `
        <div id="hud" style="position:absolute;inset:0;font:500 14px/1.4 ui-sans-serif,system-ui">
          <div id="prompt" style="position:absolute;left:50%;bottom:16%;transform:translateX(-50%);
            padding:8px 14px;border-radius:999px;background:#0009;backdrop-filter:blur(6px);
            border:1px solid #ffffff2a;opacity:0;transition:opacity .18s"></div>
          <div id="toasts" style="position:absolute;left:24px;bottom:24px;display:flex;
            flex-direction:column;gap:6px"></div>
        </div>`;
      promptEl = root.querySelector('#prompt');
      toastEl = root.querySelector('#toasts');

      c.bus.on('creature:fed', ({ creature }) => this.notify(`${creature.def.name} nibbles the berry.`));
      c.bus.on('creature:tamed', ({ creature }) => this.notify(`${creature.def.name} trusts you now.`));
    },

    update(dt, c) {
      const p = c.get('interaction')?.prompt ?? null;
      this.showPrompt(p);
      for (let i = toasts.length - 1; i >= 0; i--) {
        toasts[i].t -= dt;
        if (toasts[i].t <= 0) { toasts[i].el.remove(); toasts.splice(i, 1); }
      }
    },

    showPrompt(p) {
      currentPrompt = p;
      if (!promptEl) return;
      if (p) {
        promptEl.innerHTML = `<b style="color:#e8b45c">[${p.key}]</b> ${p.text}`;
        promptEl.style.opacity = '1';
      } else promptEl.style.opacity = '0';
    },

    notify(text, { ttl = 3.5 } = {}) {
      if (!toastEl) return;
      const el = document.createElement('div');
      el.textContent = text;
      el.style.cssText = 'padding:7px 12px;border-radius:8px;background:#000000aa;border:1px solid #ffffff1f';
      toastEl.appendChild(el);
      toasts.push({ el, t: ttl, text });
    },

    setJournalOpen() {},

    snapshot() {
      return {
        prompt: currentPrompt?.text ?? null,
        visibleText: [currentPrompt ? `[${currentPrompt.key}] ${currentPrompt.text}` : null,
          ...toasts.map((t) => t.text)].filter(Boolean),
      };
    },
  };
}
