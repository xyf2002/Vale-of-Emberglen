import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ORDER } from '../engine/Game.js';
import { BloomPass, DofPass, MaterialPass, makeGradeMaterial, makeFinishMaterial } from './passes.js';
import { resolveGrade, NAMED } from './grades.js';

/**
 * POST-PROCESSING / IMAGE SYSTEM — owned by the look-dev builder. If this system exposes
 * a render(), Game.render() calls it INSTEAD of renderer.render(). That makes it the
 * single place to own the final image: bloom, colour grade, vignette, DOF, AA, exposure.
 *
 * PUBLIC CONTRACT:
 *   render(ctx)                     optional; when absent the engine renders directly
 *   setGrade(name)                  named look ('dawn','noon','golden','dusk','night')
 *   snapshot()
 *
 * Note: it must degrade gracefully — if ctx.quality.post is false, fall back to a plain
 * render rather than shipping a broken frame.
 *
 * ---------------------------------------------------------------------------
 * THE CHAIN (HDR half-float throughout until the grade encodes to sRGB):
 *
 *   RenderPass ......... scene -> linear HDR, with a depth texture attached
 *   DofPass ............ portrait lenses only (fov < 46). Autofocuses on frame
 *                        centre; gives the background compression reference #11
 *                        calls for and is skipped entirely on wide shots.
 *   BloomPass .......... soft-knee threshold + 4-mip dual-filter chain, half res.
 *                        Produces a side texture only; it never touches the colour
 *                        buffer, so bloom is composited in scene-referred linear
 *                        inside the grade and rolled off by the tone curve.
 *   Grade .............. exposure / white balance -> ACES (three's exact fit) ->
 *                        contrast -> ASC-CDL -> split tone -> chroma-dependent
 *                        saturation -> green-toward-yellow steer -> sRGB.
 *   SMAAPass ........... antialiasing on the encoded image.
 *   Finish ............. chromatic aberration, vignette, film grain.
 *
 * Why the grade owns the tone curve: the engine sets ACESFilmicToneMapping on the
 * renderer, but three only applies tone mapping when drawing to the default
 * framebuffer. Rendering through a composer therefore silently loses it. The ACES
 * fit in passes.js is copied verbatim from three's chunk so that turning post off
 * changes the amount of polish, not the exposure of the whole game.
 *
 * Determinism: no wall-clock anywhere. Grain is seeded from ctx.frame.
 */
