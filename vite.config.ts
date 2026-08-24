import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

import { crx } from '@crxjs/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

import manifest from './src/manifest.ts';

const ORT_ASSETS = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
] as const;

function packageOrtAssets(): Plugin {
  return {
    name: 'smart-dictation:package-ort-assets',
    apply: 'build',
    async buildStart() {
      for (const fileName of ORT_ASSETS) {
        const sourcePath = resolve(
          process.cwd(),
          'node_modules/onnxruntime-web/dist',
          fileName,
        );

        this.emitFile({
          type: 'asset',
          fileName: `ort/${fileName}`,
          source: await readFile(sourcePath),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [crx({ manifest }), packageOrtAssets()],
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: resolve(import.meta.dirname, 'src/offscreen/offscreen.html'),
        permission: resolve(import.meta.dirname, 'src/permission/permission.html'),
      },
    },
  },
});
