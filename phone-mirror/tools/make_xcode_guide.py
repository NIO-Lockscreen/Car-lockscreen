#!/usr/bin/env python3
"""Writes XCODE-GUIDE.md: what the iPhone app must contain, how to check it, and the full source of every file.
Meant to be handed to an assistant working in Xcode. Run again after changing any file under ios/."""
import plistlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IOS = ROOT / 'ios'
VERSION = re.search(r'appVersion = "([^"]+)"', (IOS / 'Shared/MirrorSettings.swift').read_text()).group(1)

# (path under ios/, target membership, language for the code block)
FILES = [
    ('Shared/MirrorSettings.swift', 'BanyanMirror **and** BroadcastUpload', 'swift'),
    ('BroadcastUpload/SampleHandler.swift', 'BroadcastUpload', 'swift'),
    ('BroadcastUpload/ReceiverServer.swift', 'BroadcastUpload', 'swift'),
    ('BroadcastUpload/ReceiverHTML.swift', 'BroadcastUpload', 'swift'),
    ('BroadcastUpload/Info.plist', 'BroadcastUpload (its Info.plist)', 'xml'),
    ('BanyanMirror/BanyanMirrorApp.swift', 'BanyanMirror', 'swift'),
    ('BanyanMirror/ContentView.swift', 'BanyanMirror', 'swift'),
    ('BanyanMirror/LocalNetworkPermission.swift', 'BanyanMirror', 'swift'),
    ('BanyanMirror/Info.plist', 'BanyanMirror (its Info.plist)', 'xml'),
]

