import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  minimum_chrome_version: '116',
  name: 'Smart Dictation AI',
  description: 'Private, local WebGPU voice dictation for approved webpages.',
  version: '0.1.0',
  permissions: ['activeTab', 'offscreen', 'storage', 'unlimitedStorage', 'scripting'],
  host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  action: {
    default_title: 'Smart Dictation AI',
    default_popup: 'src/popup/popup.html',
  },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  },
});
