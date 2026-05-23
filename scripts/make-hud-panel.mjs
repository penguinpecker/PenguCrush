/**
 * Derive textless objective/hud panel GLBs from score-panel.glb by removing
 * geometry above a Y threshold (baked "Score" label). Labels are HTML/CSS.
 *
 * Usage: node scripts/make-hud-panel.mjs
 *        Y_CUT=0.38 node scripts/make-hud-panel.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import draco3d from 'draco3d';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public/assets/hud/score-panel.glb');
const OUT_FILES = [
  path.join(ROOT, 'public/assets/hud/objective-panel.glb'),
  path.join(ROOT, 'public/assets/hud/hud-panel.glb'),
];

/** Drop any triangle above this Y (letter tops). */
const Y_CUT = Number(process.env.Y_CUT || 0.32);
/** Also drop center-top band where baked "Score" letter bodies sit. */
const CENTER_Y_CUT = Number(process.env.CENTER_Y_CUT || 0.14);
const CENTER_X_CUT = Number(process.env.CENTER_X_CUT || 0.42);

function shouldDropTriangle(posArray, i0, i1, i2) {
  const x0 = posArray[i0 * 3];
  const x1 = posArray[i1 * 3];
  const x2 = posArray[i2 * 3];
  const y0 = posArray[i0 * 3 + 1];
  const y1 = posArray[i1 * 3 + 1];
  const y2 = posArray[i2 * 3 + 1];
  const cx = (x0 + x1 + x2) / 3;
  const cy = (y0 + y1 + y2) / 3;
  const maxY = Math.max(y0, y1, y2);
  if (maxY > Y_CUT) return true;
  if (cy > CENTER_Y_CUT && Math.abs(cx) < CENTER_X_CUT) return true;
  return false;
}

function filterPrimitiveTop(prim) {
  const position = prim.getAttribute('POSITION');
  const indices = prim.getIndices();
  if (!position || !indices) return 0;

  const posArray = position.getArray();
  const idxArray = indices.getArray();
  const keep = [];

  for (let i = 0; i < idxArray.length; i += 3) {
    const i0 = idxArray[i];
    const i1 = idxArray[i + 1];
    const i2 = idxArray[i + 2];
    if (!shouldDropTriangle(posArray, i0, i1, i2)) keep.push(i0, i1, i2);
  }

  if (keep.length === idxArray.length) return 0;

  const Uint = idxArray.constructor;
  prim.setIndices(prim.getIndices().clone().setArray(new Uint(keep)));
  return idxArray.length - keep.length;
}

async function main() {
  const decoder = await draco3d.createDecoderModule();
  const encoder = await draco3d.createEncoderModule();

  const io = new NodeIO()
    .registerExtensions([KHRDracoMeshCompression, EXTTextureWebP])
    .registerDependencies({
      'draco3d.decoder': decoder,
      'draco3d.encoder': encoder,
    });

  const srcDoc = await io.read(SRC);
  let removed = 0;
  for (const mesh of srcDoc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      removed += filterPrimitiveTop(prim);
    }
  }

  for (const out of OUT_FILES) {
    await io.write(out, srcDoc);
    const stat = fs.statSync(out);
    console.log(`Wrote ${out} (${(stat.size / 1024).toFixed(1)} KB)`);
  }
  console.log(`Removed ${removed} index entries (maxY>${Y_CUT} or center cy>${CENTER_Y_CUT}, |x|<${CENTER_X_CUT})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