INTRO = f"""# Banyan MJPEG v{VERSION}: guide for the Xcode project

**For the assistant in Xcode:** make the project match this guide. Every file's full source is at the end. Replace each
file's contents with it exactly, except the values listed under *Keep your own values*. Then run the checks under
*Check it on the phone*. Do not change the behaviour described here: the car lockscreen depends on these exact
addresses, headers and stream format.

## What the app does

```text
iPhone, Banyan MJPEG app
  BroadcastUpload extension (ReplayKit): screen frames -> JPEG (up to 10 fps, 960 px long edge)
  HTTP server inside the extension, port 8765, plain HTTP on the local network
      /stream          MJPEG picture for the lockscreen's Phone Mirror widget
      /                the phone's own page; with ?lockscreen=1 it builds the whole lockscreen on top of itself
      /lockscreen/     the lockscreen, downloaded by the iPhone from GitHub
          |
          v   Personal Hotspot (iPhone = 172.20.10.1) or shared Wi-Fi
car browser: lockscreen -> Phone Mirror widget -> "Start phone mode"
```

The lockscreen is an HTTPS page, and most browsers block a plain-HTTP picture inside it. **Phone mode** gets round
that: the widget's *Start phone mode* button opens the iPhone's own page (`http://<phone>:8765/?lockscreen=1`), which
builds the lockscreen on top of itself, so the picture comes from the same address and nothing blocks it.

## Keep your own values

- The **Bundle Identifier** of both targets (the extension's must be the app's plus `.BroadcastUpload`).
- The **signing team** of both targets.
- In `Shared/MirrorSettings.swift`: **`extensionBundleID`** (must equal the extension's Bundle Identifier) and
  **`viewerPIN`**. Everything else in that file must match the source below.

## Targets and files

| File | Target membership |
|---|---|
""" + ''.join(f'| `{path}` | {target} |\n' for path, target, _ in FILES) + f"""
- Two targets: **BanyanMirror** (iOS app) and **BroadcastUpload** (app extension), deployment target **iOS 16.0**,
  Swift 5. The app embeds the extension ("Embed Foundation Extensions" / "Embed App Extensions" build phase).
- `Shared/MirrorSettings.swift` must be ticked for **both** targets in Target Membership.
- `BanyanMirror/LocalNetworkPermission.swift` (added in v0.4) must be in the **BanyanMirror** target.
- Both Info.plist files: `CFBundleShortVersionString` **{VERSION}.0** (app and extension must match), and
  `NSAppTransportSecurity › NSAllowsLocalNetworking = YES`.
- App Info.plist also needs `NSLocalNetworkUsageDescription`, `NSBonjourServices = [_banyanmirror._tcp]` and
  `UILaunchScreen`. Extension Info.plist needs `NSExtension` with point identifier
  `com.apple.broadcast-services-upload`, principal class `$(PRODUCT_MODULE_NAME).SampleHandler` and
  `RPBroadcastProcessMode = RPBroadcastProcessModeSampleBuffer`.
- `BroadcastUpload/ReceiverHTML.swift` is generated from `web/receiver.html` by `tools/embed_receiver.py`; don't edit
  it by hand.

## Checklist: what each file must do

**`Shared/MirrorSettings.swift`**: `appVersion = "{VERSION}"`, `port 8765`, `viewerPIN`, `maxLongEdge 960`,
`targetFPS 10`, `jpegQuality 0.60`, `extensionBundleID`, `hotspotAddress "172.20.10.1"`,
`bonjourType "_banyanmirror._tcp"`, `lockscreenSource` (this repository's `main` on raw.githubusercontent.com, ending
with `/`).

**`BroadcastUpload/SampleHandler.swift`**
- [ ] `broadcastStarted` starts `ReceiverServer(pin:port:)`.
- [ ] Encodes on its own serial queue. Frames arriving faster than `targetFPS` are not dropped: the newest is kept and
      encoded at the next free slot, so a still screen's final frame is always sent.
- [ ] Turns the picture upright with `RPVideoSampleOrientationKey`, scales to `maxLongEdge`, encodes JPEG with
      `kCGImageDestinationLossyCompressionQuality`; `CIContext` with `.cacheIntermediates: false`.
- [ ] Pause, resume and finish reach the server; finish stops it.

**`BroadcastUpload/ReceiverServer.swift`** (Network.framework `NWListener`, port 8765)

| Request | PIN | Answer |
|---|---|---|
| `GET /` | no | the phone page (`ReceiverHTML.page`), including phone mode |
| `GET /health` | no | `{{"server":"BanyanMJPEG","version":"{VERSION}","listening":true}}` |
| `GET /alive.gif` | no | 1x1 GIF; the widget uses it to notice a stopped broadcast |
| `GET /lockscreen/` (+ `manifest.webmanifest`, `icon-192.png`, `icon-512.png`) | no | downloaded from `lockscreenSource`, last copy kept in Caches; 502 if never downloaded. `/lockscreen` redirects (302) to `/lockscreen/` |
| `GET /status?pin=` | yes | JSON: `live, broadcasting, paused, frames, bytes, width, height, lastFrameAgeMs, viewers, transport, fps` |
| `GET /frame.jpg?pin=` | yes | latest JPEG, or 503 before the first frame |
| `GET /stream?pin=` | yes | `multipart/x-mixed-replace; boundary=banyanframe`; `--banyanframe` right after the headers and again right after every frame |
| `OPTIONS` (any path) | no | 204 with CORS headers and `Access-Control-Allow-Private-Network: true` |
| wrong or missing PIN | | 403 `Wrong PIN` |

- [ ] Every response has `Access-Control-Allow-Origin: *`.
- [ ] At most 4 stream viewers (a 5th makes the oldest go), at most 16 open connections.
- [ ] Viewers that close are removed (watch for end-of-stream); the last frame is re-sent every 2 s.
- [ ] `/status` reports the picture's width and height (read from the JPEG's SOF marker).

**`BroadcastUpload/ReceiverHTML.swift`**: must contain `buildLockscreen` and `LOCKSCREEN_SOURCE`. With
`?lockscreen=1` (or `?upload=true`) the page builds the lockscreen on top of itself: from `/lockscreen/index.html`,
else from GitHub, else from the copy it saved. Otherwise it is the plain phone-screen viewer (PIN form, MJPEG /
snapshots, horizontal button, fit, fullscreen, back link).

**`BanyanMirror/LocalNetworkPermission.swift`**: advertises and browses `_banyanmirror._tcp` with an `NWListener` and
`NWBrowser`, so iOS shows the Local Network prompt from the app (the extension can't). Seeing its own service means
granted; a `waiting` browser means denied.

**`BanyanMirror/ContentView.swift`**: four steps (allow local network, broadcast picker with
`preferredExtension = MirrorSettings.extensionBundleID`, connect the car, phone-mode addresses
`http://<ip>:8765/?lockscreen=1` for each Wi-Fi/hotspot address, PIN), plus a diagnostics button that loads
`http://127.0.0.1:8765/health`.

## Check it on the phone

1. Build and run on the iPhone. Open the app, allow Local Network, start the broadcast, switch to any app.
2. From a computer on the same Wi-Fi, run these (replace `10.0.0.18` with the phone's address from the app and
   `684293` with your PIN; on Windows type `curl.exe` instead of `curl`):

```bash
curl http://10.0.0.18:8765/health
#  -> {{"server":"BanyanMJPEG","version":"{VERSION}","listening":true}}    no "version": an old build is on the phone
curl -s http://10.0.0.18:8765/ | grep -c buildLockscreen
#  -> 1 or more: the phone page has phone mode
curl -s -o /dev/null -w "%{{http_code}}\\n" http://10.0.0.18:8765/lockscreen/
#  -> 200   (502: the iPhone had no internet yet; phone mode then downloads the lockscreen in the browser)
curl -s "http://10.0.0.18:8765/status?pin=684293"
#  -> JSON with "width" and "height"
curl -s -m 3 "http://10.0.0.18:8765/stream?pin=684293" | head -c 80
#  -> starts with --banyanframe, then Content-Type: image/jpeg
curl -si -X OPTIONS http://10.0.0.18:8765/status
#  -> HTTP/1.1 204 ... Access-Control-Allow-Private-Network: true
```

3. In a browser, open `http://10.0.0.18:8765/?lockscreen=1`: the whole lockscreen with the phone live in the Phone
   Mirror widget and a **Normal mode** button top left.

## Using it

- In the car (on the iPhone's hotspot): bookmark `http://172.20.10.1:8765/?lockscreen=1`, or use the normal
  lockscreen's Phone Mirror widget and press **Start phone mode**.
- Phone mode only loads while the broadcast is running (the server lives in the broadcast extension).
- View only: no audio, no touch control, DRM video shows black. Plain HTTP with a PIN: trusted networks only. Use only
  while parked.

## Source files
"""


def main():
    parts = [INTRO]
    for path, target, lang in FILES:
        text = (IOS / path).read_text()
        if lang == 'xml':
            plistlib.loads(text.encode())  # refuse to write a guide with a broken plist
        fence = '````' if '```' in text else '```'
        parts.append(f'\n### `{path}`\n\nTarget: {target}\n\n{fence}{lang}\n{text.rstrip()}\n{fence}\n')
    out = ROOT / 'XCODE-GUIDE.md'
    out.write_text(''.join(parts))
    print('Wrote', out, f'({out.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main()
