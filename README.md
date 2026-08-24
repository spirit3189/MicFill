# Smart Dictation AI

Smart Dictation AI is a Chrome extension for private, on-device voice dictation. It adds a microphone button beside editable fields on approved websites, records your voice, transcribes it with Moonshine, cleans the transcript with S1-mini, and inserts the result back into the field.

Audio and text stay in the browser. The extension does not send recordings or transcripts to an application server.

## Examples

**Input:** i think the answer is forty two no sorry forty three  
**Output:** I think the answer is 43.

**Input:** send it to support at micfill dot com  
**Output:** Send it to support@micfill.com.

S1-mini can also remove filler, resolve spoken corrections, add punctuation, format prose or lists, and adjust the writing style.

## Features

- Local speech recognition and transcript cleanup through WebGPU
- Microphone controls beside text inputs, textareas, and contenteditable fields
- Live recording waveform, timer, Stop, and Cancel controls
- Cleaned dictation or raw-transcript mode
- Casual, semi-casual, semi-formal, and formal writing styles
- Per-site access instead of mandatory access to every website
- Model download and cache progress in the extension popup
- Cached model status and a manual cache-clear control
- Original field content restored when recording is cancelled or processing fails
- One active dictation session across all tabs

## Models

The extension uses two ONNX models:

| Stage | Model | Configuration |
| --- | --- | --- |
| Speech recognition | `onnx-community/moonshine-base-ONNX` | fp32, WebGPU |
| Transcript cleanup | `onnx-community/s1-mini-ONNX` | q4f16, WebGPU |

The first setup downloads the required model files from Hugging Face. The browser stores them in Cache Storage under the extension origin. Later sessions reuse the cached files.

Model downloads are several hundred megabytes. Their exact size can change when a pinned model revision is updated in a future extension release.

## Requirements

- Chrome 116 or newer
- WebGPU support enabled in Chrome
- A compatible GPU and current graphics drivers
- Microphone access
- Internet access for the initial model download

Chrome on mobile does not support extensions.

## Install for development

Install dependencies and build the extension:

```bash
npm install
npm run build
```

Then load it in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the generated `dist` directory.

After rebuilding, click **Reload** on the extension card and refresh any open test pages.

## First-time setup

1. Open the extension popup.
2. Click **Allow microphone**.
3. Complete microphone setup in the extension tab that opens.
4. Return to the website and open the popup again.
5. Click **Enable on this site**.
6. Wait for Moonshine and S1-mini to finish downloading and initializing.

Once setup is complete, microphone buttons appear beside eligible editors without requiring focus or hover.

## Using dictation

1. Click the microphone button beside an editor.
2. The existing field content is cleared when recording begins.
3. Speak naturally.
4. Click **Stop**.
5. Moonshine transcribes the audio locally.
6. In cleaned mode, S1-mini rewrites the transcript using the selected style and context.
7. The result is inserted into the original field.

Cancelling or encountering a processing error restores the previous field content when the field has not been modified elsewhere.

## How it works

The extension is split across three execution contexts:

```text
Web page content script
        ↕
Manifest V3 service worker
        ↕
Offscreen document
  ├─ microphone and AudioWorklet
  ├─ 16 kHz mono resampling
  ├─ Moonshine transcription
  └─ S1-mini cleanup
```

- **Content script:** discovers editors, renders microphone controls, displays recording state, and safely updates fields.
- **Service worker:** creates the offscreen document, routes messages, enforces one active session, and cancels work when a source tab closes or navigates.
- **Offscreen document:** owns microphone capture, Web Audio, WebGPU, model caching, transcription, and cleanup.

Chrome service workers do not provide the window APIs needed by the audio and model pipeline, so inference and recording run in the offscreen document.

## Audio pipeline

The recorder captures mono PCM through an AudioWorklet. When recording stops, audio is resampled to exactly 16,000 Hz with `OfflineAudioContext` before Moonshine receives it. Recordings shorter than 500 milliseconds are rejected, and recording stops automatically after 90 seconds.

## S1-mini request format

The raw transcript is sent to the local S1-mini pipeline as a chat request:

```text
[Styling: semi-formal] [Structure: prose] [Context: general]
<raw transcript>
```

Generation is deterministic. Sampling and model thinking are disabled. The offscreen console logs request metadata such as settings, message roles, input length, and token limits, but does not log transcript content.

## Permissions

The manifest uses the following permissions:

| Permission | Reason |
| --- | --- |
| `activeTab` | Reads the current tab URL after the user opens the extension popup |
| `offscreen` | Hosts microphone capture, Web Audio, and WebGPU processing |
| `storage` | Stores settings, session routing state, and cache metadata |
| `unlimitedStorage` | Reduces the risk of large model files being evicted |
| `scripting` | Installs the content script on websites approved by the user |

Website access is requested per origin. Model network access is restricted to Hugging Face model hosts.

## Privacy

- Recordings are held in memory only for the active dictation session.
- Audio is not uploaded.
- Raw and cleaned transcripts are not saved as history.
- Transcript contents are not written to production logs.
- Model files are cached locally by the browser.
- No telemetry or user accounts are included.

The extension still connects to Hugging Face during initial setup to download model files and metadata.

## Development commands

```bash
npm run dev             # Watch-mode development build
npm run lint            # ESLint
npm run typecheck       # TypeScript validation
npm run test:unit       # Unit tests
npm run test:integration
npm test                # Unit and integration tests
npm run build           # Production build and package verification
npm run verify:package  # Validate an existing dist directory
```

The package verifier checks the manifest, permissions, CSP, referenced assets, local ONNX runtime files, remote-code violations, and service-worker isolation.

## Project structure

```text
src/
  background/   Service-worker routing and lifecycle
  content/      Editor discovery, recorder UI, and insertion
  offscreen/    Audio capture and local model pipelines
  permission/   Persistent microphone-permission onboarding
  popup/        Site setup, settings, model progress, and cache controls
  shared/       Message contracts, validation, settings, and model config
scripts/        Production-package verification
tests/          Unit, integration, and package-policy tests
```

## Troubleshooting

### Microphone permission does not appear

Open the popup and click **Allow microphone**. Complete the request in the persistent extension tab. If Chrome previously blocked the extension, open `chrome://settings/content/microphone`, remove Smart Dictation AI from the blocked list, and retry.

### WebGPU is unavailable

Update Chrome and your graphics drivers. Check `chrome://gpu` to confirm that WebGPU is enabled and hardware accelerated.

### Model setup fails

Open the extension details at `chrome://extensions` and inspect `offscreen.html`. The console reports the failing pipeline stage without including transcript contents.

### Microphone buttons do not appear

Confirm the website is enabled in the popup, reload the page, and check that the target field is not disabled, read-only, or a password field. Chrome internal pages and the Chrome Web Store do not allow content-script injection.

### Clear downloaded models

Open the popup and click **Clear downloaded models**. The next setup will download them again.

## Current limitations

- English dictation is the initial target.
- Only one recording can run at a time.
- Google Docs and closed Shadow DOM editors are not supported.
- Open Shadow DOM discovery is not yet complete.
- A full packaged-Chrome end-to-end test suite is still pending.

## License

Smart Dictation AI is available under the [MIT License](LICENSE).
