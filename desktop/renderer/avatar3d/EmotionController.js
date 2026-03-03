// Full ARKit 52 blendshape name list
const ARKIT_BLENDSHAPES = [
  "eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft",
  "eyeSquintLeft", "eyeWideLeft",
  "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight",
  "eyeSquintRight", "eyeWideRight",
  "jawForward", "jawLeft", "jawRight", "jawOpen",
  "mouthClose", "mouthFunnel", "mouthPucker", "mouthLeft", "mouthRight",
  "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
  "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft", "mouthStretchRight",
  "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
  "mouthPressLeft", "mouthPressRight", "mouthLowerDownLeft", "mouthLowerDownRight",
  "mouthUpperUpLeft", "mouthUpperUpRight",
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
  "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
  "noseSneerLeft", "noseSneerRight",
  "tongueOut",
];

const EMOTION_PRESETS_3D = {
  happy: {
    mouthSmileLeft: 0.7, mouthSmileRight: 0.7,
    cheekSquintLeft: 0.4, cheekSquintRight: 0.4,
    eyeSquintLeft: 0.3, eyeSquintRight: 0.3,
    _headPitch: -0.05, _headYaw: 0.03,
  },
  sad: {
    browInnerUp: 0.6,
    browDownLeft: 0.3, browDownRight: 0.3,
    mouthFrownLeft: 0.5, mouthFrownRight: 0.5,
    eyeSquintLeft: 0.2, eyeSquintRight: 0.2,
    _headPitch: 0.1, _headYaw: 0,
  },
  excited: {
    mouthSmileLeft: 0.9, mouthSmileRight: 0.9,
    eyeWideLeft: 0.5, eyeWideRight: 0.5,
    browInnerUp: 0.4,
    jawOpen: 0.2,
    _headPitch: -0.08,
  },
  thinking: {
    eyeLookUpLeft: 0.4, eyeLookUpRight: 0.3,
    browInnerUp: 0.3,
    mouthPucker: 0.2,
    _headPitch: -0.04, _headYaw: -0.08,
  },
  playful: {
    mouthSmileLeft: 0.8, mouthSmileRight: 0.5,
    tongueOut: 0.3,
    eyeSquintLeft: 0.4, eyeSquintRight: 0.2,
    _headYaw: 0.06, _headRoll: 0.05,
  },
  concerned: {
    browInnerUp: 0.5,
    browDownLeft: 0.2, browDownRight: 0.2,
    mouthFrownLeft: 0.3, mouthFrownRight: 0.3,
    eyeSquintLeft: 0.15, eyeSquintRight: 0.15,
    _headPitch: 0.04,
  },
  neutral: {},
};

class EmotionController {
  constructor() {
    this._meshes = [];
    this._availableShapes = new Set();
    this._currentValues = {};
    this._targetValues = {};
    this._currentEmotion = "neutral";
    this._emotionTimeout = null;
    this._emotionLerp = 0.08;
    this._lipSyncLerp = 0.25;
    this._lipSyncOverrides = {};
  }

  init(meshes) {
    this._meshes = meshes;
    this._availableShapes.clear();
    this._currentValues = {};
    this._targetValues = {};

    // Discover available blendshapes from all meshes
    for (const mesh of meshes) {
      if (!mesh.morphTargetDictionary) continue;
      for (const name of Object.keys(mesh.morphTargetDictionary)) {
        this._availableShapes.add(name);
      }
    }

    // Initialize all shapes to 0
    for (const name of this._availableShapes) {
      this._currentValues[name] = 0;
      this._targetValues[name] = 0;
    }

    this._logMissingShapes();
  }

  hasBlendshapes() {
    return this._availableShapes.size > 0;
  }

