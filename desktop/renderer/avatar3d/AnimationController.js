class AnimationController {
  constructor() {
    this._THREE = null;
    this.mixer = null;
    this.clips = {};
    this.actions = {};
    this.currentIdleAction = null;
    this.idleEnabled = true;
    this._skeleton = null;
    this._startTime = performance.now() / 1000;
    this._postureTarget = {};

    // Body bones
    this._headBone = null;
    this._neckBone = null;
    this._spineBone = null;
    this._spine1Bone = null;
    this._spine2Bone = null;
    this._jawBone = null;
    this._shoulderL = null;
    this._shoulderR = null;
    this._clavicleL = null;
    this._clavicleR = null;
    this._upperArmL = null;
    this._upperArmR = null;
    this._forearmL = null;
    this._forearmR = null;

    // Facial bones (bone-based rigs without morph targets)
    this._eyeBoneL = null;
    this._eyeBoneR = null;
    this._upperLidBonesL = [];
    this._upperLidBonesR = [];
    this._lowerLidBonesL = [];
    this._lowerLidBonesR = [];
    this._lipBones = [];       // all lip-related bones
    this._lipLowerCenter = null;
    this._browBonesL = [];
    this._browBonesR = [];
    this._browCenter = null;
    this._hasFacialBones = false;

    // Store rest poses for facial bones (captured on init)
    this._restPoses = new Map();

    // Blink state
    this._nextBlinkTime = 0;
    this._blinkPhase = 0; // 0=open, 1=closing, 2=opening
    this._blinkProgress = 0;

    // Saccade state
    this._saccadeTarget = { x: 0, y: 0 };
    this._saccadeCurrent = { x: 0, y: 0 };
    this._nextSaccadeTime = 0;

    // Body sway state
    this._swayPhase = Math.random() * Math.PI * 2;
  }

  init(gltf, skeleton, THREE) {
    this._THREE = THREE;
    const root = gltf.scene;
    this.mixer = new THREE.AnimationMixer(root);
    this._skeleton = skeleton;

    console.log("[AnimCtrl] init: skeleton?", !!skeleton, "bones:", skeleton ? skeleton.bones.length : 0);
    console.log("[AnimCtrl] init: animation clips:", gltf.animations.length);

    this._findBones(skeleton);
    this._captureRestPoses();

    console.log("[AnimCtrl] bones found:",
      "head:", this._headBone ? this._headBone.name : "NONE",
      "neck:", this._neckBone ? this._neckBone.name : "NONE",
      "spine:", this._spineBone ? this._spineBone.name : "NONE",
      "jaw:", this._jawBone ? this._jawBone.name : "NONE",
      "eyeL:", this._eyeBoneL ? this._eyeBoneL.name : "NONE",
      "eyeR:", this._eyeBoneR ? this._eyeBoneR.name : "NONE",
      "upperLidsL:", this._upperLidBonesL.length,
      "facialBones:", this._hasFacialBones,
      "upperArmL:", this._upperArmL ? this._upperArmL.name : "NONE",
      "upperArmR:", this._upperArmR ? this._upperArmR.name : "NONE",
      "forearmL:", this._forearmL ? this._forearmL.name : "NONE",
      "forearmR:", this._forearmR ? this._forearmR.name : "NONE",
      "clavicleL:", this._clavicleL ? this._clavicleL.name : "NONE",
      "clavicleR:", this._clavicleR ? this._clavicleR.name : "NONE"
    );

    // Index all animation clips from the GLB
    for (const clip of gltf.animations) {
      this.clips[clip.name] = clip;
      const action = this.mixer.clipAction(clip);
      action.enabled = false;
      this.actions[clip.name] = action;
    }

    // Try to find and play a default idle
    const idleName = this._findIdleClip();
    if (idleName) {
      this.playIdle(idleName);
    }
  }

  _findBones(skeleton) {
    if (!skeleton) return;

    for (const bone of skeleton.bones) {
      const name = bone.name;
      const lower = name.toLowerCase();

      // --- Body bones ---
      if (!this._headBone && lower.includes("head") && !lower.includes("headtop") && !lower.includes("headend")) {
        this._headBone = bone;
      }
      if (!this._neckBone && lower.includes("neck") && !lower.includes("necklace")) {
        this._neckBone = bone;
      }
      // Prefer facial rig jaw (b_*) over helmet/armor jaw bones
      if (lower.includes("jaw") || lower === "helmet_mouth") {
        if (name.startsWith("b_")) {
          this._jawBone = bone; // Facial rig jaw always wins
        } else if (!this._jawBone && !lower.startsWith("helmet")) {
          this._jawBone = bone; // Non-helmet fallback
        }
      }

      // Spine hierarchy: prefer most specific
      if (lower === "bip001-spine" || lower === "spine" || lower.endsWith("_spine") || lower === "mixamorigspine") {
        this._spineBone = bone;
      }
      if (lower === "bip001-spine1" || lower === "spine1" || lower === "mixamorigspine1") {
        this._spine1Bone = bone;
      }
      if (lower === "bip001-spine2" || lower === "spine2" || lower === "mixamorigspine2") {
        this._spine2Bone = bone;
      }
      if (!this._shoulderL && (lower === "shoulderl" || lower.includes("shoulder_l") || lower.includes("leftshoulder"))) {
        this._shoulderL = bone;
      }
      if (!this._shoulderR && (lower === "shoulderr" || lower.includes("shoulder_r") || lower.includes("rightshoulder"))) {
        this._shoulderR = bone;
      }
      if (!this._clavicleL && (lower === "bip001-l-clavicle" || lower.includes("clavicle_l") || lower.includes("leftclavicle") || lower.includes("l-clavicle") || lower.includes("l_clavicle"))) {
        this._clavicleL = bone;
      }
      if (!this._clavicleR && (lower === "bip001-r-clavicle" || lower.includes("clavicle_r") || lower.includes("rightclavicle") || lower.includes("r-clavicle") || lower.includes("r_clavicle"))) {
        this._clavicleR = bone;
      }
      if (!this._upperArmL && (lower === "upper_arml" || lower.includes("upperarm_l") || lower.includes("leftarm") || lower === "bip001-l-upperarm" || lower === "l_upperarm")) {
        this._upperArmL = bone;
      }
      if (!this._upperArmR && (lower === "upper_armr" || lower.includes("upperarm_r") || lower.includes("rightarm") || lower === "bip001-r-upperarm" || lower === "r_upperarm")) {
        this._upperArmR = bone;
      }
      if (!this._forearmL && (lower === "forearml" || lower.includes("forearm_l") || lower.includes("leftforearm") || lower === "bip001-l-forearm" || lower === "l_forearm")) {
        this._forearmL = bone;
      }
      if (!this._forearmR && (lower === "forearmr" || lower.includes("forearm_r") || lower.includes("rightforearm") || lower === "bip001-r-forearm" || lower === "r_forearm")) {
        this._forearmR = bone;
      }

      // --- Eye bones ---
      if (name === "b_L_Eye_0") this._eyeBoneL = bone;
      if (name === "b_R_Eye_0") this._eyeBoneR = bone;

      // --- Eyelid bones (upper) ---
      if (/^b_L_LidU[A-E]_0$/.test(name)) this._upperLidBonesL.push(bone);
      if (/^b_R_LidU[A-E]_0$/.test(name)) this._upperLidBonesR.push(bone);

      // --- Eyelid bones (lower) ---
      if (/^b_L_LidL[A-E]_0$/.test(name)) this._lowerLidBonesL.push(bone);
      if (/^b_R_LidL[A-E]_0$/.test(name)) this._lowerLidBonesR.push(bone);

      // --- Lip bones ---
      if (lower.includes("lip")) {
        this._lipBones.push(bone);
        if (!this._lipLowerCenter && (
          name === "b_C_LipL_0" ||
          lower.includes("lipl") ||
          lower.includes("lipbl") ||
          lower.includes("lowerlip")
        )) {
          this._lipLowerCenter = bone;
        }
      }

      // --- Brow bones ---
      if (/^b_L_Brow[A-D]_0$/.test(name)) this._browBonesL.push(bone);
      if (/^b_R_Brow[A-D]_0$/.test(name)) this._browBonesR.push(bone);
      if (name === "b_C_BrowIn_0") this._browCenter = bone;
    }

    // Fallback spine search
    if (!this._spineBone) {
      for (const bone of skeleton.bones) {
        if (bone.name.toLowerCase().includes("spine")) {
          this._spineBone = bone;
          break;
        }
      }
    }

    // Fallback arm search — catch any naming convention we missed
    if (!this._upperArmL || !this._upperArmR) {
      for (const bone of skeleton.bones) {
        const l = bone.name.toLowerCase();
        if (!this._upperArmL && (l.includes("upperarm") || l.includes("upper_arm") || l.includes("upper arm")) && (l.includes("l") && !l.includes("r"))) {
          this._upperArmL = bone;
        }
        if (!this._upperArmR && (l.includes("upperarm") || l.includes("upper_arm") || l.includes("upper arm")) && (l.includes("r") && !l.includes("l"))) {
          this._upperArmR = bone;
        }
      }
    }
    if (!this._forearmL || !this._forearmR) {
      for (const bone of skeleton.bones) {
        const l = bone.name.toLowerCase();
        if (!this._forearmL && (l.includes("forearm") || l.includes("lowerarm") || l.includes("lower_arm")) && (l.includes("l") && !l.includes("r"))) {
          this._forearmL = bone;
        }
        if (!this._forearmR && (l.includes("forearm") || l.includes("lowerarm") || l.includes("lower_arm")) && (l.includes("r") && !l.includes("l"))) {
          this._forearmR = bone;
        }
      }
    }

    // Debug: dump all bone names so we can diagnose matching issues
    console.log("[AnimCtrl] all skeleton bones:", skeleton.bones.map(b => b.name).join(", "));

    this._hasFacialBones = this._upperLidBonesL.length > 0 || this._eyeBoneL != null;
  }

  _captureRestPoses() {
    // Save the rest rotation for ALL animated bones, so we can offset from rest
    const bonesToCapture = [
      ...this._upperLidBonesL, ...this._upperLidBonesR,
      ...this._lowerLidBonesL, ...this._lowerLidBonesR,
      ...this._lipBones,
      ...this._browBonesL, ...this._browBonesR,
    ];
    if (this._browCenter) bonesToCapture.push(this._browCenter);
    if (this._eyeBoneL) bonesToCapture.push(this._eyeBoneL);
    if (this._eyeBoneR) bonesToCapture.push(this._eyeBoneR);
    if (this._jawBone) bonesToCapture.push(this._jawBone);
    if (this._headBone) bonesToCapture.push(this._headBone);
    if (this._neckBone) bonesToCapture.push(this._neckBone);
    if (this._spineBone) bonesToCapture.push(this._spineBone);
    if (this._spine1Bone) bonesToCapture.push(this._spine1Bone);
    if (this._spine2Bone) bonesToCapture.push(this._spine2Bone);
    if (this._shoulderL) bonesToCapture.push(this._shoulderL);
    if (this._shoulderR) bonesToCapture.push(this._shoulderR);
    if (this._clavicleL) bonesToCapture.push(this._clavicleL);
    if (this._clavicleR) bonesToCapture.push(this._clavicleR);
    if (this._upperArmL) bonesToCapture.push(this._upperArmL);
    if (this._upperArmR) bonesToCapture.push(this._upperArmR);
    if (this._forearmL) bonesToCapture.push(this._forearmL);
    if (this._forearmR) bonesToCapture.push(this._forearmR);

    for (const bone of bonesToCapture) {
      this._restPoses.set(bone, {
        x: bone.rotation.x,
        y: bone.rotation.y,
        z: bone.rotation.z,
      });
    }
  }

  _findIdleClip() {
    const names = Object.keys(this.clips);
    const preferred = ["idle", "breathing", "stand", "rest"];
    for (const pref of preferred) {
      const match = names.find((n) => n.toLowerCase().includes(pref));
      if (match) return match;
    }
    return names.length > 0 ? names[0] : null;
  }

  playIdle(clipName) {
    const action = this.actions[clipName];
    if (!action) return;

    if (this.currentIdleAction && this.currentIdleAction !== action) {
      action.reset();
      action.enabled = true;
      action.setLoop(this._THREE.LoopRepeat, Infinity);
      action.play();
      this.currentIdleAction.crossFadeTo(action, 0.5, true);
    } else {
      action.reset();
      action.enabled = true;
      action.setLoop(this._THREE.LoopRepeat, Infinity);
      action.play();
    }
    this.currentIdleAction = action;
  }

  playAnimation(clipName) {
    const action = this.actions[clipName];
    if (!action) return;

    action.reset();
    action.enabled = true;
    action.setLoop(this._THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();

    if (this.currentIdleAction) {
      this.currentIdleAction.crossFadeTo(action, 0.3, true);
    }

    const onFinished = (e) => {
      if (e.action === action) {
        const idleName = this._findIdleClip();
        if (idleName) this.playIdle(idleName);
        this.mixer.removeEventListener("finished", onFinished);
      }
    };
    this.mixer.addEventListener("finished", onFinished);
  }

  setPostureTarget(posture) {
    this._postureTarget = posture || {};
  }

  update(delta) {
    if (this.mixer) {
      this.mixer.update(delta);
    }

    if (!this.idleEnabled) return;

    const t = performance.now() / 1000 - this._startTime;
    this._updateBreathing(t);
    this._updateBodySway(t);
    this._updateHeadDrift(t);
    this._updateArmsDown(delta);
    this._updateSaccades();
    this._updateEyeBones();
    this._updateBlink();
    this._updatePosture(delta);

    // Debug: log first few frames to confirm update loop is running
    if (!this._loggedFrames) this._loggedFrames = 0;
    if (this._loggedFrames < 3) {
      console.log("[AnimCtrl] update frame", this._loggedFrames, "t=", t.toFixed(2),
        "head?", !!this._headBone, "spine?", !!this._spineBone);
      this._loggedFrames++;
    }
  }

  // --- Breathing ---
  _updateBreathing(t) {
    const breathCycle = Math.sin(t * 2.094); // ~3s cycle

    if (this._spineBone) {
      this._spineBone.scale.y = 1 + 0.006 * breathCycle;
    }
    if (this._spine1Bone) {
      this._spine1Bone.scale.y = 1 + 0.004 * breathCycle;
    }
    if (this._spine2Bone) {
      const rest = this._restPoses.get(this._spine2Bone);
      if (rest) this._spine2Bone.rotation.x = rest.x + 0.008 * breathCycle;
    }
  }

  // --- Subtle body sway ---
  _updateBodySway(t) {
    if (!this._spineBone) return;
    const rest = this._restPoses.get(this._spineBone);
    if (!rest) return;
    const phase = this._swayPhase;
    // Slow irregular sway — lerp toward target for smoothness
    const targetX = rest.x + 0.008 * Math.sin(t * 0.41 + phase) + 0.004 * Math.sin(t * 0.67 + phase);
    const targetZ = rest.z + 0.006 * Math.sin(t * 0.53 + phase) + 0.003 * Math.sin(t * 0.89 + phase);
    this._spineBone.rotation.x += (targetX - this._spineBone.rotation.x) * 0.04;
    this._spineBone.rotation.z += (targetZ - this._spineBone.rotation.z) * 0.04;
  }

  // --- Head drift ---
  _updateHeadDrift(t) {
    const bone = this._headBone || this._neckBone;
    if (!bone) return;
    const rest = this._restPoses.get(bone);
    if (!rest) return;

    // Gentle head movement — use lerp for smoothness instead of direct set
    const targetX = rest.x + 0.02 * Math.sin(t * 0.898) + 0.008 * Math.sin(t * 0.37);
    const targetY = rest.y + 0.018 * Math.sin(t * 0.698) + 0.006 * Math.sin(t * 0.29);
    const targetZ = rest.z + 0.008 * Math.sin(t * 0.571);
    const smooth = 0.03; // Slow lerp to prevent jerky transitions
    bone.rotation.x += (targetX - bone.rotation.x) * smooth;
    bone.rotation.y += (targetY - bone.rotation.y) * smooth;
    bone.rotation.z += (targetZ - bone.rotation.z) * smooth;

    // Independent neck movement (smaller, smoother)
    if (this._neckBone && bone !== this._neckBone) {
      const neckRest = this._restPoses.get(this._neckBone);
      if (neckRest) {
        const nTargetX = neckRest.x + 0.006 * Math.sin(t * 0.55);
        const nTargetY = neckRest.y + 0.005 * Math.sin(t * 0.42);
        this._neckBone.rotation.x += (nTargetX - this._neckBone.rotation.x) * smooth;
        this._neckBone.rotation.y += (nTargetY - this._neckBone.rotation.y) * smooth;
      }
    }
  }

  _updateArmsDown(delta) {
    const armLerp = (1 - Math.pow(0.85, delta * 60)) * 0.5;

    // Use upper arm bones if available, otherwise fall back to clavicles
    const leftArm = this._upperArmL || this._clavicleL;
    const rightArm = this._upperArmR || this._clavicleR;
    const usingClavicles = !this._upperArmL && (this._clavicleL || this._clavicleR);

    // Clavicles need different rotation values — they rotate the whole shoulder+arm unit
    // Upper arm bones rotate just the arm from the shoulder joint
    if (usingClavicles) {
      if (leftArm) {
        const rest = this._restPoses.get(leftArm);
        if (rest) {
          // Rotate clavicle down and slightly forward
          const targetX = rest.x + 0.1;
          const targetY = rest.y - 0.15;
          const targetZ = rest.z + 0.55;   // rotate down from T-pose
          leftArm.rotation.x += (targetX - leftArm.rotation.x) * armLerp;
          leftArm.rotation.y += (targetY - leftArm.rotation.y) * armLerp;
          leftArm.rotation.z += (targetZ - leftArm.rotation.z) * armLerp;
        }
      }
      if (rightArm) {
        const rest = this._restPoses.get(rightArm);
        if (rest) {
          const targetX = rest.x + 0.1;
          const targetY = rest.y + 0.15;
          const targetZ = rest.z - 0.55;   // mirror
          rightArm.rotation.x += (targetX - rightArm.rotation.x) * armLerp;
          rightArm.rotation.y += (targetY - rightArm.rotation.y) * armLerp;
          rightArm.rotation.z += (targetZ - rightArm.rotation.z) * armLerp;
        }
      }
    } else {
      // Standard upper arm rotation
      if (leftArm) {
        const rest = this._restPoses.get(leftArm);
        if (rest) {
          const targetX = rest.x + 0.15;
          const targetY = rest.y + 0.06;
          const targetZ = rest.z + 1.2;
          leftArm.rotation.x += (targetX - leftArm.rotation.x) * armLerp;
          leftArm.rotation.y += (targetY - leftArm.rotation.y) * armLerp;
          leftArm.rotation.z += (targetZ - leftArm.rotation.z) * armLerp;
        }
      }
      if (rightArm) {
        const rest = this._restPoses.get(rightArm);
        if (rest) {
          const targetX = rest.x + 0.15;
          const targetY = rest.y - 0.06;
          const targetZ = rest.z - 1.2;
          rightArm.rotation.x += (targetX - rightArm.rotation.x) * armLerp;
          rightArm.rotation.y += (targetY - rightArm.rotation.y) * armLerp;
          rightArm.rotation.z += (targetZ - rightArm.rotation.z) * armLerp;
        }
      }
    }

    // Forearm bend (only if forearm bones exist)
    if (this._forearmL) {
      const rest = this._restPoses.get(this._forearmL);
      if (rest) {
        this._forearmL.rotation.x += (rest.x + 0.15 - this._forearmL.rotation.x) * armLerp * 0.7;
        this._forearmL.rotation.z += (rest.z + 0.1 - this._forearmL.rotation.z) * armLerp * 0.5;
      }
    }
    if (this._forearmR) {
      const rest = this._restPoses.get(this._forearmR);
      if (rest) {
        this._forearmR.rotation.x += (rest.x + 0.15 - this._forearmR.rotation.x) * armLerp * 0.7;
        this._forearmR.rotation.z += (rest.z - 0.1 - this._forearmR.rotation.z) * armLerp * 0.5;
      }
    }
  }

  // --- Eye saccades ---
  _updateSaccades() {
    const now = performance.now();
    if (now >= this._nextSaccadeTime) {
      this._saccadeTarget.x = (Math.random() - 0.5) * 0.06;
      this._saccadeTarget.y = (Math.random() - 0.5) * 0.03;
      this._nextSaccadeTime = now + 800 + Math.random() * 2500;
    }
    const speed = 0.15;
    this._saccadeCurrent.x += (this._saccadeTarget.x - this._saccadeCurrent.x) * speed;
    this._saccadeCurrent.y += (this._saccadeTarget.y - this._saccadeCurrent.y) * speed;
  }

  // --- Apply saccade to eye bones ---
  _updateEyeBones() {
    if (!this._eyeBoneL && !this._eyeBoneR) return;
    const saccade = this._saccadeCurrent;
    if (this._eyeBoneL) {
      const rest = this._restPoses.get(this._eyeBoneL) || { x: 0, y: 0, z: 0 };
      this._eyeBoneL.rotation.y = rest.y + saccade.x;
      this._eyeBoneL.rotation.x = rest.x + saccade.y;
    }
    if (this._eyeBoneR) {
      const rest = this._restPoses.get(this._eyeBoneR) || { x: 0, y: 0, z: 0 };
      this._eyeBoneR.rotation.y = rest.y + saccade.x;
      this._eyeBoneR.rotation.x = rest.x + saccade.y;
    }
  }

  // --- Blink via eyelid bones ---
  _updateBlink() {
    const now = performance.now();

    // State machine for natural blink timing
    if (this._blinkPhase === 0 && now >= this._nextBlinkTime) {
      this._blinkPhase = 1;
      this._blinkProgress = 0;
    }
    if (this._blinkPhase === 1) {
      this._blinkProgress += 0.18; // close quickly
      if (this._blinkProgress >= 1) {
        this._blinkPhase = 2;
        this._blinkProgress = 1;
      }
    } else if (this._blinkPhase === 2) {
      this._blinkProgress -= 0.10; // open a bit slower
      if (this._blinkProgress <= 0) {
        this._blinkPhase = 0;
        this._blinkProgress = 0;
        // Double-blink ~20% of the time
        const doubleBlink = Math.random() < 0.2;
        this._nextBlinkTime = now + (doubleBlink ? 200 : 2500 + Math.random() * 4000);
      }
    }

    // Apply blink to lid bones via rotation offset from rest
    if (this._upperLidBonesL.length > 0 || this._upperLidBonesR.length > 0) {
      const blinkAngle = this._blinkProgress * 0.35; // radians to close the lid
      for (const bone of this._upperLidBonesL) {
        const rest = this._restPoses.get(bone);
        if (rest) bone.rotation.x = rest.x + blinkAngle;
      }
      for (const bone of this._upperLidBonesR) {
        const rest = this._restPoses.get(bone);
        if (rest) bone.rotation.x = rest.x + blinkAngle;
      }
      // Lower lids move slightly on blink
      const lowerAngle = this._blinkProgress * -0.08;
      for (const bone of this._lowerLidBonesL) {
        const rest = this._restPoses.get(bone);
        if (rest) bone.rotation.x = rest.x + lowerAngle;
      }
      for (const bone of this._lowerLidBonesR) {
        const rest = this._restPoses.get(bone);
        if (rest) bone.rotation.x = rest.x + lowerAngle;
      }
    }
  }

  // --- Posture (driven by emotion controller) ---
  _updatePosture(delta) {
    const bone = this._headBone || this._neckBone;
    if (!bone || !this._postureTarget) return;
    const lerp = 1 - Math.pow(0.92, delta * 60);
    const target = this._postureTarget;
    if (target._headPitch !== undefined) {
      bone.rotation.x += (target._headPitch - bone.rotation.x) * lerp * 0.3;
    }
    if (target._headYaw !== undefined) {
      bone.rotation.y += (target._headYaw - bone.rotation.y) * lerp * 0.3;
    }
    if (target._headRoll !== undefined) {
      bone.rotation.z += (target._headRoll - bone.rotation.z) * lerp * 0.3;
    }
  }

  // --- Public getters ---

  getBlinkState() {
    return this._blinkProgress;
  }

  getSaccade() {
    return this._saccadeCurrent;
  }

  getJawBone() {
    return this._jawBone;
  }

  getLipBones() {
    return this._lipBones;
  }

  getLipLowerCenter() {
    return this._lipLowerCenter;
  }

  hasFacialBones() {
    return this._hasFacialBones;
  }

  getRestPose(bone) {
    return this._restPoses.get(bone);
  }

  enableIdle(enabled) {
    this.idleEnabled = enabled;
  }

  dispose() {
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    this.clips = {};
    this.actions = {};
    this.currentIdleAction = null;
    this._headBone = null;
    this._spineBone = null;
    this._spine1Bone = null;
    this._spine2Bone = null;
    this._jawBone = null;
    this._shoulderL = null;
    this._shoulderR = null;
    this._clavicleL = null;
    this._clavicleR = null;
    this._upperArmL = null;
    this._upperArmR = null;
    this._forearmL = null;
    this._forearmR = null;
    this._neckBone = null;
    this._eyeBoneL = null;
    this._eyeBoneR = null;
    this._upperLidBonesL = [];
    this._upperLidBonesR = [];
    this._lowerLidBonesL = [];
    this._lowerLidBonesR = [];
    this._lipBones = [];
    this._lipLowerCenter = null;
    this._browBonesL = [];
    this._browBonesR = [];
    this._browCenter = null;
    this._restPoses.clear();
  }
}

module.exports = { AnimationController };
