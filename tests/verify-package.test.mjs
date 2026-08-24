import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyPackageDir } from '../scripts/verify-package.mjs';

const BASE_MANIFEST = {
  manifest_version: 3,
  minimum_chrome_version: '116',
  name: 'Smart Dictation AI',
  version: '0.0.1',
  permissions: ['activeTab', 'offscreen', 'storage', 'unlimitedStorage', 'scripting'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_popup: 'popup.html',
    default_icon: {
      '16': 'icons/icon-16.png',
    },
  },
  options_page: 'options.html',
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
};

async function writeFile(rootDir, relativePath, content = '') {
  const absolutePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
}

async function createValidDist(overrides = {}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-package-'));
  const manifest = structuredClone(BASE_MANIFEST);

  if (overrides.manifest) {
    Object.assign(manifest, overrides.manifest);
  }

  await writeFile(tempRoot, 'manifest.json', JSON.stringify(manifest, null, 2));
  await writeFile(
    tempRoot,
    'background.js',
    'const ortBaseUrl = chrome.runtime.getURL("ort/"); console.log(ortBaseUrl);\n',
  );
  await writeFile(tempRoot, 'popup.html', '<!doctype html><html><body></body></html>\n');
  await writeFile(tempRoot, 'options.html', '<!doctype html><html><body><script src="options.js"></script></body></html>\n');
  await writeFile(tempRoot, 'options.js', 'console.log("options");\n');
  await writeFile(tempRoot, 'icons/icon-16.png', 'png');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.jsep.mjs', 'export const localAsset = true;\n');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.jsep.wasm', 'wasm');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.mjs', 'export const localAsset = true;\n');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.wasm', 'wasm');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.asyncify.mjs', 'export const localAsset = true;\n');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.asyncify.wasm', 'wasm');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.jspi.mjs', 'export const localAsset = true;\n');
  await writeFile(tempRoot, 'ort/ort-wasm-simd-threaded.jspi.wasm', 'wasm');

  for (const [relativePath, content] of Object.entries(overrides.extraFiles ?? {})) {
    await writeFile(tempRoot, relativePath, content);
  }

  for (const relativePath of overrides.removeFiles ?? []) {
    await fs.rm(path.join(tempRoot, relativePath), { force: true });
  }

  return tempRoot;
}

async function expectFailure(distDir, expectedMessage) {
  await assert.rejects(
    () => verifyPackageDir(distDir),
    (error) => {
      assert.match(error.message, expectedMessage);
      return true;
    },
  );
}

test('passes when dist contains only approved manifest settings and packaged local assets', async () => {
  const distDir = await createValidDist();

  const result = await verifyPackageDir(distDir);

  assert.equal(result.manifestVersion, 3);
  assert.equal(result.minimumChromeVersion, '116');
});

test('fails when a manifest-referenced asset is missing from dist', async () => {
  const distDir = await createValidDist({ removeFiles: ['background.js'] });

  await expectFailure(distDir, /Manifest-referenced asset is missing from dist: background\.js/);
});

test('fails when the default popup is missing from dist', async () => {
  const distDir = await createValidDist({ removeFiles: ['popup.html'] });

  await expectFailure(distDir, /Manifest-referenced asset is missing from dist: popup\.html/);
});

test('fails when the manifest contains an unapproved permission', async () => {
  const distDir = await createValidDist({
    manifest: {
      permissions: [...BASE_MANIFEST.permissions, 'tabs'],
    },
  });

  await expectFailure(distDir, /Unapproved manifest permission: tabs/);
});

test('fails when the manifest contains an unapproved host permission pattern', async () => {
  const distDir = await createValidDist({
    manifest: {
      host_permissions: [...BASE_MANIFEST.host_permissions, 'https://example.com/*'],
    },
  });

  await expectFailure(distDir, /Mandatory host permissions must be exactly/);
});

test('fails when broad site access is mandatory instead of optional', async () => {
  const distDir = await createValidDist({
    manifest: {
      host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*', 'https://*/*'],
    },
  });

  await expectFailure(distDir, /Mandatory host permissions must be exactly/);
});

test('fails when the extension pages CSP differs from the approved value', async () => {
  const distDir = await createValidDist({
    manifest: {
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self';",
      },
    },
  });

  await expectFailure(distDir, /Expected CSP/);
});

test('fails when minimum_chrome_version is not 116', async () => {
  const distDir = await createValidDist({
    manifest: {
      minimum_chrome_version: '115',
    },
  });

  await expectFailure(distDir, /Expected minimum_chrome_version "116"/);
});

test('fails when a script asset imports executable code from an https URL', async () => {
  const distDir = await createValidDist({
    extraFiles: {
      'background.js': 'import "https://cdn.example.com/remote.js";\n',
    },
  });

  await expectFailure(distDir, /Remote executable import\/source detected in script asset: background\.js/);
});

test('fails when the service worker graph imports page DOM code', async () => {
  const distDir = await createValidDist({
    extraFiles: {
      'background.js': 'import "./assets/content.js";\n',
      'assets/content.js': 'document.createElement("button");\n',
    },
  });

  await expectFailure(distDir, /Page DOM code detected in service worker graph: assets\/content\.js/);
});

test('fails when a script fetches executable wasm from a remote URL', async () => {
  const distDir = await createValidDist({
    extraFiles: {
      'payload.js':
        'const bytes = await fetch("https://example.com/payload.wasm").then((r) => r.arrayBuffer()); WebAssembly.instantiate(bytes);\n',
    },
  });

  await expectFailure(distDir, /Remote WASM URL detected in script asset: payload\.js/);
});

test('fails when no emitted script resolves the local ORT directory', async () => {
  const distDir = await createValidDist({
    extraFiles: {
      'background.js': 'console.log("local but not wired");\n',
    },
  });

  await expectFailure(distDir, /Missing extension-local ORT runtime URL resolver/);
});

test('fails when an extension page includes a remote script src', async () => {
  const distDir = await createValidDist({
    extraFiles: {
      'options.html':
        '<!doctype html><html><body><script src="https://cdn.example.com/remote.js"></script></body></html>\n',
    },
  });

  await expectFailure(distDir, /Remote script src detected in HTML asset: options\.html/);
});

test('fails when an extension page includes an inline executable script', async () => {
  const distDir = await createValidDist({
    extraFiles: {
      'options.html': '<!doctype html><html><body><script>console.log("inline")</script></body></html>\n',
    },
  });

  await expectFailure(distDir, /Inline executable script detected in HTML asset: options\.html/);
});

test('fails when the packaged ONNX JSEP module asset is missing', async () => {
  const distDir = await createValidDist({
    removeFiles: ['ort/ort-wasm-simd-threaded.jsep.mjs'],
  });

  await expectFailure(distDir, /Missing packaged ONNX JSEP module asset/);
});

test('fails when the packaged ONNX JSEP wasm asset is missing', async () => {
  const distDir = await createValidDist({
    removeFiles: ['ort/ort-wasm-simd-threaded.jsep.wasm'],
  });

  await expectFailure(distDir, /Missing packaged ONNX JSEP wasm asset/);
});