  _logMissingShapes() {
    const missing = ARKIT_BLENDSHAPES.filter((s) => !this._availableShapes.has(s));
    if (missing.length > 0 && missing.length < ARKIT_BLENDSHAPES.length) {
      console.log(`[avatar3d] Model has ${this._availableShapes.size}/${ARKIT_BLENDSHAPES.length} ARKit blendshapes.`);
    } else if (missing.length === ARKIT_BLENDSHAPES.length) {
      console.log("[avatar3d] Model has no ARKit blendshapes. Using bone-only fallback.");
    } else {
      console.log("[avatar3d] Model has all 52 ARKit blendshapes.");
    }
  }

  setEmotion(emotionName) {
    if (this._emotionTimeout) clearTimeout(this._emotionTimeout);

    const preset = EMOTION_PRESETS_3D[emotionName] || EMOTION_PRESETS_3D.neutral;
    this._currentEmotion = emotionName;

    // Build new target from zeros + preset values
    const newTargets = {};
    for (const name of this._availableShapes) {
      newTargets[name] = 0;
    }
    for (const [key, val] of Object.entries(preset)) {
      if (key.startsWith("_")) continue;
      if (this._availableShapes.has(key)) {
        newTargets[key] = val;
      }
    }
    this._targetValues = newTargets;

    // Extract posture hints for AnimationController
    const posture = {};
    for (const [key, val] of Object.entries(preset)) {
      if (key.startsWith("_")) posture[key] = val;
    }

    // Auto-clear after 6 seconds
    this._emotionTimeout = setTimeout(() => {
      this.setEmotion("neutral");
    }, 6000);

    return posture;
  }

  setLipSyncOverrides(overrides) {
    this._lipSyncOverrides = overrides || {};
  }

  update(delta, blinkValue, saccade) {
    const emotionLerp = 1 - Math.pow(1 - this._emotionLerp, delta * 60);
    const lipLerp = 1 - Math.pow(1 - this._lipSyncLerp, delta * 60);

    for (const name of this._availableShapes) {
      const target = this._targetValues[name] || 0;

      // Lip sync overrides take priority for mouth shapes
      if (this._lipSyncOverrides[name] !== undefined) {
        this._currentValues[name] += (this._lipSyncOverrides[name] - this._currentValues[name]) * lipLerp;
      } else {
        this._currentValues[name] += (target - this._currentValues[name]) * emotionLerp;
      }

      // Blink: max of emotion and blink animation
      if (name === "eyeBlinkLeft" || name === "eyeBlinkRight") {
        this._currentValues[name] = Math.max(this._currentValues[name], blinkValue);
      }

      // Saccade overlay on eye look shapes
      if (saccade) {
        if (name === "eyeLookOutLeft" || name === "eyeLookInRight") {
          this._currentValues[name] = Math.max(0, this._currentValues[name] + saccade.x);
        }
        if (name === "eyeLookInLeft" || name === "eyeLookOutRight") {
          this._currentValues[name] = Math.max(0, this._currentValues[name] - saccade.x);
        }
        if (name === "eyeLookUpLeft" || name === "eyeLookUpRight") {
          this._currentValues[name] = Math.max(0, this._currentValues[name] + saccade.y);
        }
        if (name === "eyeLookDownLeft" || name === "eyeLookDownRight") {
          this._currentValues[name] = Math.max(0, this._currentValues[name] - saccade.y);
        }
      }

      // Clamp and apply
      const val = Math.max(0, Math.min(1, this._currentValues[name]));
      this._applyBlendshape(name, val);
    }
  }

  _applyBlendshape(name, value) {
    for (const mesh of this._meshes) {
      if (!mesh.morphTargetDictionary || mesh.morphTargetDictionary[name] === undefined) continue;
      const idx = mesh.morphTargetDictionary[name];
      mesh.morphTargetInfluences[idx] = value;
    }
  }

  dispose() {
    if (this._emotionTimeout) clearTimeout(this._emotionTimeout);
    this._meshes = [];
    this._currentValues = {};
    this._targetValues = {};
    this._lipSyncOverrides = {};
  }
}

module.exports = { EmotionController, EMOTION_PRESETS_3D, ARKIT_BLENDSHAPES };
