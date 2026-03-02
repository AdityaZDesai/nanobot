// Amplitude-based: which blendshapes open the mouth and by how much
const AMPLITUDE_SHAPES = {
  jawOpen: 1.0,
  mouthLowerDownLeft: 0.3,
  mouthLowerDownRight: 0.3,
};

// Viseme mappings (future: driven by phoneme data from TTS)
const VISEME_MAP = {
  aa: { jawOpen: 0.7 },
  ee: { jawOpen: 0.2, mouthSmileLeft: 0.4, mouthSmileRight: 0.4 },
  oh: { jawOpen: 0.5, mouthFunnel: 0.6 },
  oo: { jawOpen: 0.3, mouthPucker: 0.7 },
  ff: { jawOpen: 0.1, mouthRollLower: 0.4, mouthUpperUpLeft: 0.2, mouthUpperUpRight: 0.2 },
  ss: { jawOpen: 0.15, mouthStretchLeft: 0.3, mouthStretchRight: 0.3 },
  mm: { jawOpen: 0, mouthClose: 0.8, mouthPressLeft: 0.4, mouthPressRight: 0.4 },
  rest: {},
};

class LipSyncController {
  constructor() {
    this._getLipSyncValue = null;
    this._jawBone = null;
    this._jawBaseRotation = null;
    this._lipLowerCenter = null;
    this._lipLowerCenterRest = null;
    this._lipBones = [];
    this._lipBoneRests = new Map();
    this._useBlendshapes = true;
    this._useBoneLipSync = false;
    this._mode = "amplitude"; // "amplitude" or "viseme"
    this._currentViseme = "rest";
    this._smoothedAmplitude = 0;
    this._smoothingFactor = 0.3;
  }

  init({ getLipSyncValueFn, jawBone, hasBlendshapes, lipLowerCenter, lipBones, getRestPose }) {
    this._getLipSyncValue = getLipSyncValueFn;
    this._jawBone = jawBone;
    this._useBlendshapes = hasBlendshapes;
    this._lipLowerCenter = lipLowerCenter || null;
    this._lipBones = lipBones || [];
    this._useBoneLipSync = !hasBlendshapes && (jawBone || lipLowerCenter || this._lipBones.length > 0);

    console.log("[LipSync] init: useBone:", this._useBoneLipSync,
      "useBlend:", this._useBlendshapes,
      "jaw:", jawBone ? jawBone.name : "NONE",
      "lipLower:", lipLowerCenter ? lipLowerCenter.name : "NONE",
      "lipBones:", (lipBones || []).length,
      "hasGetFn:", !!getLipSyncValueFn);

    if (jawBone) {
      this._jawBaseRotation = jawBone.rotation.x;
    }
    if (lipLowerCenter && getRestPose) {
      this._lipLowerCenterRest = getRestPose(lipLowerCenter);
    }
    // Capture rest poses for all lip bones
    if (getRestPose) {
      for (const bone of this._lipBones) {
        const rest = getRestPose(bone);
        if (rest) this._lipBoneRests.set(bone, rest);
      }
    }
  }

  // Returns blendshape overrides for EmotionController to merge
  update(delta) {
    if (!this._getLipSyncValue) return {};

    const rawAmplitude = this._getLipSyncValue();

    // Debug: log first few non-zero amplitudes to confirm pipeline works
    if (!this._pipelineLogCount) this._pipelineLogCount = 0;
    if (this._pipelineLogCount < 5 && rawAmplitude > 0.01) {
      console.log("[LipSync] pipeline active! raw:", rawAmplitude.toFixed(3),
        "useBone:", this._useBoneLipSync, "useBlend:", this._useBlendshapes);
      this._pipelineLogCount++;
    }

    // Smooth amplitude to prevent flicker
    const smoothFactor = 1 - Math.pow(1 - this._smoothingFactor, delta * 60);
    this._smoothedAmplitude += (rawAmplitude - this._smoothedAmplitude) * smoothFactor;
    const amplitude = this._smoothedAmplitude;

    // Bone-based lip sync (models without blendshapes)
    if (this._useBoneLipSync) {
      this._applyBoneLipSync(amplitude);
      return {};
    }

    // Blendshape-based lip sync
    if (this._mode === "amplitude") {
      return this._amplitudeToShapes(amplitude);
    }

    return this._visemeToShapes(this._currentViseme, amplitude);
  }

