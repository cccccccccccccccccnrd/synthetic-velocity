// synthetic velocity: 2D source forms → reflective 3D pipes → temporal shutter shader
import * as THREE from "https://esm.sh/three@0.171.0";
import { SVGLoader } from "https://esm.sh/three@0.171.0/examples/jsm/loaders/SVGLoader.js";
import { OrbitControls } from "https://esm.sh/three@0.171.0/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "https://esm.sh/three@0.171.0/examples/jsm/environments/RoomEnvironment.js";

(() => {
  const iframe = document.getElementById("preview");
  if (!iframe) return;

  const canvas = document.createElement("canvas");
  canvas.className = "abstract-shader-canvas";
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.1;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 0, 17.0);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.dampingFactor = 0;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.minDistance = 0.8;
  controls.maxDistance = 60;
  controls.target.set(0, 0, 0);
  controls.update();

  const root = new THREE.Group();
  scene.add(root);

  const params = {
    pipeRadius: 0.045,
    metalness: 0.78,
    roughness: 0.169,
    clearcoat: 1.0,
    transmission: 0.0,
    thickness: 0.0,
    ior: 1.48,
    specularIntensity: 1.0,
    reflectionOnly: 1.0,
    reflectionFloor: 0.035,
    reflectionGain: 1.25,
    pipeOpacity: 0.53,
    envIntensity: 12.0,
    exposure: 0.55,
    pipeGlow: 0.0,
    hdriLight: 0.0,
    ambientLight: 1.15,
    frontLight: 4.5,
    pinkLight: 3.6,
    blueLight: 3.2,
    rimLight: 5.0,
    tiltX: 0.0,
    tiltY: 0.0,
    spinSpeed: 0.0,
    trailEnabled: 1,
    trailMotion: -0.018,
    syntheticTrail: 1,
    syntheticVelocityX: -0.064,
    syntheticVelocityY: 0.024,
    persistence: 0.94,
    trailLength: 2.8,
    trailOpacity: 0.93,
    sampleCount: 52,
    blurStrength: 1.0,
    velocityScale: 0.506,
    brightnessPersistence: 1.049,
    historyDecay: 0.908,
    motionThreshold: 0.0,
    highlightThreshold: 1.5,
    organicJitter: 0.4,
    trailBlendMode: 2,
    trailDebug: 0,
    historyScale: 1.0,
  };

  const FULLSCREEN_VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  const VELOCITY_VERTEX_SHADER = `
    uniform mat4 previousModelViewProjectionMatrix;
    varying vec4 vCurrentClip;
    varying vec4 vPreviousClip;

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vCurrentClip = projectionMatrix * viewMatrix * worldPosition;
      vPreviousClip = previousModelViewProjectionMatrix * vec4(position, 1.0);
      gl_Position = vCurrentClip;
    }
  `;

  const VELOCITY_FRAGMENT_SHADER = `
    varying vec4 vCurrentClip;
    varying vec4 vPreviousClip;

    void main() {
      vec2 currentNdc = vCurrentClip.xy / max(vCurrentClip.w, 1e-5);
      vec2 previousNdc = vPreviousClip.xy / max(vPreviousClip.w, 1e-5);
      // Convert NDC movement to UV-space movement. The accumulation pass reads
      // this vector as previous-position -> current-position screen velocity.
      vec2 velocity = (currentNdc - previousNdc) * 0.5;
      float moving = smoothstep(0.0006, 0.022, length(velocity));
      gl_FragColor = vec4(velocity * 0.5 + 0.5, moving, 1.0);
    }
  `;

  const ACCUMULATION_FRAGMENT_SHADER = `
    precision highp float;

    varying vec2 vUv;
    uniform sampler2D tCurrent;
    uniform sampler2D tHistory;
    uniform sampler2D tVelocity;
    uniform vec2 resolution;
    uniform float deltaTime;
    uniform float persistence;
    uniform float trailLength;
    uniform float trailOpacity;
    uniform int sampleCount;
    uniform float blurStrength;
    uniform float velocityScale;
    uniform float brightnessPersistence;
    uniform float historyDecay;
    uniform float motionThreshold;
    uniform float highlightThreshold;
    uniform float organicJitter;
    uniform float syntheticTrail;
    uniform vec2 syntheticVelocity;
    uniform int blendMode;
    uniform int debugView;
    uniform float frameIndex;

    const int MAX_SAMPLES = 64;

    float luma(vec3 color) {
      return dot(color, vec3(0.2126, 0.7152, 0.0722));
    }

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    vec3 toneSafe(vec3 color) {
      // Exposure-like shoulder. This keeps additive highlight persistence from
      // turning every old sample into clipped white while preserving sparkle.
      return color / (vec3(1.0) + max(color - 1.0, 0.0) * 0.55);
    }

    float edgeAt(sampler2D tex, vec2 uv) {
      vec2 px = 1.0 / max(resolution, vec2(1.0));
      float c = luma(texture2D(tex, uv).rgb);
      float n = 0.25 * (
        luma(texture2D(tex, uv + vec2(px.x, 0.0)).rgb) +
        luma(texture2D(tex, uv - vec2(px.x, 0.0)).rgb) +
        luma(texture2D(tex, uv + vec2(0.0, px.y)).rgb) +
        luma(texture2D(tex, uv - vec2(0.0, px.y)).rgb)
      );
      return smoothstep(0.015, 0.09, abs(c - n));
    }

    vec3 trailSource(sampler2D tex, vec2 uv) {
      vec3 color = texture2D(tex, uv).rgb;
      float lum = luma(color);
      float edge = edgeAt(tex, uv);
      float highlight = smoothstep(highlightThreshold, 1.0, lum);
      // Use edges and specular ridges as the exposed material. Avoid dragging
      // broad mid-grey surfaces through the frame, which makes the image flat.
      float photographicInk = clamp(edge * 1.15 + highlight * 0.85, 0.0, 1.0);
      return color * photographicInk;
    }

    void main() {
      vec2 uv = vUv;
      vec3 current = texture2D(tCurrent, uv).rgb;
      vec3 rawHistory = texture2D(tHistory, uv).rgb;
      vec4 velocitySample = texture2D(tVelocity, uv);
      vec2 realVelocity = (velocitySample.xy * 2.0 - 1.0);
      float subjectMask = smoothstep(0.025, 0.18, luma(current));
      // Synthetic shutter velocity: the object can remain visually locked-off
      // while the shader behaves as if it swept across the sensor during exposure.
      // This is the same idea as panning the camera with a fast subject: the
      // subject reads steady, but its exposure still records directional traces.
      // Keep this vector available in nearby dark pixels too; otherwise the
      // shader can only brighten the pipe silhouette and cannot draw trails.
      vec2 velocity = mix(realVelocity, syntheticVelocity, syntheticTrail) * velocityScale;
      float speed = length(velocity);
      vec2 direction = speed > 1e-5 ? velocity / speed : normalize(syntheticVelocity + vec2(1e-4, 0.0));
      vec2 perpendicular = vec2(-direction.y, direction.x);

      float difference = length(current - rawHistory);
      float velocityMask = smoothstep(0.0005, 0.018, speed) * max(velocitySample.z, subjectMask * syntheticTrail);
      float differenceMask = smoothstep(motionThreshold, motionThreshold * 2.25, difference);

      // History is sampled several times along the motion vector. The nonlinear
      // spacing and pulsed weights leave visible ghost silhouettes instead of a
      // perfectly averaged video-game blur.
      vec3 trail = vec3(0.0);
      float totalWeight = 0.0;
      int taps = clamp(sampleCount, 1, MAX_SAMPLES);
      for (int i = 0; i < MAX_SAMPLES; i++) {
        if (i >= taps) break;
        float n = taps > 1 ? float(i) / float(taps - 1) : 0.0;
        float temporal = pow(n, 1.22);
        float ghostPulse = 0.58 + 0.42 * pow(0.5 + 0.5 * cos(n * 18.8495559), 7.0);
        float jitter = hash12(uv * resolution * 0.012 + vec2(float(i) * 19.17, frameIndex * 0.071)) - 0.5;
        vec2 opticalWobble = perpendicular * jitter * organicJitter / max(resolution.y, 1.0) * 5.0;
        float highlightHere = smoothstep(highlightThreshold, 1.15, luma(rawHistory));
        vec2 sampleUv = uv - velocity * temporal * trailLength * (1.0 + highlightHere * 0.28) + opticalWobble;
        vec3 h = trailSource(tHistory, sampleUv);
        vec3 c = trailSource(tCurrent, uv + velocity * temporal * trailLength * 0.34 + opticalWobble);
        float weight = exp(-temporal * 3.35) * ghostPulse;
        // Bright/specular details behave as stronger long-exposure records.
        float highlightBoost = 1.0 + smoothstep(highlightThreshold, 1.0, luma(max(h, c))) * (brightnessPersistence - 1.0);
        trail += max(h, c * 0.55) * weight * highlightBoost;
        totalWeight += weight;
      }
      trail /= max(totalWeight, 1e-4);

      float trailMask = smoothstep(0.018, 0.20, luma(max(trail, trailSource(tHistory, uv) * 0.6)));
      float movingMask = clamp(max(max(velocityMask, differenceMask), trailMask * syntheticTrail), 0.0, 1.0);

      float historyLuma = luma(max(rawHistory, trail));
      float highlightBoost = smoothstep(highlightThreshold, 1.0, historyLuma);
      float exponentialDecay = exp(-historyDecay * max(deltaTime, 0.0));
      float localPersistence = clamp(persistence * exponentialDecay * mix(1.0, brightnessPersistence, highlightBoost), 0.0, 0.985);
      // Stationary background still converges to black/current, while generated
      // trail pixels are allowed to appear outside the present pipe silhouette.
      localPersistence *= mix(0.12, 1.0, movingMask);

      vec3 cleanedHistory = trailSource(tHistory, uv);
      vec3 smearedHistory = mix(cleanedHistory, trail, blurStrength) * localPersistence * trailOpacity;
      vec3 alphaAccum = current * 0.92 + smearedHistory;
      vec3 additiveHighlights = alphaAccum + trail * highlightBoost * 0.18;
      vec3 lightenHighlights = max(alphaAccum, smearedHistory * (0.92 + highlightBoost * 0.22));
      vec3 photographic = mix(alphaAccum, additiveHighlights, 0.23 * highlightBoost);
      photographic = mix(photographic, lightenHighlights, 0.18 * highlightBoost);

      vec3 chosen = photographic;
      if (blendMode == 1) chosen = additiveHighlights;
      if (blendMode == 2) chosen = lightenHighlights;

      // Put the present exposure back on top. This keeps metallic/detail-rich
      // current pipes sharp, while temporal information remains visible only in
      // surrounding/older trail pixels and in controlled highlight persistence.
      float currentMask = smoothstep(0.018, 0.14, luma(current));
      float trailCompositeMask = clamp(max(movingMask, trailMask) * (1.0 - currentMask * 0.92), 0.0, 1.0);
      vec3 trailedColor = mix(current, toneSafe(chosen), trailCompositeMask);
      vec3 retainedHighlights = max(trailedColor, current * (1.0 + highlightBoost * 0.08));
      vec3 finalColor = mix(trailedColor, retainedHighlights, currentMask);

      if (debugView == 1) finalColor = current;
      if (debugView == 2) finalColor = rawHistory;
      if (debugView == 3) finalColor = vec3(velocity * 8.0 + 0.5, velocitySample.z);
      if (debugView == 4) finalColor = vec3(movingMask);

      gl_FragColor = vec4(max(finalColor, 0.0), 1.0);
    }
  `;

  const PRESENT_FRAGMENT_SHADER = `
    varying vec2 vUv;
    uniform sampler2D tMap;
    void main() {
      gl_FragColor = texture2D(tMap, vUv);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  class MotionTrailPass {
    constructor(renderer, scene, camera, options = {}) {
      this.renderer = renderer;
      this.scene = scene;
      this.camera = camera;
      this.options = { ...options };
      this.frame = 0;
      this.readHistory = null;
      this.writeHistory = null;
      this.previousWorldMatrices = new Map();
      this.velocityMaterials = new Map();
      this.previousViewProjection = new THREE.Matrix4();
      this.currentViewProjection = new THREE.Matrix4();
      this.tmpMatrix = new THREE.Matrix4();
      this.fsScene = new THREE.Scene();
      this.fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      this.fsScene.add(this.fsQuad);

      this.accumulationMaterial = new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX_SHADER,
        fragmentShader: ACCUMULATION_FRAGMENT_SHADER,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          tCurrent: { value: null },
          tHistory: { value: null },
          tVelocity: { value: null },
          resolution: { value: new THREE.Vector2(1, 1) },
          deltaTime: { value: 1 / 60 },
          persistence: { value: 0.88 },
          trailLength: { value: 1.0 },
          trailOpacity: { value: 0.82 },
          sampleCount: { value: 12 },
          blurStrength: { value: 0.6 },
          velocityScale: { value: 1.0 },
          brightnessPersistence: { value: 1.3 },
          historyDecay: { value: 0.85 },
          motionThreshold: { value: 0.045 },
          highlightThreshold: { value: 0.38 },
          organicJitter: { value: 0.35 },
          syntheticTrail: { value: 1.0 },
          syntheticVelocity: { value: new THREE.Vector2(-0.018, 0.010) },
          blendMode: { value: 0 },
          debugView: { value: 0 },
          frameIndex: { value: 0 },
        },
      });
      this.presentMaterial = new THREE.ShaderMaterial({
        vertexShader: FULLSCREEN_VERTEX_SHADER,
        fragmentShader: PRESENT_FRAGMENT_SHADER,
        depthTest: false,
        depthWrite: false,
        uniforms: { tMap: { value: null } },
      });

      this.setSize(1, 1);
      this.setOptions(options);
      this.reset();
    }

    makeTarget(width, height, depthBuffer = false) {
      const target = new THREE.WebGLRenderTarget(width, height, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer,
        stencilBuffer: false,
      });
      target.texture.generateMipmaps = false;
      return target;
    }

    setQuality(quality) {
      const samples = quality === "low" ? 4 : quality === "high" ? 64 : 8;
      this.accumulationMaterial.uniforms.sampleCount.value = samples;
    }

    setOptions(options = {}) {
      this.options = { ...this.options, ...options };
      const u = this.accumulationMaterial.uniforms;
      for (
        const key of [
          "persistence",
          "trailLength",
          "trailOpacity",
          "blurStrength",
          "velocityScale",
          "brightnessPersistence",
          "historyDecay",
          "motionThreshold",
          "highlightThreshold",
          "organicJitter",
          "syntheticTrail",
        ]
      ) {
        if (options[key] !== undefined) u[key].value = options[key];
      }
      if (
        options.syntheticVelocityX !== undefined ||
        options.syntheticVelocityY !== undefined
      ) {
        u.syntheticVelocity.value.set(
          options.syntheticVelocityX ?? u.syntheticVelocity.value.x,
          options.syntheticVelocityY ?? u.syntheticVelocity.value.y,
        );
      }
      if (options.sampleCount !== undefined) {
        u.sampleCount.value = THREE.MathUtils.clamp(
          Math.round(options.sampleCount),
          1,
          64,
        );
      }
      if (
        options.trailBlendMode !== undefined || options.blendMode !== undefined
      ) {
        u.blendMode.value = Math.round(
          options.trailBlendMode ?? options.blendMode,
        );
      }
      if (options.trailDebug !== undefined || options.debugView !== undefined) {
        u.debugView.value = Math.round(options.trailDebug ?? options.debugView);
      }
      if (options.quality) this.setQuality(options.quality);
    }

    setSize(width, height, historyScale = this.options.historyScale ?? 1.0) {
      this.width = Math.max(1, Math.floor(width));
      this.height = Math.max(1, Math.floor(height));
      const scaledWidth = Math.max(1, Math.floor(this.width * historyScale));
      const scaledHeight = Math.max(1, Math.floor(this.height * historyScale));
      for (
        const target of [
          this.currentRenderTarget,
          this.velocityRenderTarget,
          this.historyRenderTargetA,
          this.historyRenderTargetB,
        ]
      ) {
        if (target) target.dispose();
      }
      this.currentRenderTarget = this.makeTarget(this.width, this.height, true);
      this.velocityRenderTarget = this.makeTarget(
        this.width,
        this.height,
        true,
      );
      this.historyRenderTargetA = this.makeTarget(
        scaledWidth,
        scaledHeight,
        false,
      );
      this.historyRenderTargetB = this.makeTarget(
        scaledWidth,
        scaledHeight,
        false,
      );
      this.readHistory = this.historyRenderTargetA;
      this.writeHistory = this.historyRenderTargetB;
      this.accumulationMaterial.uniforms.resolution.value.set(
        scaledWidth,
        scaledHeight,
      );
      this.reset();
    }

    reset() {
      this.frame = 0;
      for (const material of this.velocityMaterials.values()) {
        material.dispose();
      }
      this.velocityMaterials.clear();
      this.previousWorldMatrices.clear();
      const previousTarget = this.renderer.getRenderTarget();
      const previousColor = this.renderer.getClearColor(new THREE.Color())
        .clone();
      const previousAlpha = this.renderer.getClearAlpha();
      this.renderer.setClearColor(0x000000, 1);
      for (
        const target of [
          this.historyRenderTargetA,
          this.historyRenderTargetB,
          this.currentRenderTarget,
        ]
      ) {
        if (!target) continue;
        this.renderer.setRenderTarget(target);
        this.renderer.clear(true, true, true);
      }
      // Neutral motion-vector clear: encoded zero velocity is (0.5, 0.5, 0.0).
      if (this.velocityRenderTarget) {
        this.renderer.setClearColor(new THREE.Color(0.5, 0.5, 0.0), 1);
        this.renderer.setRenderTarget(this.velocityRenderTarget);
        this.renderer.clear(true, true, true);
      }
      this.renderer.setClearColor(previousColor, previousAlpha);
      this.renderer.setRenderTarget(previousTarget);
      this.capturePreviousTransforms();
    }

    capturePreviousTransforms() {
      this.camera.updateMatrixWorld(true);
      this.scene.updateMatrixWorld(true);
      this.previousViewProjection.multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      );
      this.scene.traverse((object) => {
        if (!object.isMesh) return;
        const matrix = this.previousWorldMatrices.get(object.uuid) ||
          new THREE.Matrix4();
        matrix.copy(object.matrixWorld);
        this.previousWorldMatrices.set(object.uuid, matrix);
      });
    }

    getVelocityMaterial(mesh) {
      let material = this.velocityMaterials.get(mesh.uuid);
      if (!material) {
        material = new THREE.ShaderMaterial({
          vertexShader: VELOCITY_VERTEX_SHADER,
          fragmentShader: VELOCITY_FRAGMENT_SHADER,
          depthTest: true,
          depthWrite: true,
          blending: THREE.NoBlending,
          side: mesh.material?.side ?? THREE.FrontSide,
          uniforms: {
            previousModelViewProjectionMatrix: { value: new THREE.Matrix4() },
          },
        });
        this.velocityMaterials.set(mesh.uuid, material);
      }
      material.side = mesh.material?.side ?? THREE.FrontSide;
      const previousWorld = this.previousWorldMatrices.get(mesh.uuid) ||
        mesh.matrixWorld;
      material.uniforms.previousModelViewProjectionMatrix.value
        .multiplyMatrices(this.previousViewProjection, previousWorld);
      return material;
    }

    renderVelocity() {
      const saved = [];
      this.scene.updateMatrixWorld(true);
      this.scene.traverse((object) => {
        if (!object.isMesh || !object.visible) return;
        saved.push([object, object.material]);
        object.material = this.getVelocityMaterial(object);
      });
      const previousColor = this.renderer.getClearColor(new THREE.Color())
        .clone();
      const previousAlpha = this.renderer.getClearAlpha();
      this.renderer.setClearColor(new THREE.Color(0.5, 0.5, 0.0), 1);
      this.renderer.setRenderTarget(this.velocityRenderTarget);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setClearColor(previousColor, previousAlpha);
      for (const [object, material] of saved) object.material = material;
    }

    render(deltaTime = 1 / 60) {
      this.setOptions(this.options);
      this.currentViewProjection.multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      );
      this.renderer.setRenderTarget(this.currentRenderTarget);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.scene, this.camera);
      this.renderVelocity();

      const u = this.accumulationMaterial.uniforms;
      u.tCurrent.value = this.currentRenderTarget.texture;
      u.tHistory.value = this.readHistory.texture;
      u.tVelocity.value = this.velocityRenderTarget.texture;
      u.deltaTime.value = Math.min(Math.max(deltaTime, 1 / 240), 1 / 12);
      u.frameIndex.value = this.frame++;
      this.fsQuad.material = this.accumulationMaterial;
      this.renderer.setRenderTarget(this.writeHistory);
      this.renderer.clear(true, false, false);
      this.renderer.render(this.fsScene, this.fsCamera);

      const swap = this.readHistory;
      this.readHistory = this.writeHistory;
      this.writeHistory = swap;
      this.capturePreviousTransforms();
    }

    present() {
      this.presentMaterial.uniforms.tMap.value = this.readHistory.texture;
      this.fsQuad.material = this.presentMaterial;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.fsScene, this.fsCamera);
    }

    dispose() {
      for (
        const target of [
          this.currentRenderTarget,
          this.velocityRenderTarget,
          this.historyRenderTargetA,
          this.historyRenderTargetB,
        ]
      ) target?.dispose();
      for (const material of this.velocityMaterials.values()) {
        material.dispose();
      }
      this.accumulationMaterial.dispose();
      this.presentMaterial.dispose();
      this.fsQuad.geometry.dispose();
    }
  }

  const trails = new MotionTrailPass(renderer, scene, camera, params);
  window.params = params;
  window.trails = trails;

  const ambient = new THREE.AmbientLight(0xffffff, params.ambientLight);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x223366, params.hdriLight);
  scene.add(hemi);
  const front = new THREE.RectAreaLight(0xffffff, params.frontLight, 10, 10);
  front.position.set(0, 0, 8);
  front.lookAt(0, 0, 0);
  scene.add(front);
  const keyPink = new THREE.DirectionalLight(0xffd9ec, params.pinkLight);
  keyPink.position.set(4, 5, 8);
  scene.add(keyPink);
  const fillBlue = new THREE.DirectionalLight(0x88aaff, params.blueLight);
  fillBlue.position.set(-5, -3, 6);
  scene.add(fillBlue);
  const rim = new THREE.PointLight(0xffffff, params.rimLight, 40);
  rim.position.set(0, 0, 8);
  scene.add(rim);

  const loader = new SVGLoader();
  const pipeMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: params.metalness,
    roughness: params.roughness,
    clearcoat: params.clearcoat,
    clearcoatRoughness: 0.0,
    transmission: params.transmission,
    thickness: params.thickness,
    ior: params.ior,
    specularIntensity: params.specularIntensity,
    opacity: params.pipeOpacity,
    transparent: true,
    depthWrite: false,
    reflectivity: 1.0,
    envMapIntensity: params.envIntensity,
    sheen: 1.0,
    sheenRoughness: 0.08,
    sheenColor: new THREE.Color(0xffffff),
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: params.pipeGlow,
    side: THREE.DoubleSide,
  });
  pipeMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.reflectionOnly = { value: params.reflectionOnly };
    shader.uniforms.reflectionFloor = { value: params.reflectionFloor };
    shader.uniforms.reflectionGain = { value: params.reflectionGain };
    pipeMaterial.userData.shader = shader;
    shader.fragmentShader = `
      uniform float reflectionOnly;
      uniform float reflectionFloor;
      uniform float reflectionGain;
    ` + shader.fragmentShader
      .replace(
        "#include <opaque_fragment>",
        `
        vec3 baseColor = diffuseColor.rgb;
        vec3 reflectionOnlyColor = max(outgoingLight - baseColor, vec3(0.0)) * reflectionGain;
        float reflectionLuma = dot(reflectionOnlyColor, vec3(0.2126, 0.7152, 0.0722));
        float reflectionAlpha = smoothstep(reflectionFloor, reflectionFloor * 4.0 + 0.0001, reflectionLuma) * diffuseColor.a;
        outgoingLight = mix(outgoingLight, reflectionOnlyColor, reflectionOnly);
        gl_FragColor = vec4(outgoingLight, mix(diffuseColor.a, reflectionAlpha, reflectionOnly));
      `,
      );
  };
  pipeMaterial.customProgramCacheKey = () => "reflection-only-pipe-v1";

  const SCENE_WIDTH = 7.2; // same proportional scale for every diagram
  const PIPE_Z = 0.0;

  let currentGroup = null;
  let lastSvg = null;
  let spinAngle = 0;
  let renderQueued = false;
  let lastRenderTime = performance.now();
  let velocityMouseBinding = false;
  let lastMouseX = window.innerWidth / 2;
  let lastMouseY = window.innerHeight / 2;
  const controlHandles = new Map();

  function setControlValue(key, value) {
    const handle = controlHandles.get(key);
    if (!handle) return;
    handle.input.value = String(value);
    handle.output.textContent = Number(value).toFixed(3);
  }

  function applyMouseVelocity(clientX = lastMouseX, clientY = lastMouseY) {
    const maxVelocity = 0.08;
    const x = THREE.MathUtils.clamp(
      ((clientX / Math.max(window.innerWidth, 1)) - 0.5) * 2.0 * maxVelocity,
      -maxVelocity,
      maxVelocity,
    );
    const y = THREE.MathUtils.clamp(
      (0.5 - (clientY / Math.max(window.innerHeight, 1))) * 2.0 * maxVelocity,
      -maxVelocity,
      maxVelocity,
    );
    params.syntheticVelocityX = Number(x.toFixed(3));
    params.syntheticVelocityY = Number(y.toFixed(3));
    setControlValue("syntheticVelocityX", params.syntheticVelocityX);
    setControlValue("syntheticVelocityY", params.syntheticVelocityY);
    applyParams();
  }

  function renderFrame(now = performance.now()) {
    renderQueued = false;
    const deltaTime = Math.min(
      Math.max((now - lastRenderTime) / 1000, 1 / 240),
      1 / 12,
    );
    lastRenderTime = now;

    if (currentGroup) {
      // Keep the pipe steady. The slow-shutter language is generated in the
      // accumulation shader, not by visibly spinning or drifting the mesh.
      spinAngle += deltaTime * params.trailMotion;
      currentGroup.rotation.x = params.tiltX;
      currentGroup.rotation.y = params.tiltY + spinAngle;
      currentGroup.position.set(0, 0, 0);
    }

    controls.update();
    trails.setOptions(params);

    if (params.trailEnabled > 0) {
      trails.render(deltaTime);
      trails.present();
    } else {
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }

    if (
      params.trailEnabled > 0 || params.trailMotion !== 0 ||
      params.syntheticTrail > 0
    ) requestRender();
  }

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(renderFrame);
  }

  function applyParams({ rebuild = false } = {}) {
    pipeMaterial.metalness = params.metalness;
    pipeMaterial.roughness = params.roughness;
    pipeMaterial.clearcoat = params.clearcoat;
    pipeMaterial.transmission = params.transmission;
    pipeMaterial.thickness = params.thickness;
    pipeMaterial.ior = params.ior;
    pipeMaterial.specularIntensity = params.specularIntensity;
    pipeMaterial.opacity = params.pipeOpacity;
    if (pipeMaterial.userData.shader) {
      pipeMaterial.userData.shader.uniforms.reflectionOnly.value =
        params.reflectionOnly;
      pipeMaterial.userData.shader.uniforms.reflectionFloor.value =
        params.reflectionFloor;
      pipeMaterial.userData.shader.uniforms.reflectionGain.value =
        params.reflectionGain;
    }
    pipeMaterial.transparent = true;
    pipeMaterial.depthWrite = false;
    pipeMaterial.envMapIntensity = params.envIntensity;
    pipeMaterial.emissiveIntensity = params.pipeGlow;
    pipeMaterial.needsUpdate = true;
    renderer.toneMappingExposure = params.exposure;
    if ("environmentIntensity" in scene) {
      scene.environmentIntensity = params.hdriLight;
    }
    ambient.intensity = params.ambientLight;
    hemi.intensity = params.hdriLight;
    front.intensity = params.frontLight;
    keyPink.intensity = params.pinkLight;
    fillBlue.intensity = params.blueLight;
    rim.intensity = params.rimLight;
    trails.setOptions(params);
    if (currentGroup && params.trailMotion === 0) {
      currentGroup.rotation.x = params.tiltX;
      currentGroup.rotation.y = params.tiltY + spinAngle;
    }
    if (rebuild && lastSvg) updateScene(lastSvg);
    requestRender();
  }

  function makeControlPanel() {
    const panel = document.createElement("details");
    panel.className = "abstract-control-panel";
    panel.open = true;
    panel.dataset.forceHidden = window.__syntheticVelocityControlsVisible
      ? "false"
      : "true";
    panel.style.display = window.__syntheticVelocityControlsVisible
      ? "block"
      : "none";
    panel.innerHTML =
      `<summary><span>3D PIPE CONTROLS</span><span>▾</span></summary><div class="abstract-control-body"></div>`;
    const body = panel.querySelector(".abstract-control-body");
    const controls = [
      ["syntheticVelocityX", "fake vel x", -0.08, 0.08, 0.001, false],
      ["syntheticVelocityY", "fake vel y", -0.08, 0.08, 0.001, false],
      ["brightnessPersistence", "bright persist", 0.5, 2.4, 0.001, false],
    ];
    for (const [key, label, min, max, step, rebuild] of controls) {
      const row = document.createElement("label");
      row.className = "abstract-control-row";
      row.innerHTML =
        `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${
          params[key]
        }"><output>${Number(params[key]).toFixed(3)}</output>`;
      const input = row.querySelector("input");
      const output = row.querySelector("output");
      controlHandles.set(key, { input, output });
      input.addEventListener("input", () => {
        params[key] = Number(input.value);
        output.textContent = Number(params[key]).toFixed(3);
        if (key === "spinSpeed") spinAngle = params.spinSpeed;
        if (key === "historyScale") {
          trails.setSize(
            window.innerWidth * renderer.getPixelRatio(),
            window.innerHeight * renderer.getPixelRatio(),
            params.historyScale,
          );
        }
        applyParams({ rebuild });
      });
      body.appendChild(row);
    }
    const mouseVelocity = document.createElement("button");
    mouseVelocity.type = "button";
    mouseVelocity.textContent = "mouse velocity: off — press space";
    mouseVelocity.tabIndex = -1;
    body.appendChild(mouseVelocity);
    document.body.appendChild(panel);
  }

  makeControlPanel();
  // Push the default control values into renderer/material/pass immediately.
  // Without this, some defaults (notably exposure and shader uniforms) only
  // became real after touching any slider.
  applyParams();

  function clearObject(object) {
    object.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (
        child.material && child.material.dispose &&
        child.material !== pipeMaterial
      ) child.material.dispose();
    });
  }

  function parseViewBox(svg) {
    const viewBox = (svg.getAttribute("viewBox") || "").trim().split(/[ ,]+/)
      .map(Number);
    if (
      viewBox.length === 4 && viewBox.every(Number.isFinite) &&
      viewBox[2] > 0 && viewBox[3] > 0
    ) {
      return {
        x: viewBox[0],
        y: viewBox[1],
        width: viewBox[2],
        height: viewBox[3],
      };
    }
    const box = svg.getBoundingClientRect();
    return { x: 0, y: 0, width: box.width || 1, height: box.height || 1 };
  }

  function isHiddenOrIcon(element) {
    if (
      element.closest(
        "defs, marker, pattern, symbol, foreignObject, .local-abstract-legend",
      )
    ) return true;
    if (
      element.closest(
        'svg[aria-hidden="true"], svg[viewBox="0 0 24 24"], svg[viewBox="0 0 100 100"], svg[width="20"], svg[width="24"]',
      )
    ) return true;
    if (element.matches("text, tspan, use, image, foreignObject, symbol")) {
      return true;
    }
    const view = element.ownerDocument.defaultView;
    if (view) {
      const style = view.getComputedStyle(element);
      if (
        style.display === "none" || style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) return true;
    }
    return false;
  }

  function isFullBackground(element, rootBox) {
    if (element.tagName.toLowerCase() !== "rect") return false;
    const width = element.getAttribute("width");
    const height = element.getAttribute("height");
    if (width === "100%" || height === "100%") return true;
    const x = parseFloat(element.getAttribute("x") || "0");
    const y = parseFloat(element.getAttribute("y") || "0");
    const w = parseFloat(width || "0");
    const h = parseFloat(height || "0");
    return Math.abs(x - rootBox.x) < 1 && Math.abs(y - rootBox.y) < 1 &&
      w >= rootBox.width - 2 && h >= rootBox.height - 2;
  }

  function visibleBox(svg) {
    const rootBox = parseViewBox(svg);
    const nodes = Array.from(
      svg.querySelectorAll("rect,circle,ellipse,path,polygon,line,polyline"),
    );
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      if (isHiddenOrIcon(node) || isFullBackground(node, rootBox)) continue;
      let box;
      try {
        box = node.getBBox();
      } catch {
        continue;
      }
      if (!box || box.width + box.height <= 0) continue;
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.width);
      maxY = Math.max(maxY, box.y + box.height);
    }
    if (
      !Number.isFinite(minX) || !Number.isFinite(minY) || maxX <= minX ||
      maxY <= minY
    ) return rootBox;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function centeredScaleBox(svg) {
    const rootBox = parseViewBox(svg);
    const box = visibleBox(svg);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    return {
      x: cx - rootBox.width / 2,
      y: cy - rootBox.height / 2,
      width: rootBox.width,
      height: rootBox.height,
    };
  }

  function sanitizeSvg(svg, box) {
    const clone = svg.cloneNode(true);
    const rootBox = parseViewBox(svg);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute(
      "viewBox",
      `${box.x} ${box.y} ${box.width} ${box.height}`,
    );
    clone.querySelectorAll(
      'text,tspan,foreignObject,use,image,symbol,defs,marker,pattern,.local-abstract-legend,svg[aria-hidden="true"],svg[viewBox="0 0 24 24"],svg[viewBox="0 0 100 100"],svg[width="20"],svg[width="24"]',
    ).forEach((node) => node.remove());
    clone.querySelectorAll("rect").forEach((rect) => {
      if (isFullBackground(rect, rootBox)) rect.remove();
    });
    clone.querySelectorAll("rect,circle,ellipse,path,polygon,line,polyline")
      .forEach((node) => {
        // Avoid SVGLoader trying to parse rgba()/transparent from upstream styles.
        node.removeAttribute("style");
        node.removeAttribute("color");
        node.removeAttribute("opacity");
        node.removeAttribute("fill-opacity");
        node.removeAttribute("stroke-opacity");
        node.setAttribute("fill", "none");
        node.setAttribute("stroke", "#ffffff");
        node.setAttribute("stroke-width", "1");
      });
    return new XMLSerializer().serializeToString(clone);
  }

  function transformGeometry(geometry, box) {
    const scale = SCENE_WIDTH / box.width;
    geometry.translate(-(box.x + box.width / 2), -(box.y + box.height / 2), 0);
    geometry.scale(scale, -scale, 1);
    return geometry;
  }

  function mapPoint(point, box, z = PIPE_Z) {
    const scale = SCENE_WIDTH / box.width;
    return new THREE.Vector3(
      (point.x - (box.x + box.width / 2)) * scale,
      -(point.y - (box.y + box.height / 2)) * scale,
      z,
    );
  }

  class PolylineCurve3 extends THREE.Curve {
    constructor(points, closed = false) {
      super();
      this.points = points;
      this.closed = closed;
      this.lengths = [0];
      for (let i = 1; i < points.length; i++) {
        this.lengths[i] = this.lengths[i - 1] +
          points[i].distanceTo(points[i - 1]);
      }
      this.totalLength = this.lengths[this.lengths.length - 1] || 1;
    }

    getPoint(t, target = new THREE.Vector3()) {
      const distance = THREE.MathUtils.clamp(t, 0, 1) * this.totalLength;
      let index = 1;
      while (
        index < this.lengths.length - 1 && this.lengths[index] < distance
      ) index++;
      const prevLength = this.lengths[index - 1];
      const nextLength = this.lengths[index];
      const segmentT = nextLength > prevLength
        ? (distance - prevLength) / (nextLength - prevLength)
        : 0;
      return target.copy(this.points[index - 1]).lerp(
        this.points[index],
        segmentT,
      );
    }
  }

  function dedupePoints(points, minDistance) {
    const deduped = [];
    for (const point of points) {
      if (
        !deduped.length ||
        point.distanceTo(deduped[deduped.length - 1]) > minDistance
      ) deduped.push(point);
    }
    return deduped;
  }

  function addPipe(group, points, box, radius = params.pipeRadius) {
    if (!points || points.length < 2) return;
    let mapped = dedupePoints(
      points.map((point) => mapPoint(point, box)),
      radius * 0.35,
    );
    if (mapped.length < 2) return;

    const first = mapped[0];
    const last = mapped[mapped.length - 1];
    const closed = first.distanceTo(last) < radius * 3.0;
    if (closed) mapped[mapped.length - 1] = first.clone();

    // Important: do not use CatmullRom here. It invents intermediate curvature
    // and overshoots SVG vertices. This piecewise-linear curve follows the
    // sampled SVG stroke exactly, so pipes match the original stroke path.
    const curve = new PolylineCurve3(mapped, closed);
    const approximateLength = curve.totalLength;
    const tubularSegments = Math.max(
      24,
      Math.min(1400, Math.ceil(approximateLength / radius * 4.2)),
    );
    const geometry = new THREE.TubeGeometry(
      curve,
      tubularSegments,
      radius,
      32,
      closed,
    );
    const mesh = new THREE.Mesh(geometry, pipeMaterial);
    group.add(mesh);

    if (!closed) {
      for (const point of [mapped[0], mapped[mapped.length - 1]]) {
        const cap = new THREE.Mesh(
          new THREE.SphereGeometry(radius, 32, 24),
          pipeMaterial,
        );
        cap.position.copy(point);
        group.add(cap);
      }
    }
  }

  function addSubPathPipe(group, subPath, box) {
    addPipe(group, subPath.getPoints(240), box);
  }

  function buildSceneFromSvg(svg) {
    const box = centeredScaleBox(svg);
    const svgText = sanitizeSvg(svg, box);
    const data = loader.parse(svgText);
    const group = new THREE.Group();

    // Only render visible SVG strokes/outlines as round 3D tubes.
    // No flat filled plates: a line becomes a pipe, a rectangle becomes four pipes,
    // a circle becomes a circular pipe.
    for (const path of data.paths) {
      for (const subPath of path.subPaths) addSubPathPipe(group, subPath, box);
    }

    // Explicit line fallback: guarantees <line> elements become pipes if a loader
    // version skips them.
    svg.querySelectorAll("line").forEach((line) => {
      if (isHiddenOrIcon(line) || isFullBackground(line, box)) return;
      const a = {
        x: parseFloat(line.getAttribute("x1") || "0"),
        y: parseFloat(line.getAttribute("y1") || "0"),
      };
      const b = {
        x: parseFloat(line.getAttribute("x2") || "0"),
        y: parseFloat(line.getAttribute("y2") || "0"),
      };
      addPipe(group, [a, b], box, params.pipeRadius * 1.05);
    });

    group.rotation.x = params.tiltX;
    group.rotation.y = params.tiltY;
    return group;
  }

  function updateScene(svgOverride = null) {
    const doc = iframe.contentDocument;
    const svg = svgOverride || (doc && doc.querySelector("svg"));
    if (!svg) return;
    lastSvg = svg;

    const nextGroup = buildSceneFromSvg(svg);
    if (currentGroup) {
      root.remove(currentGroup);
      clearObject(currentGroup);
    }
    currentGroup = nextGroup;
    root.add(currentGroup);
    trails.reset();
    console.info("[abstract 3d] loaded extruded scene", {
      children: currentGroup.children.length,
      triangles: currentGroup.children.reduce(
        (sum, child) =>
          sum + (child.geometry?.attributes?.position?.count || 0) / 3,
        0,
      ),
    });
    requestRender();
  }

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    trails.setSize(
      width * renderer.getPixelRatio(),
      height * renderer.getPixelRatio(),
      params.historyScale,
    );
    requestRender();
  }

  iframe.addEventListener("load", () => setTimeout(updateScene, 80));
  if (iframe.contentDocument?.readyState === "complete") {
    setTimeout(updateScene, 80);
  }
  window.addEventListener("mousemove", (event) => {
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    if (velocityMouseBinding) applyMouseVelocity(lastMouseX, lastMouseY);
  });
  window.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    velocityMouseBinding = true;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    applyMouseVelocity(lastMouseX, lastMouseY);
  }, true);
  window.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    applyMouseVelocity(lastMouseX, lastMouseY);
  }, true);
  window.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    velocityMouseBinding = false;
  }, true);
  window.addEventListener("pointercancel", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    velocityMouseBinding = false;
  }, true);
  function handleArtworkKeys(event) {
    if (event.code !== "Space") return;
    event.preventDefault();
    event.stopPropagation();
    velocityMouseBinding = !velocityMouseBinding;
    const button = Array.from(
      document.querySelectorAll(".abstract-control-panel button"),
    ).find((node) => node.textContent.startsWith("mouse velocity:"));
    if (button) {
      button.textContent = velocityMouseBinding
        ? "mouse velocity: on — press space"
        : "mouse velocity: off — press space";
    }
    if (velocityMouseBinding) applyMouseVelocity(lastMouseX, lastMouseY);
  }
  window.addEventListener("keydown", handleArtworkKeys, true);
  document.addEventListener("keydown", handleArtworkKeys, true);
  window.addEventListener("resize", resize);
  controls.addEventListener("change", () => {
    trails.reset();
    requestRender();
  });
  window.addEventListener("beforeunload", () => trails.dispose());

  resize();
  requestRender();
})();
