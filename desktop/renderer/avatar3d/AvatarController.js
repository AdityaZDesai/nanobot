const { AvatarRenderer, ensureThree } = require("./AvatarRenderer");
const { AnimationController } = require("./AnimationController");
const { EmotionController } = require("./EmotionController");
const { LipSyncController } = require("./LipSyncController");

class AvatarController {
  constructor(canvasElement, getLipSyncValueFn) {
    this._renderer = new AvatarRenderer(canvasElement);
    this._animation = new AnimationController();
    this._emotion = new EmotionController();
    this._lipSync = new LipSyncController();
    this._getLipSyncValueFn = getLipSyncValueFn;
    this._loaded = false;

    // Register the unified update loop
    this._renderer.onUpdate((delta) => this._update(delta));
  }

  async loadModel(filePath) {
    // Reset controllers
    this._animation.dispose();
    this._emotion.dispose();
    this._lipSync.dispose();
    this._loaded = false;

    // Load model into scene (also initializes Three.js via ensureThree)
    const { gltf, meshes, skeleton } = await this._renderer.loadModel(filePath);

    // Get the shared ESM THREE instance (already loaded by loadModel → init)
    const THREE = await ensureThree();

    // Initialize controllers with loaded model data
    this._animation.init(gltf, skeleton, THREE);
    this._emotion.init(meshes);
    this._lipSync.init({
      getLipSyncValueFn: this._getLipSyncValueFn,
      jawBone: this._animation.getJawBone(),
      hasBlendshapes: this._emotion.hasBlendshapes(),
      lipLowerCenter: this._animation.getLipLowerCenter(),
      lipBones: this._animation.getLipBones(),
      getRestPose: (bone) => this._animation.getRestPose(bone),
    });

    this._loaded = true;
  }

  setEmotion(emotionName) {
    const posture = this._emotion.setEmotion(emotionName);
    this._animation.setPostureTarget(posture);
  }

  playAnimation(clipName) {
    this._animation.playAnimation(clipName);
  }

  enableIdle(enabled) {
    this._animation.enableIdle(enabled);
  }

  start() {
    this._renderer.start();
  }

  stop() {
    this._renderer.stop();
  }

  _update(delta) {
    if (!this._loaded) return;

    // 1. Update animation mixer + bone micro-movements
    this._animation.update(delta);

    // 2. Get lip sync blendshape overrides
    const lipOverrides = this._lipSync.update(delta);
    this._emotion.setLipSyncOverrides(lipOverrides);

    // 3. Get blink + saccade from animation controller
    const blinkValue = this._animation.getBlinkState();
    const saccade = this._animation.getSaccade();

    // 4. Update all blendshapes with merged values
    this._emotion.update(delta, blinkValue, saccade);
  }

  dispose() {
    this.stop();
    this._lipSync.dispose();
    this._emotion.dispose();
    this._animation.dispose();
    this._renderer.dispose();
    this._loaded = false;
  }
}

module.exports = { AvatarController };