  _applyBoneLipSync(amplitude) {
    // Debug: log first few frames with non-zero amplitude
    if (!this._debugCount) this._debugCount = 0;
    if (this._debugCount < 8 && amplitude > 0.01) {
      console.log("[LipSync] bone amplitude:", amplitude.toFixed(3),
        "jaw:", this._jawBone ? this._jawBone.name : "NONE",
        "lipBones:", this._lipBones.length,
        "lipLower:", this._lipLowerCenter ? this._lipLowerCenter.name : "NONE");
      this._debugCount++;
    }

    // Jaw bone: rotate open
    if (this._jawBone && this._jawBaseRotation != null) {
      const maxJawRotation = 0.4; // radians — much larger for visibility
      const targetRotation = this._jawBaseRotation + amplitude * maxJawRotation;
      this._jawBone.rotation.x += (targetRotation - this._jawBone.rotation.x) * 0.4;
    }

    // Lower lip center: pull down strongly with mouth open
    if (this._lipLowerCenter && this._lipLowerCenterRest) {
      const rest = this._lipLowerCenterRest;
      const offset = amplitude * 0.2;
      this._lipLowerCenter.rotation.x += (rest.x + offset - this._lipLowerCenter.rotation.x) * 0.4;
    }

    // Animate ALL lip bones for visible mouth movement
    for (const bone of this._lipBones) {
      const rest = this._lipBoneRests.get(bone);
      if (!rest) continue;
      const name = bone.name;
      const lowerName = name.toLowerCase();
      const isLower =
        lowerName.includes("lipl") ||
        lowerName.includes("lipbl") ||
        lowerName.includes("lowerlip");
      const isUpper =
        lowerName.includes("lipu") ||
        lowerName.includes("lipt") ||
        lowerName.includes("liptl") ||
        lowerName.includes("liptr") ||
        lowerName.includes("upperlip");
      const isCorner = lowerName.includes("corner");

      if (isLower && !isCorner) {
        // Lower lip bones: pull down (open mouth)
        const offset = amplitude * 0.15;
        bone.rotation.x += (rest.x + offset - bone.rotation.x) * 0.4;
      } else if (isUpper && !isCorner) {
        // Upper lip bones: slight upward lift
        const offset = amplitude * -0.05;
        bone.rotation.x += (rest.x + offset - bone.rotation.x) * 0.35;
      } else if (isCorner) {
        // Lip corners: outward stretch
        const offset = amplitude * 0.08;
        bone.rotation.z += (rest.z + offset - bone.rotation.z) * 0.3;
      } else {
        // Generic fallback for unknown lip rigs
        const offset = amplitude * 0.06;
        bone.rotation.x += (rest.x + offset - bone.rotation.x) * 0.28;
      }
    }
  }

  _amplitudeToShapes(amplitude) {
    if (amplitude < 0.005) return {};
    const overrides = {};
    for (const [shape, weight] of Object.entries(AMPLITUDE_SHAPES)) {
      overrides[shape] = amplitude * weight;
    }
    return overrides;
  }

  _visemeToShapes(viseme, amplitude) {
    const shapes = VISEME_MAP[viseme] || VISEME_MAP.rest;
    const overrides = {};
    for (const [shape, weight] of Object.entries(shapes)) {
      overrides[shape] = weight * amplitude;
    }
    return overrides;
  }

  setViseme(visemeName) {
    this._currentViseme = visemeName;
  }

  setMode(mode) {
    if (mode === "amplitude" || mode === "viseme") {
      this._mode = mode;
    }
  }

  dispose() {
    this._getLipSyncValue = null;
    this._jawBone = null;
    this._lipLowerCenter = null;
    this._lipBones = [];
    this._lipBoneRests.clear();
    this._smoothedAmplitude = 0;
  }
}

module.exports = { LipSyncController, VISEME_MAP };
