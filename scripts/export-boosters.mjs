#!/usr/bin/env node
// Render every booster GLB to a 2D PNG using the running dev server.
// Uses the EXACT same rig as the in-game booster slot icons (game.js:renderGLBIcon):
// ortho camera, ACES tone mapping, exposure 1.6, auto-rotate to best facing,
// ambient 1.8 + directional 1.4 at (2,3,8). No rim light, no y-lift.
//
// Requires:  npm run dev  (Vite serving on :3000)
// Output:    public/assets/boosters-2d/{row-clear,col-clear,color-bomb,hammer,shuffle}.png
//
// Size can be overridden with --size=N   (default 512).

import puppeteer from 'puppeteer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const OUT  = join(REPO, 'public', 'assets', 'boosters-2d');

const sizeArg = process.argv.find(a => a.startsWith('--size='));
const SIZE = sizeArg ? parseInt(sizeArg.slice('--size='.length), 10) : 512;
const URL = 'http://localhost:3000/';

mkdirSync(OUT, { recursive: true });

console.log(`[export-boosters] target ${OUT}`);
console.log(`[export-boosters] size ${SIZE}×${SIZE}`);

const browser = await puppeteer.launch({ headless: 'new' });
try {
  const page = await browser.newPage();
  page.on('console', msg => {
    const t = msg.text();
    if (t.startsWith('[boosters]') || t.startsWith('→')) console.log('  ', t);
  });
  console.log(`[export-boosters] loading ${URL}`);
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 60000 });

  await page.waitForFunction(() => !!window.__pengu, { timeout: 30000 });

  const dataUrls = await page.evaluate(async (size) => {
    const out = {};
    const BOOSTERS = {
      'row-clear':  '/assets/boosters/row-clear.glb',
      'col-clear':  '/assets/boosters/col-clear.glb',
      'color-bomb': '/assets/boosters/color-bomb.glb',
      'hammer':     '/assets/boosters/hammer.glb',
      'shuffle':    '/assets/boosters/shuffle.glb',
    };
    const THREE = await import('/node_modules/.vite/deps/three.js');
    const { createGLTFLoader } = await import('/src/gltf-loader.js');
    const loader = createGLTFLoader();
    const loadGLB = (p) => new Promise((res, rej) =>
      loader.load(p, (g) => res(g.scene), undefined, rej));

    for (const [name, path] of Object.entries(BOOSTERS)) {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const pr = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      pr.setSize(size, size, false);
      pr.setPixelRatio(1);
      pr.setClearColor(0x000000, 0);
      pr.toneMapping = THREE.ACESFilmicToneMapping;
      pr.toneMappingExposure = 1.6;

      const ps = new THREE.Scene();
      ps.add(new THREE.AmbientLight(0xffffff, 1.8));
      const dl = new THREE.DirectionalLight(0xffffff, 1.4);
      dl.position.set(2, 3, 8);
      ps.add(dl);

      const model = await loadGLB(path);

      // Auto-rotate to best facing (same as game.js)
      const rots = [[0,0,0], [-Math.PI/2,0,0], [0,-Math.PI/2,0]];
      let best = rots[0], bestArea = 0;
      for (const r of rots) {
        model.rotation.set(r[0], r[1], r[2]);
        const b = new THREE.Box3().setFromObject(model);
        const s = new THREE.Vector3(); b.getSize(s);
        if (s.x * s.y > bestArea) { bestArea = s.x * s.y; best = r; }
      }
      model.rotation.set(best[0], best[1], best[2]);

      const box = new THREE.Box3().setFromObject(model);
      const sz = new THREE.Vector3(); box.getSize(sz);
      model.scale.multiplyScalar(3.5 / Math.max(sz.x, sz.y, sz.z));
      const nb = new THREE.Box3().setFromObject(model);
      const ct = new THREE.Vector3(); nb.getCenter(ct);
      model.position.sub(ct);
      ps.add(model);

      const finalBox = new THREE.Box3().setFromObject(model);
      const finalSz = new THREE.Vector3(); finalBox.getSize(finalSz);
      const pad = 1.15;
      const halfW = finalSz.x * pad / 2;
      const halfH = finalSz.y * pad / 2;
      const camH = Math.max(halfH, halfW);
      const pc = new THREE.OrthographicCamera(-camH, camH, camH, -camH, 0.1, 100);
      pc.position.set(0, 0, 15);
      pc.lookAt(0, 0, 0);

      // Warm-up frame then final capture
      pr.render(ps, pc);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      pr.render(ps, pc);

      out[name] = canvas.toDataURL('image/png');
      pr.dispose();
      console.log('→', name);
    }
    return out;
  }, SIZE);

  for (const [name, dataUrl] of Object.entries(dataUrls)) {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    const file = join(OUT, name + '.png');
    writeFileSync(file, Buffer.from(base64, 'base64'));
    console.log('  wrote', file.replace(REPO + '/', ''));
  }
  console.log(`[export-boosters] ${Object.keys(dataUrls).length} PNG(s) written.`);
} finally {
  await browser.close();
}
