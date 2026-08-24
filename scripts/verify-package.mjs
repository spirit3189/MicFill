import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const APPROVED_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';";
const APPROVED_PERMISSIONS = new Set([
  'activeTab',
  'offscreen',
  'storage',
  'unlimitedStorage',
  'scripting',
]);
const REQUIRED_MODEL_HOSTS = new Set([
  'https://huggingface.co/*',
  'https://*.hf.co/*',
]);
const REQUIRED_OPTIONAL_SITE_HOSTS = new Set(['http://*/*', 'https://*/*']);
const REMOTE_EXECUTABLE_PATTERN =
  /\b(?:import|export)\s*(?:[^'"]*?\sfrom\s*)?["']https?:\/\/[^"']+["']|\bimportScripts\s*\(\s*["']https?:\/\/[^"']+["']|\b(?:new\s+)?(?:Worker|SharedWorker)\s*\(\s*["']https?:\/\/[^"']+["']|\bnavigator\.serviceWorker\.register\s*\(\s*["']https?:\/\/[^"']+["']/;
const REMOTE_WASM_URL_PATTERN = /https?:\/\/[^\s"'`)]+\.wasm(?:[?#][^\s"'`)]*)?/i;
const REMOTE_SCRIPT_TAG_PATTERN =
  /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/i;
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const NON_EXECUTABLE_SCRIPT_TYPES = new Set([
  'application/json',
  'importmap',
  'speculationrules',
]);
const REQUIRED_ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.jspi.wasm',
];
const SERVICE_WORKER_DOM_PATTERN =
  /\bdocument\b|\bwindow\b|\bHTML(?:Input|TextArea|Element)\b|\bMutationObserver\b/;
const STATIC_IMPORT_PATTERN = /\bimport\s*(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']/g;

function fail(message) {
  const error = new Error(message);
  error.name = 'PackageVerificationError';
  throw error;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolutePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function normalizePosixPath(value) {
  return value.split(path.sep).join('/');
}

function isLocalRelativeAsset(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('http://') &&
    !value.startsWith('https://') &&
    !value.startsWith('chrome-extension://') &&
    !value.startsWith('data:') &&
    !value.startsWith('blob:') &&
    !value.startsWith('/') &&
    !value.startsWith('#')
  );
}

function collectLocalStrings(value) {
  if (typeof value === 'string') {
    return isLocalRelativeAsset(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectLocalStrings);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectLocalStrings);
  }
  return [];
}

function collectManifestAssetPaths(manifest) {
  const paths = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.action?.default_icon,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.devtools_page,
    manifest.side_panel?.default_path,
    manifest.icons,
    manifest.chrome_url_overrides,
    manifest.sandbox?.pages,
    ...(manifest.content_scripts ?? []).flatMap(({ js = [], css = [] }) => [...js, ...css]),
    ...(manifest.web_accessible_resources ?? []).flatMap(({ resources = [] }) => resources),
  ];

  return paths.flatMap(collectLocalStrings);
}

function validateManifestShape(manifest) {
  if (manifest.manifest_version !== 3) {
    fail(`Expected manifest_version 3, found ${String(manifest.manifest_version)}`);
  }

  if (manifest.minimum_chrome_version !== '116') {
    fail(
      `Expected minimum_chrome_version "116", found ${String(manifest.minimum_chrome_version)}`,
    );
  }

  const csp = manifest.content_security_policy?.extension_pages;
  if (csp !== APPROVED_CSP) {
    fail(`Expected CSP "${APPROVED_CSP}", found ${String(csp)}`);
  }
}

function validatePermissions(manifest) {
  const permissions = manifest.permissions ?? [];
  const hostPermissions = new Set(manifest.host_permissions ?? []);
  const optionalHostPermissions = new Set(manifest.optional_host_permissions ?? []);

  for (const permission of permissions) {
    if (!APPROVED_PERMISSIONS.has(permission)) {
      fail(`Unapproved manifest permission: ${permission}`);
    }
  }

  if (!setsEqual(hostPermissions, REQUIRED_MODEL_HOSTS)) {
    fail(`Mandatory host permissions must be exactly: ${[...REQUIRED_MODEL_HOSTS].join(', ')}`);
  }

  if (!setsEqual(optionalHostPermissions, REQUIRED_OPTIONAL_SITE_HOSTS)) {
    fail(
      `Optional site permissions must be exactly: ${[...REQUIRED_OPTIONAL_SITE_HOSTS].join(', ')}`,
    );
  }
}

function setsEqual(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

async function validateManifestAssetPaths(distDir, manifest) {
  const requiredPaths = new Set([
    ...collectManifestAssetPaths(manifest),
    'manifest.json',
  ]);

  for (const relativeAssetPath of requiredPaths) {
    const absoluteAssetPath = path.join(distDir, relativeAssetPath);
    if (!(await exists(absoluteAssetPath))) {
      fail(`Manifest-referenced asset is missing from dist: ${relativeAssetPath}`);
    }
  }
}

async function validateServiceWorkerGraph(distDir, manifest) {
  const entry = manifest.background?.service_worker;
  if (!isLocalRelativeAsset(entry)) fail('Missing local background.service_worker entry.');

  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const relativePath = pending.pop();
    if (!relativePath || visited.has(relativePath)) continue;
    visited.add(relativePath);
    const absolutePath = path.resolve(distDir, relativePath);
    if (!absolutePath.startsWith(`${path.resolve(distDir)}${path.sep}`)) {
      fail(`Service worker import escapes dist: ${relativePath}`);
    }
    const source = await fs.readFile(absolutePath, 'utf8');
    if (SERVICE_WORKER_DOM_PATTERN.test(source)) {
      fail(`Page DOM code detected in service worker graph: ${relativePath}`);
    }
    for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier?.startsWith('.')) continue;
      pending.push(normalizePosixPath(path.relative(distDir, path.resolve(path.dirname(absolutePath), specifier))));
    }
  }
}

