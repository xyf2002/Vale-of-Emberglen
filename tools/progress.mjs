#!/usr/bin/env node
/**
 * Regenerates progress/index.html from progress/state.json + whatever is in captures/.
 * Open progress/index.html directly in a browser (file:// works — all paths are relative).
 *
 *   node tools/progress.mjs
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const state = JSON.parse(await readFile('progress/state.json', 'utf8'));

async function shotsFor(roundId) {
  const dir = path.join('captures', roundId);
  if (!existsSync(dir)) return { shots: [], strips: [], report: null };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.png'));
  let report = null;
  try { report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8')); } catch { /* none */ }
  const isStrip = (f) => /_\d\d\.png$/.test(f);
  return {
    shots: files.filter((f) => !isStrip(f)).sort(),
    strips: files.filter(isStrip).sort(),
    report,
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const rounds = [];
for (const r of state.rounds) rounds.push({ ...r, ...(await shotsFor(r.id)) });
rounds.reverse(); // newest first

const badge = (s) => {
  const m = { running: ['#e8b45c', 'running'], done: ['#7fd18b', 'complete'], failed: ['#ff8a8a', 'failed'], planned: ['#8a8f99', 'planned'] };
  const [c, t] = m[s] ?? ['#8a8f99', s];
  return `<span class="badge" style="--c:${c}">${t}</span>`;
};

const scoreBar = (v) => {
  if (v == null) return '<span class="dim">—</span>';
  const pct = Math.round(v * 100);
  return `<span class="meter"><i style="width:${pct}%"></i></span><b>${pct}%</b>`;
};

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vale of Emberglen — gauntlet progress</title>
<style>
:root{--bg:#0b0d12;--panel:#12151c;--line:#232833;--txt:#e6e8ec;--dim:#8a90a0;--gold:#e8b45c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:34px 32px 22px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,#151922,#0b0d12)}
h1{margin:0 0 6px;font-size:26px;font-weight:600;letter-spacing:-.01em}
h1 em{color:var(--gold);font-style:normal}
.sub{color:var(--dim);font-size:14px;max-width:70ch}
main{padding:26px 32px 80px;max-width:1500px;margin:0 auto}
.bar{display:flex;gap:14px;flex-wrap:wrap;margin:22px 0 30px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:13px 17px;min-width:150px}
.stat .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.09em}
.stat .v{font-size:21px;font-weight:600;margin-top:3px}
.round{background:var(--panel);border:1px solid var(--line);border-radius:14px;margin-bottom:22px;overflow:hidden}
.round>summary{padding:15px 20px;cursor:pointer;display:flex;align-items:center;gap:13px;
  list-style:none;font-weight:600}
.round>summary::-webkit-details-marker{display:none}
.round>summary:hover{background:#171b24}
.badge{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;
  color:var(--c);border:1px solid color-mix(in srgb,var(--c) 40%,transparent);
  background:color-mix(in srgb,var(--c) 12%,transparent);padding:2px 9px;border-radius:99px}
.round .body{padding:6px 20px 22px;border-top:1px solid var(--line)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin:16px 0}
@media(max-width:820px){.cols{grid-template-columns:1fr}}
h3{font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:16px 0 8px}
ul{margin:0;padding-left:19px}li{margin:4px 0}
li.gap::marker{color:var(--gold)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:12px}
.shot{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#0d1016}
.shot img{width:100%;display:block;aspect-ratio:16/9;object-fit:cover;cursor:zoom-in;
  background:#000;transition:transform .25s}
.shot img:hover{transform:scale(1.02)}
.shot .cap{padding:7px 10px;font-size:12px;color:var(--dim);
  display:flex;justify-content:space-between;gap:8px}
.strip{display:flex;gap:3px;overflow-x:auto;padding-bottom:6px}
.strip img{height:104px;border-radius:5px;cursor:zoom-in;flex:0 0 auto}
.meter{display:inline-block;width:78px;height:6px;background:#ffffff18;border-radius:9px;
  overflow:hidden;vertical-align:middle;margin-right:7px}
.meter i{display:block;height:100%;background:linear-gradient(90deg,#e8b45c,#7fd18b)}
table{border-collapse:collapse;font-size:13px;width:100%}
td,th{text-align:left;padding:5px 12px 5px 0;border-bottom:1px solid var(--line)}
th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.07em}
.dim{color:var(--dim)}
.verdict{border-left:2px solid var(--gold);padding:3px 0 3px 13px;margin:9px 0;color:#cfd3da}
#lb{position:fixed;inset:0;background:#000d;display:none;align-items:center;justify-content:center;
  z-index:50;cursor:zoom-out;padding:24px}
#lb img{max-width:100%;max-height:100%;border-radius:6px}
footer{color:var(--dim);font-size:12px;padding:0 32px 40px;max-width:1500px;margin:0 auto}
code{background:#ffffff12;padding:1px 6px;border-radius:4px;font-size:12.5px}
</style></head><body>
<header>
  <h1>Vale of Emberglen <em>— gauntlet progress</em></h1>
  <div class="sub">${esc(state.goal)}</div>
</header>
<main>
  <div class="bar">
    <div class="stat"><div class="k">Round</div><div class="v">${esc(state.currentRound)}</div></div>
    <div class="stat"><div class="k">State</div><div class="v" style="font-size:15px">${esc(state.currentState)}</div></div>
    <div class="stat"><div class="k">Real-game pick rate</div><div class="v">${scoreBar(state.pickRate)}</div></div>
    <div class="stat"><div class="k">Improvements landed</div><div class="v">${state.rounds.reduce((a, r) => a + (r.improvements?.length ?? 0), 0)}</div></div>
    <div class="stat"><div class="k">Open gaps</div><div class="v">${state.openGaps?.length ?? 0}</div></div>
  </div>

  <h3>The bar</h3>
  <div class="verdict">${esc(state.bar)}</div>

  <h3>Biggest remaining gaps</h3>
  <ul>${(state.openGaps ?? []).map((g) => `<li class="gap">${esc(g)}</li>`).join('') || '<li class="dim">none recorded yet</li>'}</ul>

  <h3 style="margin-top:30px">Rounds</h3>
  ${rounds.map((r, i) => `
  <details class="round" ${i === 0 ? 'open' : ''}>
    <summary>${esc(r.id)} — ${esc(r.title)} ${badge(r.status)}
      <span style="margin-left:auto;font-weight:400;color:var(--dim);font-size:13px">${esc(r.date ?? '')}</span></summary>
    <div class="body">
      ${r.summary ? `<div class="verdict">${esc(r.summary)}</div>` : ''}
      <div class="cols">
        <div><h3>Improvements landed</h3><ul>${(r.improvements ?? []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="dim">—</li>'}</ul></div>
        <div><h3>Gaps found by critics</h3><ul>${(r.gaps ?? []).map((x) => `<li class="gap">${esc(x)}</li>`).join('') || '<li class="dim">—</li>'}</ul></div>
      </div>
      ${r.verdicts?.length ? `<h3>Critic verdicts</h3><table><tr><th>Shot</th><th>Picked as real</th><th>Note</th></tr>
        ${r.verdicts.map((v) => `<tr><td>${esc(v.shot)}</td><td>${v.oursPicked ? '<b style="color:#7fd18b">ours</b>' : '<span class="dim">reference</span>'}</td><td class="dim">${esc(v.note)}</td></tr>`).join('')}</table>` : ''}
      ${r.shots?.length ? `<h3>Frames</h3><div class="grid">${r.shots.map((f) => {
    const meta = r.report?.shots?.find((s) => s.id === f.replace(/\.png$/, ''));
    return `<div class="shot"><img loading="lazy" src="../captures/${esc(r.id)}/${esc(f)}" alt="${esc(f)}">
        <div class="cap"><span>${esc(f.replace(/\.png$/, ''))}</span><span>${meta ? esc(meta.stats.drawCalls + ' draws') : ''}</span></div></div>`;
  }).join('')}</div>` : '<p class="dim">no captures yet</p>'}
      ${r.strips?.length ? `<h3>Motion strips</h3><div class="strip">${r.strips.map((f) => `<img loading="lazy" src="../captures/${esc(r.id)}/${esc(f)}" alt="${esc(f)}">`).join('')}</div>` : ''}
    </div>
  </details>`).join('')}
</main>
<footer>Regenerate with <code>node tools/progress.mjs</code> · captures via <code>node tools/capture.mjs --round &lt;id&gt;</code> · generated ${new Date().toISOString()}</footer>
<div id="lb"><img></div>
<script>
const lb=document.getElementById('lb'),lbi=lb.querySelector('img');
document.addEventListener('click',e=>{
  if(e.target.tagName==='IMG'&&e.target.closest('.shot,.strip')){lbi.src=e.target.src;lb.style.display='flex';}
  else if(e.target===lb||e.target===lbi){lb.style.display='none';}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape')lb.style.display='none';});
</script>
</body></html>`;

await writeFile('progress/index.html', html);
console.log(`progress/index.html updated — ${rounds.length} rounds, ${rounds.reduce((a, r) => a + r.shots.length, 0)} frames`);
