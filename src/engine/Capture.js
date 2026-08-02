/**
 * window.__game — the only surface tools/capture.mjs (and therefore every critic agent)
 * touches. Everything here must stay stable; systems may add fields via
 * bus.emit('capture:extend', {key, fn}) rather than editing this file.
 *
 * Contract: the harness never uses wall-clock time. It calls advance(seconds) to run
 * the simulation deterministically, then render(), then screenshots. Same seed +
 * same script => same pixels, which is what makes round-over-round A/B meaningful.
 */
export function installCaptureApi(game, { errors, THREE }) {
  const extras = {};
  game.bus.on('capture:extend', ({ key, fn }) => { extras[key] = fn; });

  const api = {
    ready: false,
    errors,
    version: 1,
    get seed() { return game.seed; },
    get elapsed() { return game.elapsed; },

    // ---- clock ----------------------------------------------------------
    advance(seconds, dt) { return game.advance(seconds, dt); },
    render() { game.render(); },
    /** advance then render — the normal harness call */
    run(seconds, dt) { const n = game.advance(seconds, dt); game.render(); return n; },
    setTimeScale(s) { game.timeScale = s; },

    // ---- input ----------------------------------------------------------
    hold(action, down = true) { game.input.set(action, down); },
    tap(action) { game.input.tap(action); },
    look(dx, dy) { game.input.addLook(dx, dy); },
    releaseAll() { game.input.setScripted(true); },

    // ---- direct staging for matched-shot A/B ----------------------------
    /** put the player somewhere and face them at a yaw in degrees */
    place(x, z, yawDeg) { return game.get('player')?.place?.(x, z, yawDeg); },
    /** 0..1 through the day; 0.25 morning, 0.5 noon, 0.72 golden hour, 0.85 dusk */
    setTimeOfDay(t) { return game.get('sky')?.setTimeOfDay?.(t); },
    setWeather(name, amount) { return game.get('sky')?.setWeather?.(name, amount); },
    /** free-fly the camera for establishing shots; pass null to return to gameplay cam */
    setCamera(pos, target, fov) {
      const p = game.get('player');
      if (pos === null) { p?.camera?.setOverride?.(null); return; }
      p?.camera?.setOverride?.({ pos, target, fov });
    },
    spawnCreature(species, x, z) { return game.get('creatures')?.spawn?.(species, x, z); },

    // ---- observation ----------------------------------------------------
    state() {
      const out = { elapsed: game.elapsed, frame: game.frame, seed: game.seed, errors: errors.length };
      for (const s of game.systems) if (s.snapshot) { try { out[s.name] = s.snapshot(); } catch (e) { out[s.name] = { error: String(e) }; } }
      for (const [k, fn] of Object.entries(extras)) { try { out[k] = fn(); } catch { /* ignore */ } }
      return out;
    },
    events(n = 80) { return game.bus.log.slice(-n); },
    stats() {
      const info = game.renderer.info;
      return {
        drawCalls: info.render.calls, triangles: info.render.triangles,
        programs: info.programs?.length ?? 0, textures: info.memory.textures, geometries: info.memory.geometries,
        quality: game.quality.tier,
      };
    },
  };

  window.__game = api;
  window.__THREE = THREE;
  return api;
}
