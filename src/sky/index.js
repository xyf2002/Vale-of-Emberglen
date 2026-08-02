import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';

/**
 * SKY & ATMOSPHERE SYSTEM — owned by the sky builder. Owns the single biggest lever on
 * whether a frame reads as "a beautiful world": sun/moon, sky gradient, clouds, fog,
 * light colour and intensity, day-night, weather.
 *
 * PUBLIC CONTRACT:
 *   timeOfDay            0..1 (0 midnight, 0.25 dawn, 0.5 noon, 0.72 golden, 0.85 dusk)
 *   setTimeOfDay(t)
 *   getSunDirection() -> THREE.Vector3 (unit, points FROM ground TOWARD sun)
 *   getSunColor() -> THREE.Color
 *   setWeather(name, amount0to1)   'clear' | 'cloudy' | 'rain' | 'fog'
 *   sunLight -> THREE.DirectionalLight   (others may read for shadow config)
 *
 * STUB: hemisphere + directional light with a flat background colour.
 */
export function createSky() {
  let ctx;
  const state = { timeOfDay: 0.3, weather: 'clear', weatherAmount: 0, daySpeed: 1 / 600 };
  let sun, hemi;
  const sunDir = new THREE.Vector3();

  function apply() {
    const t = state.timeOfDay;
    const ang = (t - 0.25) * Math.PI * 2;
    sunDir.set(Math.cos(ang) * 0.6, Math.sin(ang), Math.sin(ang) * 0.35 + 0.25).normalize();
    const day = Math.max(0, sunDir.y);
    sun.position.copy(sunDir).multiplyScalar(300);
    sun.intensity = 0.25 + day * 2.6;
    sun.color.setHSL(0.09 + day * 0.05, 0.65 - day * 0.35, 0.5 + day * 0.12);
    hemi.intensity = 0.15 + day * 0.55;
    const sky = new THREE.Color().setHSL(0.58, 0.55, 0.12 + day * 0.45);
    ctx.scene.background = sky;
    ctx.scene.fog = new THREE.Fog(sky.getHex(), 120, ctx.quality.drawDistance);
  }

  return {
    name: 'sky',
    order: ORDER.SKY,
    get timeOfDay() { return state.timeOfDay; },
    get sunLight() { return sun; },

    init(c) {
      ctx = c;
      sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.castShadow = true;
      const s = 160, m = c.quality.shadowMapSize;
      sun.shadow.mapSize.set(m, m);
      sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
      sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
      sun.shadow.camera.near = 1; sun.shadow.camera.far = 700;
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.35;
      c.scene.add(sun, sun.target);
      hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a4433, 0.6);
      c.scene.add(hemi);
      apply();
    },

    update(dt, c) {
      state.timeOfDay = (state.timeOfDay + dt * state.daySpeed) % 1;
      apply();
      // keep the shadow frustum centred on the player
      const p = c.get('player')?.position;
      if (p) { sun.target.position.copy(p); sun.target.updateMatrixWorld(); sun.position.copy(p).addScaledVector(sunDir, 300); }
    },

    setTimeOfDay(t) { state.timeOfDay = ((t % 1) + 1) % 1; apply(); },
    getSunDirection() { return sunDir.clone(); },
    getSunColor() { return sun.color.clone(); },
    setWeather(name, amount = 1) { state.weather = name; state.weatherAmount = amount; },
    snapshot() { return { timeOfDay: +state.timeOfDay.toFixed(4), weather: state.weather, sunY: +sunDir.y.toFixed(3) }; },
  };
}
