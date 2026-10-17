# Phone Mirror: iPhone screen on the car lockscreen

Shows your iPhone's screen in the lockscreen's **Phone Mirror** widget, over the iPhone's Personal Hotspot or a shared Wi-Fi. There is no cloud server: the picture goes straight from the phone to the car.

```text
iPhone (ReplayKit broadcast extension, Banyan MJPEG app)
   ↓ screen frames → JPEG, up to 10 fps, 960 px long edge
local HTTP server inside the extension, port 8765
   ↓ MJPEG stream  http://<iPhone>:8765/stream?pin=…
car browser → lockscreen Phone Mirror widget
```

**View only.** No audio, no touch control (iOS gives apps no way to inject touches), and DRM video (Netflix and the like) shows black. The stream is plain, unencrypted HTTP protected only by a PIN: use it on your own hotspot or a trusted Wi-Fi. **Use only while parked.**

## 1. Build the iPhone app (once, on a Mac)

You need a Mac with Xcode 16 or later and an iPhone on iOS 16 or later. A free Apple ID works, but apps it signs stop launching after 7 days and must be run from Xcode again; a paid developer account ($99/year) lasts a year.

1. Open `ios/BanyanMirror.xcodeproj` in Xcode.
2. Select the **BanyanMirror** target and change its **Bundle Identifier** from `com.banyanmirror.ios` to your own, e.g. `com.yourname.banyanmirror`.
3. Select the **BroadcastUpload** target and set its Bundle Identifier to the same plus `.BroadcastUpload`, e.g. `com.yourname.banyanmirror.BroadcastUpload`.
4. In `ios/Shared/MirrorSettings.swift`, set `extensionBundleID` to the identifier from step 3. Change `viewerPIN` to your own six digits too.
5. In **Signing & Capabilities**, for **both** targets, tick *Automatically manage signing* and pick your team.
6. Connect the iPhone, choose it as the run destination with the **BanyanMirror** scheme, and press **Run**. If iOS says the developer is untrusted: Settings › General › VPN & Device Management › trust your Apple ID.

If you add or rename Swift files, run `python3 ios/generate_xcode_project.py` to regenerate the project. If you edit `web/receiver.html`, run `python3 tools/embed_receiver.py` to copy it into the extension.

## 2. Use it in the car

1. Open the **Banyan MJPEG** app. When iOS asks to find devices on your local network, tap **Allow**. The app's first box shows whether access is on; without it the car can't connect.
2. Turn on **Personal Hotspot** and connect the parked car to it (or put both on the same Wi-Fi).
3. In the app, tap the round broadcast button, pick **Banyan MJPEG Broadcast**, then **Start Broadcast**. Switch to any app; the red status pill shows it is sharing.
4. In the car's browser, open **phone mode**: `http://172.20.10.1:8765/?lockscreen=1` on Personal Hotspot (on Wi-Fi, use the address the app lists). That is the iPhone's own page with your whole lockscreen built on top of it, the Phone Mirror widget on and connected. Bookmark it. From the normal lockscreen, the widget's **Start phone mode** button gets you there too, with your settings.

### Why phone mode

