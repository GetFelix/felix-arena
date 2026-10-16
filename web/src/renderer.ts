import {
  type Camera,
  HalfFloatType,
  NeutralToneMapping,
  type Object3D,
  PCFSoftShadowMap,
  type Scene,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/** The WebGL renderer: soft shadows and Khronos PBR Neutral tone mapping, which keeps the palette's hues. */
export function createRenderer(): WebGLRenderer {
  const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.12;
  return renderer;
}

const vignetteShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0.42 }, grain: { value: 0.025 }, time: { value: 0 } },
  vertexShader:
    'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float amount; uniform float grain; uniform float time; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.2, length(d * vec2(1.0, 0.82)));
      c.rgb *= mix(1.0 - amount, 1.0, v);
      c.rgb += (hash(vUv * 1000.0) - 0.5) * grain;
      gl_FragColor = c;
    }`,
};

/** Post processing: ambient occlusion, bloom on emissive surfaces, tone mapping, then a light vignette and grain. */
export class Post {
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private readonly vignette: ShaderPass;

  /** `fx` holds the glow effects, which are left out of ambient occlusion and then drawn over it. */
  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera, fx: Object3D) {
    const [w, h] = [innerWidth, innerHeight];
    const rt = new WebGLRenderTarget(w, h, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    const gtao = new GTAOPass(scene, camera, w, h);
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 16 });
    const render = gtao.render.bind(gtao);
    gtao.render = (...args) => {
      fx.visible = false;
      render(...args);
      fx.visible = true;
    };
    this.gtao = gtao;
    this.composer.addPass(gtao);
    this.composer.addPass(new UnrealBloomPass(new Vector2(w / 2, h / 2), 0.42, 0.45, 0.9));
    this.composer.addPass(new OutputPass());
    this.vignette = new ShaderPass(vignetteShader);
    this.composer.addPass(this.vignette);
  }

  setSize(renderer: WebGLRenderer, width: number, height: number): void {
    renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.gtao.setSize(width, height);
  }

  /** Draws a frame. `t` seeds the grain, so a frozen moment draws the same grain every frame. */
  render(t: number): void {
    this.vignette.uniforms.time!.value = t % 10;
    this.composer.render();
  }
}
