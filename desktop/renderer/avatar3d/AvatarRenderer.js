const fs = require("fs");
const nodePath = require("path");
const { ipcRenderer } = require("electron");

const TARGET_FPS = 30;
const FRAME_BUDGET = 1 / TARGET_FPS;

function _log(msg) {
  console.log(msg);
  try { ipcRenderer.send("renderer-log", msg); } catch (_) {}
}

// Load Three.js + GLTFLoader from CommonJS to avoid renderer ESM import crashes.
let THREE = null;
let GLTFLoaderClass = null;

async function ensureThree() {
  if (!THREE) {
    _log("[ensureThree] requiring three via CJS...");
    THREE = require("three");
    _log("[ensureThree] three loaded, REVISION=" + THREE.REVISION);
  }
  if (!GLTFLoaderClass) {
    _log("[ensureThree] requiring GLTFLoader from three-stdlib...");
    const mod = require("three-stdlib");
    GLTFLoaderClass = mod.GLTFLoader;
    _log("[ensureThree] GLTFLoader loaded OK");
  }
  return THREE;
}

class AvatarRenderer {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.scene = null;
    this.clock = null;
    this.renderer = null;
    this.camera = null;
    this.model = null;
    this.meshes = [];
    this.skeleton = null;
    this._animFrameId = null;
    this._frameAccumulator = 0;
    this._onUpdateCallbacks = [];
    this._shadowPlane = null;
    this._onResize = null;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;
    _log("[AvatarRenderer] init: calling ensureThree...");
    await ensureThree();

    _log("[AvatarRenderer] creating Scene + Clock...");
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();

    _log("[AvatarRenderer] creating WebGLRenderer...");
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    _log("[AvatarRenderer] WebGLRenderer created OK");
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 1.4, 2.5);
    this.camera.lookAt(0, 1.2, 0);

    this._setupLighting();

    this._onResize = this._handleResize.bind(this);
    window.addEventListener("resize", this._onResize);
    this._handleResize();

    this._initialized = true;
  }

  _setupLighting() {
    // Key light — warm, upper-right, casts shadows
    const keyLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
    keyLight.position.set(2, 3, 2);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 10;
    keyLight.shadow.camera.left = -2;
    keyLight.shadow.camera.right = 2;
    keyLight.shadow.camera.top = 3;
    keyLight.shadow.camera.bottom = -1;
    keyLight.shadow.bias = -0.001;
    this.scene.add(keyLight);

    // Fill light — cool, left side, no shadow
    const fillLight = new THREE.DirectionalLight(0xc8d8ff, 0.5);
    fillLight.position.set(-2, 2, 1);
    this.scene.add(fillLight);

    // Rim/back light — behind and above
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.8);
    rimLight.position.set(0, 3, -2);
    this.scene.add(rimLight);

    // Subtle ambient
    const ambient = new THREE.AmbientLight(0x404050, 0.3);
    this.scene.add(ambient);

    // Shadow-receiving ground plane (transparent except shadows)
    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(5, 5),
      new THREE.ShadowMaterial({ opacity: 0.25 })
    );
    shadowPlane.rotation.x = -Math.PI / 2;
    shadowPlane.position.y = 0;
    shadowPlane.receiveShadow = true;
    this.scene.add(shadowPlane);
    this._shadowPlane = shadowPlane;
  }

  async loadModel(filePath) {
    if (!this._initialized) await this.init();

    this._disposeModel();

    console.log("[AvatarRenderer] loadModel: reading file via fs:", filePath);
    const fileBuffer = fs.readFileSync(filePath);
    const arrayBuffer = fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset + fileBuffer.byteLength
    );
    console.log("[AvatarRenderer] loadModel: file read OK, size:", fileBuffer.length, "bytes");

    // Use parse() instead of load() to avoid fetch('file://...') crashes in Electron
    const loader = new GLTFLoaderClass();
    const resourcePath = nodePath.dirname(filePath) + nodePath.sep;
    const gltf = await new Promise((resolve, reject) => {
      loader.parse(arrayBuffer, resourcePath, resolve, reject);
    });
    console.log("[AvatarRenderer] loadModel: GLB parsed successfully");

    this.model = gltf.scene;
    this.scene.add(this.model);

    // Collect skinned meshes for blendshape access
    this.meshes = [];
    this.skeleton = null;
    this.model.traverse((child) => {
      if (child.isSkinnedMesh) {
        this.meshes.push(child);
        child.castShadow = true;
        child.receiveShadow = true;
        if (!this.skeleton && child.skeleton) {
          this.skeleton = child.skeleton;
        }
      } else if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Auto-frame camera on model
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Position shadow plane at model's feet
    this._shadowPlane.position.y = box.min.y;

    // Frame upper body
    this.camera.position.set(0, center.y + size.y * 0.1, size.y * 1.6);
    this.camera.lookAt(center.x, center.y + size.y * 0.15, center.z);

    return { gltf, meshes: this.meshes, skeleton: this.skeleton };
  }

  onUpdate(callback) {
    this._onUpdateCallbacks.push(callback);
  }

  clearUpdateCallbacks() {
    this._onUpdateCallbacks = [];
  }

  start() {
    if (this._animFrameId !== null) return;
    this.clock.start();
    this._frameAccumulator = 0;
    this._renderLoop();
  }

  stop() {
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }
  }

  _renderLoop() {
    this._animFrameId = requestAnimationFrame(() => this._renderLoop());

    const delta = this.clock.getDelta();
    this._frameAccumulator += delta;
    if (this._frameAccumulator < FRAME_BUDGET) return;

    // Clamp to avoid spiral of death
    const effectiveDelta = Math.min(this._frameAccumulator, FRAME_BUDGET * 2);
    this._frameAccumulator = 0;

    for (const cb of this._onUpdateCallbacks) {
      cb(effectiveDelta);
    }

    this.renderer.render(this.scene, this.camera);
  }

  _handleResize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _disposeModel() {
    if (!this.model) return;
    this.model.traverse((child) => {
      if (child.isMesh) {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const mat of materials) {
            for (const key of Object.keys(mat)) {
              if (mat[key] && mat[key].isTexture) {
                mat[key].dispose();
              }
            }
            mat.dispose();
          }
        }
      }
    });
    this.scene.remove(this.model);
    this.model = null;
    this.meshes = [];
    this.skeleton = null;
  }

  dispose() {
    this.stop();
    if (this._onResize) {
      window.removeEventListener("resize", this._onResize);
    }
    this._disposeModel();
    if (this.renderer) {
      this.renderer.dispose();
    }
    this._onUpdateCallbacks = [];
    this._initialized = false;
  }
}

module.exports = { AvatarRenderer, ensureThree };