The normal lockscreen is a secure (HTTPS) page and the iPhone serves plain HTTP. Browsers block plain-HTTP pictures inside secure pages: newer Chrome allows a local-network address after a permission prompt, while most other browsers, including older car browsers, refuse outright. In phone mode the lockscreen runs on the iPhone's own page, so it and the picture come from the same address: nothing is blocked and there is no prompt. The page takes the lockscreen from the iPhone's copy (`/lockscreen/`, downloaded from this repository's `main`), else downloads it from GitHub itself, else uses the copy it saved last time.

You can still use the widget on the normal lockscreen: turn on **Settings › Show Full Settings › Widget Visibility › Phone Mirror**, tap its gear, and enter the iPhone's address, port `8765` and the PIN. If the browser blocks the picture, press the widget's **Start phone mode**. It brings your settings along: wallpaper, widget positions, clock, notes and the PIN (phone mode prefers a PIN you typed into the iPhone's page). **Normal mode**, top left, goes back. Changes made in phone mode stay in phone mode.

Notes on phone mode:
- It only loads while the broadcast is running, because the server lives in the broadcast extension. An open page keeps working after the broadcast stops, but reloading it won't.
- It still loads without internet once it has been loaded before (the iPhone and the page each keep a copy).
- Offline mode and the rear-seat camera need a secure page, so they don't work in phone mode.
- The widget's settings also have **phone screen** only: the iPhone's bare page, without the lockscreen.

### Widget controls

| Control | What it does |
|---|---|
| <kbd>📱</kbd> button | **Horizontal view**: lays an upright picture on its side, filling a landscape box. Useful when a video or game is sideways while the phone's rotation lock is on. If the phone itself is turned, the picture already arrives in landscape and is shown as it is. |
| Settings › Screen shape | **Smart** (the default) takes the phone's exact shape, follows it when the phone turns, and cuts off black bars: play a widescreen video and the widget becomes the video's shape, with no bars; when the video stops it goes back. **Whole picture** shows everything the phone sends, bars included. Or fix the shape to **iPhone 19.5:9**, **iPhone SE / 8 16:9** or **iPad 4:3**. |
| Settings › Horizontal view | Off, or which way to turn: ↻ clockwise / ↺ counter-clockwise. |
| Settings › Picture | Whole screen, or fill the widget (crops edges). |
| Settings › Stream | Live stream (fastest), or Snapshots for a browser that leaves the live stream black. |
| Resize | Pinch with two fingers, drag the bottom-right corner, or use the size slider. The shape always stays. |
| ⛶ | Fullscreen. |

How Smart finds bars: every 1.5 s the widget reads a small snapshot from the phone and looks for black bands that come in pairs on opposite sides, each at least 7% of the picture. A dark-mode app with black space on one side only is left alone, and the last few snapshots are combined, so a dark scene in a film doesn't cut into the picture. Cropping starts a few seconds after a video starts and ends as soon as it stops. It needs this version of the iPhone app (it reads the snapshot with CORS).

The header hides itself while the picture plays; tap the picture to bring it back. If the broadcast stops, the widget notices within about 8 seconds, says so, and reconnects as soon as the phone is back.

## Try it without an iPhone

`desktop-test/server.py` serves the same protocol from a PC, with an iPhone-shaped moving test picture (Python 3.10+ and Pillow):

```bash
cd desktop-test
python3 -m pip install -r requirements.txt
python3 server.py                     # portrait test picture
python3 server.py --rotate-every 5    # switches portrait/landscape, like turning the phone
python3 server.py --still             # one frame, then nothing: a phone screen that isn't changing
python3 server.py --video-every 8     # switches to a letterboxed 16:9 video, to try Smart cropping
```

It serves the lockscreen at `http://<PC address>:8765/lockscreen/` too (from this repository's working copy when run inside it). Put the PC on the same network as the car and enter the PC's IPv4 address (`ipconfig` on Windows) in the widget. `RUN-DEMO-WINDOWS.bat` and `RUN-DEMO-MAC.command` start it with a double-click. `python3 -m unittest -v test_server` runs the protocol tests.

## Troubleshooting

| Symptom | What to try |
|---|---|
| Xcode won't sign or build | Both targets need the same team, and the extension's identifier must start with the app's. Read Xcode's exact error. |
| No **Banyan MJPEG Broadcast** in the broadcast list | `MirrorSettings.extensionBundleID` must equal the extension's real Bundle Identifier. |
| App shows Local Network as off | iPhone Settings › Privacy & Security › Local Network › Banyan MJPEG. |
| Widget on the normal lockscreen: no picture, or "blocked" | Press **Start phone mode**, or open `http://<address>:8765/?lockscreen=1`. |
| `http://<address>:8765/?lockscreen=1` doesn't load | Is the broadcast running (red pill)? Is the car on the iPhone's hotspot? Is the address right? Try `http://<address>:8765/health` from another device on the same network. The first time, the iPhone needs mobile data to download the lockscreen. |
| Widget: "refused the PIN" | Enter the PIN from the app. |
| Widget connects but stays black | Settings › Stream › Snapshots. |
| Stutters | In `MirrorSettings.swift`, lower `maxLongEdge` (960 → 720), `targetFPS` (10 → 8) or `jpegQuality` (0.60 → 0.45), and rebuild. |
| Picture upside down in horizontal view | Pick the other direction under Settings › Horizontal view. |
| Smart crops something it shouldn't | Settings › Screen shape › Whole picture. |

## Changes from v0.2

- **Last frame on a still screen.** ReplayKit only sends frames when the screen changes. v0.2 dropped frames arriving faster than 10 fps, so the screen's final state often never reached the car. The newest frame is now kept and sent at the next slot.
- **No one-frame lag.** Browsers show an MJPEG frame only when the next boundary arrives. Each frame is now followed straight away by its boundary.
- **Dead connections are freed.** A car that lost Wi-Fi used to hold one of the 4 viewer slots until the next screen change; enough of them locked everyone out. Closed connections are now detected, the last frame is re-sent every 2 s, and a full server drops its oldest viewer instead of refusing new ones.
- **Local Network permission.** The app now asks for it, which iOS needs before the car can connect, and shows its state.
- **Lockscreen support.** CORS headers, local-network preflight answers, a `/alive.gif` the widget uses to notice a stopped broadcast, and `/status` now reports the picture size.
- **JPEG quality option fixed**: it now uses `kCGImageDestinationLossyCompressionQuality`. Intermediate image caching is off to save extension memory.
- **The lockscreen through the phone**: `/lockscreen/` serves the lockscreen itself (downloaded from GitHub, last copy kept), so the widget works in browsers that block plain-HTTP pictures in secure pages.
- **Phone page**: connects on its own when opened from the widget, has the horizontal button, and links back to the lockscreen.

**Not yet tried on a real iPhone or in the car.** The Swift code is syntax-checked only, because iOS frameworks can't be compiled outside a Mac. The protocol, the phone page and the lockscreen widget were tested in Chromium against the desktop simulator. Apple may also limit networking inside broadcast extensions on some iOS versions; if the car can't connect, check Xcode's console for `BanyanMJPEG listener failed`.
