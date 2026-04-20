// ═══════════════════════════════════════════════════════════════
//  DEV: export 2D PNG renders of every booster GLB
//
//  Run  __pengu.exportBoosterPNGs()  in the browser console on any
//  page of the app. It sets up a hidden WebGL canvas, renders each
//  booster GLB at the same camera/light rig used in the shop
//  preview, converts it to a transparent PNG, and triggers a browser
//  download. Five files will drop into your Downloads folder:
//
//      row-clear.png, col-clear.png, color-bomb.png,
//      hammer.png, shuffle.png
//
//  Move them into public/assets/boosters-2d/ afterwards.
//
//  Options:
//      __pengu.exportBoosterPNGs({ size: 1024 })      // higher res
//      __pengu.exportBoosterPNGs({ size: 512, gap: 250 })
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { createGLTFLoader } from './gltf-loader.js';

const BOOSTERS = {
  'row-clear':  '/assets/boosters/row-clear.glb',
  'col-clear':  '/assets/boosters/col-clear.glb',
  'color-bomb': '/assets/boosters/color-bomb.glb',
  'hammer':     '/assets/boosters/hammer.glb',
  'shuffle':    '/assets/boosters/shuffle.glb',
};

async function renderBoosterToPNG(glbPath, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setSize(size, size, false);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 1.0, 3.45);
  camera.lookAt(0, 0.02, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dir = new THREE.DirectionalLight(0xffffff, 1.2);
  dir.position.set(2, 3, 2);
  scene.add(dir);
  const rim = new THREE.DirectionalLight(0x88ccff, 0.5);
  rim.position.set(-2, 1, -1);
  scene.add(rim);

  const loader = createGLTFLoader();
  const gltf = await new Promise((resolve, reject) =>
    loader.load(glbPath, resolve, undefined, reject));
  const model = gltf.scene;

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const sz = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(sz.x, sz.y, sz.z);
  const scale = 2.05 / maxDim;
  model.scale.setScalar(scale);
  model.position.sub(center.multiplyScalar(scale));
  model.position.y += 0.1;
  scene.add(model);

  // Two frames: one warm-up (textures decode), one final capture.
  renderer.render(scene, camera);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  renderer.render(scene, camera);

  const dataUrl = canvas.toDataURL('image/png');
  renderer.dispose();
  return dataUrl;
}

function triggerDownload(name, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name + '.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function exportBoosterPNGs(opts = {}) {
  const size = opts.size || 512;
  const gap = opts.gap ?? 400; // ms between downloads (browser chokes otherwise)
  console.group(`[boosters] exporting 5 PNGs at ${size}×${size}`);
  for (const [name, path] of Object.entries(BOOSTERS)) {
    try {
      console.log('→', name, path);
      const dataUrl = await renderBoosterToPNG(path, size);
      triggerDownload(name, dataUrl);
      await new Promise(r => setTimeout(r, gap));
    } catch (err) {
      console.error('failed:', name, err);
    }
  }
  console.log('done — 5 files should be in your Downloads folder.');
  console.log('move them to public/assets/boosters-2d/');
  console.groupEnd();
}

window.__pengu = window.__pengu || {};
window.__pengu.exportBoosterPNGs = exportBoosterPNGs;
