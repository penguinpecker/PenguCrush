import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Shared Draco decoder so every GLTFLoader in the app uses the same one.
// The compressed GLBs in /public/assets use Draco geometry + WebP textures.
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
draco.setDecoderConfig({ type: 'js' });

export function createGLTFLoader() {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  return loader;
}