export function createPost() {
  let ctx = null;
  let grade = 'auto';
  let enabled = false;
  let failures = 0;

  let composer = null;
  let renderPass = null, dofPass = null, bloomPass = null, gradePass = null, smaaPass = null, finishPass = null;
  let gradeMat = null, finishMat = null;
  let sceneRT = null;
  const size = new THREE.Vector2();
  let builtW = 0, builtH = 0;

  // manual overrides on top of the resolved look; null == follow the look table
  const overrides = { exposure: null, bloom: null, vignette: null, grain: null, aberration: null };
  let dofMode = 'auto';        // 'auto' | 'on' | 'off'
  let dofStrength = 1.0;
  let lastLook = null;
  let lastDof = false;

  function dispose() {
    dofPass?.dispose(); bloomPass?.dispose(); gradePass?.dispose();
    finishPass?.dispose(); smaaPass?.dispose?.();
    sceneRT?.dispose();
    composer?.renderTarget1?.dispose(); composer?.renderTarget2?.dispose();
    composer = null;
  }

  function build(w, h) {
    dispose();
    const renderer = ctx.renderer;

    sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    sceneRT.texture.name = 'post.scene';
    // DOF needs scene depth. RenderPass writes into the composer's write buffer, so
    // the depth attachment travels with it and DofPass picks it off readBuffer.
    sceneRT.depthTexture = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);

    composer = new EffectComposer(renderer, sceneRT);
    composer.renderToScreen = true;

    renderPass = new RenderPass(ctx.scene, ctx.camera);
    composer.addPass(renderPass);

    dofPass = new DofPass(ctx.camera, w, h);
    dofPass.setSize(w, h);
    dofPass.enabled = false;
    composer.addPass(dofPass);

    bloomPass = new BloomPass(w, h, 4);
    composer.addPass(bloomPass);

    gradeMat = makeGradeMaterial();
    gradeMat.uniforms.tBloom.value = bloomPass.texture;
    gradePass = new MaterialPass(gradeMat);
    composer.addPass(gradePass);

    smaaPass = new SMAAPass();
    smaaPass.setSize(w, h);
    composer.addPass(smaaPass);

    finishMat = makeFinishMaterial(w, h);
    finishPass = new MaterialPass(finishMat);
    composer.addPass(finishPass);

    builtW = w; builtH = h;
  }

  /** SMAA loads its area/search LUTs from data URIs asynchronously. Never blend with
   *  half-decoded LUTs — that is exactly the kind of "broken frame" we must not ship. */
  function smaaReady() {
    const a = smaaPass?._areaTexture?.image;
    const s = smaaPass?._searchTexture?.image;
    return !!(a && s && a.complete && s.complete && a.width > 0 && s.width > 0);
  }

  function syncSize() {
    ctx.renderer.getDrawingBufferSize(size);
    const w = Math.max(2, Math.floor(size.x));
    const h = Math.max(2, Math.floor(size.y));
    if (w !== builtW || h !== builtH) build(w, h);
  }

  function resolveLook() {
    if (grade !== 'auto' && NAMED[grade]) return NAMED[grade];
    const sky = ctx.get('sky');
    const t = typeof sky?.timeOfDay === 'number' ? sky.timeOfDay : 0.5;
    return resolveGrade(t);
  }

  function v3(u, arr) { u.value.set(arr[0], arr[1], arr[2]); }

  function apply(look, frame) {
    const g = gradeMat.uniforms;
    g.uExposure.value = overrides.exposure ?? look.exposure;
    v3(g.uWhiteBalance, look.whiteBalance);
    g.uContrast.value = look.contrast;
    g.uPivot.value = look.pivot;
    v3(g.uSlope, look.slope);
    v3(g.uOffset, look.offset);
    v3(g.uPower, look.power);
    v3(g.uShadowTint, look.shadowTint);
    v3(g.uHighTint, look.highTint);
    g.uSatLow.value = look.satLow;
    g.uSatHigh.value = look.satHigh;
    g.uGreenShift.value = look.greenShift;
    g.uGreenSat.value = look.greenSat;
    g.uBloomStrength.value = overrides.bloom ?? look.bloomStrength;
    v3(g.uBloomTint, look.bloomTint);

    bloomPass.threshold = look.bloomThreshold;
    bloomPass.knee = look.bloomKnee;

    const f = finishMat.uniforms;
    f.uVignette.value = overrides.vignette ?? look.vignette;
    f.uVigStart.value = look.vigStart;
    f.uAberration.value = overrides.aberration ?? look.aberration;
    f.uGrain.value = overrides.grain ?? look.grain;
    f.uResolution.value.set(builtW, builtH);
    f.uSeed.value = (frame % 61) * 7.13;

    // Portrait lens => shallow depth of field. Reference #11: portraits break the
    // third-person camera rules, go longer-lens, and show visible background
    // compression and defocus. Wide shots must stay crisp edge to edge.
    const fov = ctx.camera.fov ?? 60;
    const want = dofMode === 'on' || (dofMode === 'auto' && fov < 46);
    dofPass.enabled = want;
    dofPass.material.uniforms.uStrength.value = dofStrength;
    lastDof = want;
  }

  return {
    name: 'post',
    order: ORDER.POST,

    init(c) {
      ctx = c;
      if (!c.quality?.post) { enabled = false; return; }
      try {
        c.renderer.getDrawingBufferSize(size);
        build(Math.max(2, Math.floor(size.x)), Math.max(2, Math.floor(size.y)));
        enabled = true;
      } catch (err) {
        console.warn('[post] chain unavailable, falling back to direct render:', err);
        enabled = false;
      }
      c.bus.on('resize', () => { if (enabled) { try { syncSize(); } catch { /* rebuilt next frame */ } } });
    },

    render(c) {
      const renderer = c.renderer;
      if (!enabled || !composer) { renderer.render(c.scene, c.camera); return; }
      try {
        syncSize();
        // Every pass calls renderer.render() internally, which auto-resets info and
        // would leave the harness reporting "1 draw call". Own the counter so the
        // perf numbers other agents read stay truthful.
        renderer.info.autoReset = false;
        renderer.info.reset();
        renderPass.scene = c.scene;
        renderPass.camera = c.camera;
        dofPass.camera = c.camera;
        lastLook = resolveLook();
        apply(lastLook, c.frame ?? 0);
        smaaPass.enabled = smaaReady();
        composer.render(c.dt ?? 1 / 60);
      } catch (err) {
        failures++;
        if (failures === 1) console.warn('[post] chain threw, falling back:', err);
        if (failures > 3) { enabled = false; dispose(); }
        renderer.setRenderTarget(null);
        renderer.render(c.scene, c.camera);
      }
    },

    /** named look ('dawn','morning','noon','golden','dusk','night') or 'auto' */
    setGrade(g) { grade = g ?? 'auto'; },

    /** 'auto' | 'on' | 'off', plus an optional aperture multiplier */
    setDOF(mode, strength) {
      if (typeof mode === 'boolean') mode = mode ? 'on' : 'off';
      if (mode) dofMode = mode;
      if (typeof strength === 'number') dofStrength = strength;
    },

    /** nudge individual knobs without leaving the time-of-day table; null resets */
    setOverride(key, value) { if (key in overrides) overrides[key] = value; },

    snapshot() {
      return {
        grade, enabled,
        look: lastLook?.key ?? null,
        exposure: lastLook ? +(overrides.exposure ?? lastLook.exposure).toFixed(3) : null,
        bloom: lastLook ? +(overrides.bloom ?? lastLook.bloomStrength).toFixed(3) : null,
        vignette: lastLook ? +(overrides.vignette ?? lastLook.vignette).toFixed(3) : null,
        dof: lastDof,
        aa: enabled ? 'smaa' : 'none',
        size: [builtW, builtH],
        failures,
      };
    },
  };
}