function validateHtmlFile(relativePath, source) {
  if (REMOTE_SCRIPT_TAG_PATTERN.test(source)) {
    fail(`Remote script src detected in HTML asset: ${relativePath}`);
  }

  for (const match of source.matchAll(SCRIPT_TAG_PATTERN)) {
    const attributes = match[1] ?? '';
    const inlineBody = (match[2] ?? '').trim();
    const typeMatch = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const scriptType = typeMatch?.[1]?.trim().toLowerCase() ?? '';
    const hasSrc = /\bsrc\s*=/i.test(attributes);

    if (!hasSrc && inlineBody.length > 0 && !NON_EXECUTABLE_SCRIPT_TYPES.has(scriptType)) {
      fail(`Inline executable script detected in HTML asset: ${relativePath}`);
    }
  }
}

function validateScriptFile(relativePath, source) {
  if (REMOTE_EXECUTABLE_PATTERN.test(source)) {
    fail(`Remote executable import/source detected in script asset: ${relativePath}`);
  }
  if (REMOTE_WASM_URL_PATTERN.test(source)) {
    fail(`Remote WASM URL detected in script asset: ${relativePath}`);
  }
}

async function validateBuiltAssets(distDir) {
  const files = await listFiles(distDir);
  let hasJsepModule = false;
  let hasJsepWasm = false;
  let hasLocalOrtResolver = false;

  for (const absolutePath of files) {
    const relativePath = normalizePosixPath(path.relative(distDir, absolutePath));
    const extension = path.extname(absolutePath).toLowerCase();

    if (/jsep/i.test(path.basename(absolutePath)) && extension === '.mjs') {
      hasJsepModule = true;
    }
    if (/jsep/i.test(path.basename(absolutePath)) && extension === '.wasm') {
      hasJsepWasm = true;
    }

    if (!['.html', '.js', '.mjs', '.cjs'].includes(extension)) {
      continue;
    }

    const source = await fs.readFile(absolutePath, 'utf8');

    if (extension === '.html') {
      validateHtmlFile(relativePath, source);
      continue;
    }

    validateScriptFile(relativePath, source);
    if (/chrome\.runtime\.getURL\(/.test(source) && source.includes('ort/')) {
      hasLocalOrtResolver = true;
    }
  }

  if (!hasJsepModule) {
    fail('Missing packaged ONNX JSEP module asset (*.jsep*.mjs)');
  }
  if (!hasJsepWasm) {
    fail('Missing packaged ONNX JSEP wasm asset (*.jsep*.wasm)');
  }
  if (!hasLocalOrtResolver) {
    fail('Missing extension-local ORT runtime URL resolver (chrome.runtime.getURL("ort/"))');
  }
  for (const fileName of REQUIRED_ORT_RUNTIME_FILES) {
    if (!(await exists(path.join(distDir, 'ort', fileName)))) {
      fail(`Missing packaged ONNX runtime variant: ort/${fileName}`);
    }
  }
}

export async function verifyPackageDir(distDir) {
  const resolvedDistDir = path.resolve(distDir);
  const manifestPath = path.join(resolvedDistDir, 'manifest.json');

  if (!(await exists(resolvedDistDir))) {
    fail(`Dist directory does not exist: ${resolvedDistDir}`);
  }

  if (!(await exists(manifestPath))) {
    fail(`manifest.json is missing from dist: ${resolvedDistDir}`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  validateManifestShape(manifest);
  validatePermissions(manifest);
  await validateManifestAssetPaths(resolvedDistDir, manifest);
  await validateServiceWorkerGraph(resolvedDistDir, manifest);
  await validateBuiltAssets(resolvedDistDir);

  return {
    distDir: resolvedDistDir,
    manifestVersion: manifest.manifest_version,
    minimumChromeVersion: manifest.minimum_chrome_version,
  };
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const distDir = process.argv[2] ?? 'dist';

  try {
    const result = await verifyPackageDir(distDir);
    process.stdout.write(`Package verification passed for ${result.distDir}\n`);
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
