# Banyan MJPEG v0.5: guide for the Xcode project

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
| `Shared/MirrorSettings.swift` | BanyanMirror **and** BroadcastUpload |
| `BroadcastUpload/SampleHandler.swift` | BroadcastUpload |
| `BroadcastUpload/ReceiverServer.swift` | BroadcastUpload |
| `BroadcastUpload/ReceiverHTML.swift` | BroadcastUpload |
| `BroadcastUpload/Info.plist` | BroadcastUpload (its Info.plist) |
| `BanyanMirror/BanyanMirrorApp.swift` | BanyanMirror |
| `BanyanMirror/ContentView.swift` | BanyanMirror |
| `BanyanMirror/LocalNetworkPermission.swift` | BanyanMirror |
| `BanyanMirror/Info.plist` | BanyanMirror (its Info.plist) |

- Two targets: **BanyanMirror** (iOS app) and **BroadcastUpload** (app extension), deployment target **iOS 16.0**,
  Swift 5. The app embeds the extension ("Embed Foundation Extensions" / "Embed App Extensions" build phase).
- `Shared/MirrorSettings.swift` must be ticked for **both** targets in Target Membership.
- `BanyanMirror/LocalNetworkPermission.swift` (added in v0.4) must be in the **BanyanMirror** target.
- Both Info.plist files: `CFBundleShortVersionString` **0.5.0** (app and extension must match), and
  `NSAppTransportSecurity › NSAllowsLocalNetworking = YES`.
- App Info.plist also needs `NSLocalNetworkUsageDescription`, `NSBonjourServices = [_banyanmirror._tcp]` and
  `UILaunchScreen`. Extension Info.plist needs `NSExtension` with point identifier
  `com.apple.broadcast-services-upload`, principal class `$(PRODUCT_MODULE_NAME).SampleHandler` and
  `RPBroadcastProcessMode = RPBroadcastProcessModeSampleBuffer`.
- `BroadcastUpload/ReceiverHTML.swift` is generated from `web/receiver.html` by `tools/embed_receiver.py`; don't edit
  it by hand.

## Checklist: what each file must do

**`Shared/MirrorSettings.swift`**: `appVersion = "0.5"`, `port 8765`, `viewerPIN`, `maxLongEdge 960`,
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
| `GET /health` | no | `{"server":"BanyanMJPEG","version":"0.5","listening":true}` |
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
#  -> {"server":"BanyanMJPEG","version":"0.5","listening":true}    no "version": an old build is on the phone
curl -s http://10.0.0.18:8765/ | grep -c buildLockscreen
#  -> 1 or more: the phone page has phone mode
curl -s -o /dev/null -w "%{http_code}\n" http://10.0.0.18:8765/lockscreen/
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

### `Shared/MirrorSettings.swift`

Target: BanyanMirror **and** BroadcastUpload

```swift
import Foundation
import CoreGraphics

/// v0.2 intentionally does not use App Groups, to simplify personal-device signing.
/// This PIN is a demo access check, NOT strong protection: HTTP transmits it unencrypted.
/// Change it before connecting to any network you do not fully control, and enter the same PIN in the
/// lockscreen's Phone widget settings.
enum MirrorSettings {
    /// Reported by http://<phone>:8765/health, to check which build is on the phone.
    static let appVersion = "0.5"
    static let port: UInt16 = 8765
    static let viewerPIN = "684293"
    static let maxLongEdge: CGFloat = 960
    static let targetFPS: Double = 10
    static let jpegQuality: CGFloat = 0.60
    static let extensionBundleID = "com.banyanmirror.ios.BroadcastUpload"
    /// iPhone Personal Hotspot always gives the phone this address.
    static let hotspotAddress = "172.20.10.1"
    /// Advertised and browsed only to make iOS ask for Local Network access. Must be listed in NSBonjourServices.
    static let bonjourType = "_banyanmirror._tcp"
    /// Where the phone fetches the lockscreen it serves at http://<phone>:8765/lockscreen/ (ends with a slash).
    static let lockscreenSource = "https://raw.githubusercontent.com/NIO-Lockscreen/Car-lockscreen/main/"
}
```

### `BroadcastUpload/SampleHandler.swift`

Target: BroadcastUpload

```swift
import Foundation
import ReplayKit
import CoreImage
import CoreMedia
import ImageIO

/// Broadcast Upload extension: screen frames still arrive after the host app backgrounds.
/// MJPEG encoding is bounded to avoid starving the ReplayKit extension process (about 50 MB of memory).
///
/// ReplayKit only delivers a frame when the screen changes. Frames arriving faster than `targetFPS` are not
/// simply dropped: the newest one is kept and encoded at the next free slot, so the car always ends up showing
/// the screen's final state instead of whatever happened to be encoded just before it went still.
final class SampleHandler: RPBroadcastSampleHandler {
    private let encodeQueue = DispatchQueue(label: "banyan.mjpeg.encode", qos: .userInitiated)
    // Intermediates are not cached: the extension's memory budget is small.
    private let context = CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])
    private let colorSpace = CGColorSpaceCreateDeviceRGB()

    // Touched only on encodeQueue.
    private var server: ReceiverServer?
    private var pending: CMSampleBuffer?
    private var encodeScheduled = false
    private var lastEncodeTime: CFAbsoluteTime = 0

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        let receiver = ReceiverServer(pin: MirrorSettings.viewerPIN, port: MirrorSettings.port)
        receiver.start()
        encodeQueue.async { self.server = receiver }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        encodeQueue.async {
            self.pending = sampleBuffer // only the newest frame is kept
            self.scheduleEncode()
        }
    }

    private func scheduleEncode() {
        guard !encodeScheduled, server != nil else { return }
        encodeScheduled = true
        let wait = max(0, lastEncodeTime + 1.0 / MirrorSettings.targetFPS - CFAbsoluteTimeGetCurrent())
        encodeQueue.asyncAfter(deadline: .now() + wait) { [weak self] in self?.encodePending() }
    }

    private func encodePending() {
        encodeScheduled = false
        guard let sampleBuffer = pending, let server = server else { return }
        pending = nil
        lastEncodeTime = CFAbsoluteTimeGetCurrent()
        autoreleasepool {
            if let jpeg = encode(sampleBuffer) { server.publish(jpeg) }
        }
    }

    private func encode(_ sampleBuffer: CMSampleBuffer) -> Data? {
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
        var image = CIImage(cvPixelBuffer: buffer)
        // ReplayKit hands over portrait buffers plus an orientation tag; turn the picture upright, so a phone held
        // sideways produces a landscape frame. The car widget sizes itself from the frame's own shape.
        if let orientation = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let mapped = CGImagePropertyOrientation(rawValue: orientation.uint32Value) {
            image = image.oriented(mapped)
        }
        image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
        let bounds = image.extent
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let scale = min(1.0, MirrorSettings.maxLongEdge / max(bounds.width, bounds.height))
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let options: [CIImageRepresentationOption: Any] = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: MirrorSettings.jpegQuality]
        return context.jpegRepresentation(of: scaled, colorSpace: colorSpace, options: options)
    }

    override func broadcastPaused() { encodeQueue.async { self.server?.setPaused(true) } }
    override func broadcastResumed() { encodeQueue.async { self.server?.setPaused(false) } }
    override func broadcastFinished() {
        encodeQueue.sync {
            pending = nil
            server?.stop()
            server = nil
        }
    }
}
```

### `BroadcastUpload/ReceiverServer.swift`

Target: BroadcastUpload

```swift
import Foundation
import CoreGraphics
import Network

/// Minimal *local* HTTP + multipart/x-mixed-replace server.
/// Frames are pushed as soon as they're ready. Each viewer has <=1 outstanding send:
/// slow receivers drop stale frames instead of making capture latency accumulate.
///
/// Every frame is followed straight away by the next boundary line. Browsers only show a multipart part once they
/// see the boundary after it, so without this the picture would lag one frame behind and a still screen would never
/// show its last frame.
///
/// Responses carry CORS headers (and answer local-network preflights) so the car lockscreen, an HTTPS page, can
/// read /status with fetch() once the browser has been allowed to reach the local network.
final class ReceiverServer {
    private let queue = DispatchQueue(label: "banyan.mjpeg.network", qos: .userInitiated)
    private var listener: NWListener?
    private var heartbeat: DispatchSourceTimer?
    private var latestJPEG: Data?
    private var latestSize = CGSize.zero
    private var frameSequence = 0
    private var publishedAt = Date.distantPast
    private var isPaused = false
    private let pin: String
    private let port: UInt16
    private var viewers: [UUID: Viewer] = [:]
    private var openConnections = 0
    private let boundary = "banyanframe"
    private let maxViewers = 4
    private let maxConnections = 16
    /// A still screen produces no frames; the latest one is re-sent this often so viewers that vanished
    /// (Wi-Fi dropped, page reloaded) are noticed and freed.
    private let heartbeatInterval: TimeInterval = 2

    private final class Viewer {
        let id: UUID
        let connection: NWConnection
        let joined = Date()
        var sending = false
        var sentSequence = -1
        var lastSend = Date.distantPast
        init(id: UUID, connection: NWConnection) { self.id = id; self.connection = connection }
    }

    init(pin: String, port: UInt16) { self.pin = pin; self.port = port }

    func start() {
        queue.async { [weak self] in
            guard let self = self, let endpoint = NWEndpoint.Port(rawValue: self.port) else { return }
            do {
                let tcp = NWParameters.tcp
                tcp.allowLocalEndpointReuse = true // a quick stop/start must not fail with "address in use"
                let listener = try NWListener(using: tcp, on: endpoint)
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .failed(let error): NSLog("BanyanMJPEG listener failed: %@", "\(error)")
                    case .ready: NSLog("BanyanMJPEG ready on port %u", self.port)
                    default: break
                    }
                }
                listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
                self.listener = listener
                listener.start(queue: self.queue)
                self.startHeartbeat()
            } catch { NSLog("BanyanMJPEG listener error: %@", "\(error)") }
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.heartbeat?.cancel()
            self.heartbeat = nil
            self.listener?.cancel()
            self.listener = nil
            for client in self.viewers.values { client.connection.cancel() }
            self.viewers.removeAll()
        }
    }
    func setPaused(_ paused: Bool) { queue.async { [weak self] in self?.isPaused = paused } }
    func publish(_ jpeg: Data) {
        queue.async { [weak self] in
            guard let self = self, !self.isPaused else { return }
            self.latestJPEG = jpeg
            self.latestSize = ReceiverServer.jpegSize(jpeg) ?? self.latestSize
            self.frameSequence += 1
            self.publishedAt = Date()
            for viewer in self.viewers.values { self.sendNextFrame(to: viewer) }
        }
    }

    private func startHeartbeat() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + heartbeatInterval, repeating: heartbeatInterval)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            let now = Date()
            for viewer in self.viewers.values where now.timeIntervalSince(viewer.lastSend) >= self.heartbeatInterval {
                self.sendNextFrame(to: viewer, force: true)
            }
        }
        timer.resume()
        heartbeat = timer
    }

    private func accept(_ connection: NWConnection) {
        // Bound simultaneous connections: avoid consuming the extension's memory.
        guard openConnections < maxConnections else { connection.cancel(); return }
        openConnections += 1
        var counted = true
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            switch state {
            case .failed, .cancelled:
                if case .failed = state { connection?.cancel() } // a failed connection keeps its resources until cancelled
                guard let self = self, counted else { return }
                counted = false
                self.openConnections -= 1
                if let connection = connection { self.viewers = self.viewers.filter { $0.value.connection !== connection } }
            default: break
            }
        }
        connection.start(queue: queue)
        readRequest(connection, bytes: Data())
    }
    private func readRequest(_ conn: NWConnection, bytes: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, finished, error in
            guard let self = self else { conn.cancel(); return }
            var received = bytes
            if let data = data { received.append(data) }
            guard received.count < 8192, error == nil else { conn.cancel(); return }
            if let raw = String(data: received, encoding: .utf8), raw.contains("\r\n\r\n") {
                self.respond(conn, line: raw.components(separatedBy: "\r\n")[0])
            } else if finished { conn.cancel() }
            else { self.readRequest(conn, bytes: received) }
        }
    }
    private func respond(_ conn: NWConnection, line: String) {
        let parts = line.split(separator: " ")
        guard parts.count >= 2 else { sendOnce(conn, code: 400, mime: "text/plain", body: Data()); return }
        if parts[0] == "OPTIONS" { sendPreflight(conn); return }
        guard parts[0] == "GET" else {
            sendOnce(conn, code: 405, mime: "text/plain", body: Data("Only GET is supported".utf8)); return
        }
        let target = String(parts[1])
        guard let path = URLComponents(string: "http://localhost\(target)") else {
            sendOnce(conn, code: 400, mime: "text/plain", body: Data()); return
        }
        if path.path == "/" || path.path == "/index.html" {
            sendOnce(conn, code: 200, mime: "text/html; charset=utf-8", body: Data(ReceiverHTML.page.utf8)); return
        }
        if path.path == "/health" {
            sendOnce(conn, code: 200, mime: "application/json", body: Data("{\"server\":\"BanyanMJPEG\",\"version\":\"\(MirrorSettings.appVersion)\",\"listening\":true}".utf8)); return
        }
        if path.path == "/alive.gif" {
            // An <img> can load this where fetch() is not allowed: the lockscreen uses it to notice a stopped broadcast.
            sendOnce(conn, code: 200, mime: "image/gif", body: ReceiverServer.pixelGIF); return
        }
        if path.path == "/lockscreen" { sendRedirect(conn, to: "/lockscreen/"); return }
        if path.path.hasPrefix("/lockscreen/") { serveLockscreen(conn, file: String(path.path.dropFirst("/lockscreen/".count))); return }
        let token = path.queryItems?.first(where: { $0.name == "pin" })?.value
        guard token == pin else {
            sendOnce(conn, code: 403, mime: "text/plain", body: Data("Wrong PIN".utf8)); return
        }
        switch path.path {
        case "/status":
            let hasFrame = latestJPEG != nil
            let state: [String: Any] = ["live": hasFrame && !isPaused, "broadcasting": true, "paused": isPaused,
                                        "frames": frameSequence, "bytes": latestJPEG?.count ?? 0,
                                        "width": Int(latestSize.width), "height": Int(latestSize.height),
                                        "lastFrameAgeMs": hasFrame ? Int(Date().timeIntervalSince(publishedAt) * 1000) : -1,
                                        "viewers": viewers.count, "transport": "MJPEG", "fps": MirrorSettings.targetFPS]
            let body = (try? JSONSerialization.data(withJSONObject: state, options: [])) ?? Data("{}".utf8)
            sendOnce(conn, code: 200, mime: "application/json", body: body)
        case "/frame.jpg":
            if let image = latestJPEG { sendOnce(conn, code: 200, mime: "image/jpeg", body: image) }
            else { sendOnce(conn, code: 503, mime: "text/plain", body: Data("Waiting for capture".utf8)) }
        case "/stream":
            startStream(conn)
        default:
            sendOnce(conn, code: 404, mime: "text/plain", body: Data("Not found".utf8))
        }
    }
    private func startStream(_ conn: NWConnection) {
        // Full: make room by dropping the oldest viewer, so a car that reconnected after losing Wi-Fi is never locked out.
        if viewers.count >= maxViewers, let oldest = viewers.values.min(by: { $0.joined < $1.joined }) {
            viewers.removeValue(forKey: oldest.id)
            oldest.connection.cancel()
        }
        let header = "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=\(boundary)\r\nCache-Control: no-store, no-cache, must-revalidate\r\nPragma: no-cache\r\nAccess-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n--\(boundary)\r\n"
        let viewer = Viewer(id: UUID(), connection: conn)
        conn.send(content: Data(header.utf8), completion: .contentProcessed { [weak self] error in
            guard let self = self else { conn.cancel(); return }
            if error != nil { conn.cancel(); return }
            self.queue.async {
                guard case .ready = conn.state else { return }
                self.viewers[viewer.id] = viewer
                self.watchForClose(viewer)
                self.sendNextFrame(to: viewer)
            }
        })
    }
    /// The viewer never sends anything after its request, so data or end-of-stream here means it has gone away.
    private func watchForClose(_ viewer: Viewer) {
        viewer.connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] _, _, finished, error in
            guard let self = self else { return }
            self.queue.async {
                if finished || error != nil {
                    self.viewers.removeValue(forKey: viewer.id)
                    viewer.connection.cancel()
                } else if self.viewers[viewer.id] != nil {
                    self.watchForClose(viewer)
                }
            }
        }
    }
    private func sendNextFrame(to viewer: Viewer, force: Bool = false) {
        guard !viewer.sending, let image = latestJPEG, force || viewer.sentSequence != frameSequence else { return }
        viewer.sending = true
        viewer.lastSend = Date()
        // Send the newest frame, not every intermediate frame. This prevents backlog.
        let frameNumber = frameSequence
        var packet = Data("Content-Type: image/jpeg\r\nContent-Length: \(image.count)\r\n\r\n".utf8)
        packet.append(image)
        packet.append(Data("\r\n--\(boundary)\r\n".utf8))
        viewer.connection.send(content: packet, completion: .contentProcessed { [weak self] error in
            guard let self = self else { viewer.connection.cancel(); return }
            self.queue.async {
                if error != nil {
                    self.viewers.removeValue(forKey: viewer.id)
                    viewer.connection.cancel()
                    return
                }
                guard self.viewers[viewer.id] != nil else { return }
                viewer.sending = false
                viewer.sentSequence = frameNumber
                self.sendNextFrame(to: viewer)
            }
        })
    }
    private func sendPreflight(_ conn: NWConnection) {
        let head = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, OPTIONS\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in conn.cancel() })
    }
    private func sendRedirect(_ conn: NWConnection, to location: String) {
        let head = "HTTP/1.1 302 Found\r\nLocation: \(location)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in conn.cancel() })
    }
    private func sendOnce(_ conn: NWConnection, code: Int, mime: String, body: Data) {
        let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 502: "Bad Gateway", 503: "Service Unavailable"][code] ?? "Error"
        let head = "HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(body)
        conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
    }

    // MARK: The lockscreen, served through the phone

    /// Many car browsers won't show this server's plain-HTTP stream inside the HTTPS lockscreen. Loaded from here instead
    /// (http://<phone>:8765/lockscreen/), the lockscreen and the stream share one origin and the Phone Mirror widget works
    /// in any browser. The files are fetched from `MirrorSettings.lockscreenSource`; the last good copy is kept on disk
    /// for when the phone has no signal.
    private static let lockscreenFiles: [String: String] = [
        "index.html": "text/html; charset=utf-8",
        "manifest.webmanifest": "application/manifest+json",
        "icon-192.png": "image/png",
        "icon-512.png": "image/png",
    ]
    private static let lockscreenCache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent("lockscreen", isDirectory: true)

    private func serveLockscreen(_ conn: NWConnection, file requested: String) {
        let file = requested.isEmpty ? "index.html" : requested
        guard let mime = ReceiverServer.lockscreenFiles[file], let source = URL(string: MirrorSettings.lockscreenSource + file) else {
            sendOnce(conn, code: 404, mime: "text/plain", body: Data("Not found".utf8)); return
        }
        let saved = ReceiverServer.lockscreenCache?.appendingPathComponent(file)
        let request = URLRequest(url: source, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 6)
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            var body: Data?
            if let data = data, (response as? HTTPURLResponse)?.statusCode == 200 {
                body = data
                if let saved = saved {
                    try? FileManager.default.createDirectory(at: saved.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? data.write(to: saved, options: .atomic)
                }
            } else if let saved = saved {
                body = try? Data(contentsOf: saved)
            }
            guard let self = self else { conn.cancel(); return }
            self.queue.async {
                if let body = body { self.sendOnce(conn, code: 200, mime: mime, body: body) }
                else { self.sendOnce(conn, code: 502, mime: "text/plain; charset=utf-8", body: Data("The iPhone couldn't download the lockscreen. It needs mobile data the first time.".utf8)) }
            }
        }.resume()
    }

    private static let pixelGIF = Data(base64Encoded: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==") ?? Data()

    /// Width and height from a JPEG's start-of-frame marker, so /status can report the picture's shape.
    private static func jpegSize(_ data: Data) -> CGSize? {
        let bytes = [UInt8](data.prefix(65536))
        var i = 2
        while i + 9 < bytes.count {
            guard bytes[i] == 0xFF else { return nil }
            let marker = bytes[i + 1]
            let length = Int(bytes[i + 2]) << 8 | Int(bytes[i + 3])
            if (0xC0...0xCF).contains(marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                let height = Int(bytes[i + 5]) << 8 | Int(bytes[i + 6])
                let width = Int(bytes[i + 7]) << 8 | Int(bytes[i + 8])
                return CGSize(width: width, height: height)
            }
            i += 2 + length
        }
        return nil
    }
}
```

### `BroadcastUpload/ReceiverHTML.swift`

Target: BroadcastUpload

```swift
import Foundation

enum ReceiverHTML {
    static let page = #"""
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#080e17">
<title>Banyan MJPEG</title>
<!-- Served by the iPhone itself, over plain HTTP. This page is the fallback for car browsers that will not show
     the stream inside the HTTPS lockscreen. Opened from the lockscreen widget it receives ?pin=, ?rot= and ?back=,
     connects on its own and offers a button back to the lockscreen. -->
<style>
:root { --bg: #080d14; --ink: #f1f8ff; --muted: #97afc2; --mint: #69f2c3; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; width: 100%; overflow: hidden; background: var(--bg); color: var(--ink); font: 14px system-ui, -apple-system, Arial, sans-serif; }
button, a.btn { border: 1px solid #354e61; background: #1d3445; color: var(--ink); border-radius: 10px; padding: 10px 14px; font-size: 13px; touch-action: manipulation; text-decoration: none; white-space: nowrap; }
button:active, a.btn:active { background: #286459; }
button.selected { border-color: var(--mint); background: #1c4b48; }
#stage { position: absolute; inset: 0; background: #030608; overflow: hidden; }
#screen { display: none; position: absolute; left: 50%; top: 50%; width: 100%; height: 100%; object-fit: contain; transform: translate(-50%, -50%); }
#waiting { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 30px; color: #aebdcf; line-height: 1.8; }
#waiting b { display: block; color: #fafcff; font-size: 26px; letter-spacing: .1em; }
#hud { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; z-index: 4; padding: 10px 13px; background: linear-gradient(#0d1d2bf5, #0d1d2be9, #0d1d2b00); transition: opacity .2s; }
.brand { white-space: nowrap; font-weight: 800; letter-spacing: .08em; font-size: 13px; }
.brand span { color: var(--mint); }
#stats { flex: 1; font-size: 12px; color: #9eb9c4; white-space: nowrap; text-align: right; overflow: hidden; text-overflow: ellipsis; }
#hud button, #hud a.btn { padding: 8px 9px; }
#hud.hidden { opacity: 0; pointer-events: none; }
#unhide { display: none; position: absolute; top: 0; left: 48%; width: 50px; height: 13px; border-radius: 0 0 8px 8px; background: #3b5d69bb; z-index: 5; padding: 0; border: 0; }
#hud.hidden + #unhide { display: block; }
#pair { position: absolute; z-index: 8; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(94vw, 410px); padding: 26px; background: linear-gradient(145deg, #172d40, #0a1420); border: 1px solid #375263; border-radius: 21px; box-shadow: 0 25px 100px #000b; }
#pair h1 { font-size: 26px; line-height: 1.1; margin: 0 0 8px; }
#pair h1 span { color: var(--mint); }
#pair p { color: var(--muted); line-height: 1.6; }
#pair form { display: flex; gap: 10px; margin-top: 18px; }
#pin { min-width: 0; width: 100%; padding: 12px; background: #050e18; color: white; border: 1px solid #466170; border-radius: 9px; font-size: 24px; letter-spacing: .23em; font-family: monospace; }
#pair button { background: #55ddb2; border: 0; color: #062619; font-weight: 800; }
#error { color: #ffa8a8; min-height: 16px; font-size: 12px; margin-top: 10px; }
#foot { position: absolute; bottom: 10px; left: 13px; font-size: 11px; color: #8c99a5aa; z-index: 2; }
@media (max-width: 760px) { #hud { gap: 4px; padding: 5px; } .brand { display: none; } #stats { display: none; } #hud button, #hud a.btn { font-size: 11px; padding: 7px; } }
</style>
</head>
<body>
<div id="stage"><img id="screen" alt="Live phone screen"><div id="waiting"><b>BANYAN / MIRROR</b>Waiting for your iPhone broadcast.<br>Keep the car parked.</div></div>
<div id="hud">
    <a id="back" class="btn" href="#">&#9664; Lockscreen</a>
    <div class="brand">BANYAN <span>MJPEG</span></div>
    <div id="stats">Connect using your PIN</div>
    <button id="mode">MJPEG</button>
    <button id="rotate">Horizontal: off</button>
    <button id="fit">Fit</button>
    <button id="fullscreen">Fullscreen</button>
    <button id="hide">Hide</button>
</div><button id="unhide" title="Show controls">&#9660;</button>
<div id="foot">Local stream · View only · Do not use while driving</div>
<div id="pair"><h1>Local <span>screen mirror</span></h1><p>Enter the PIN shown in the iPhone Banyan MJPEG app. The screen travels directly over your private Wi-Fi, without any cloud server.</p><form id="pairform"><input id="pin" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="6-digit PIN" autocomplete="off" required><button>Connect</button></form><div id="error"></div></div>
<script>
(function () {
    'use strict';
    var LOCKSCREEN_URL = 'https://car-lockscreen.vercel.app/';
    var ROTATIONS = [0, 90, 270]; // off, horizontal turned clockwise, horizontal turned counter-clockwise
    var $ = function (id) { return document.getElementById(id); };
    var screen = $('screen'), stage = $('stage'), waiting = $('waiting'), stats = $('stats'), pair = $('pair'), error = $('error');
    var params = new URLSearchParams(location.search);
    var store = {
        get: function (k) { try { return localStorage.getItem('banyan_' + k); } catch (e) { return null; } },
        set: function (k, v) { try { localStorage.setItem('banyan_' + k, v); } catch (e) { /* storage unavailable */ } }
    };

    // Phone mode (?lockscreen=1, sent by the lockscreen's Phone Mirror widget): the whole lockscreen is built on top of this
    // page. Its widget then shares this page's origin, so no browser can block the picture. The lockscreen comes from the
    // iPhone's own copy, else straight from GitHub, else the copy saved here last time. A QR upload link from phone mode
    // (?upload=true) lands here too and needs the lockscreen's upload page.
    var LOCKSCREEN_SOURCE = 'https://raw.githubusercontent.com/NIO-Lockscreen/Car-lockscreen/main/index.html';
    if (params.get('lockscreen') === '1' || params.get('upload') === 'true') {
        buildLockscreen();
        return; // nothing of this page may keep running underneath
    }
    function buildLockscreen() {
        pair.style.display = 'none';
        $('hud').style.display = 'none';
        waiting.innerHTML = '<b>BANYAN / MIRROR</b>Loading your lockscreen…';
        var sources = ['/lockscreen/index.html', LOCKSCREEN_SOURCE];
        var build = function (html, fresh) {
            if (!html) {
                waiting.innerHTML = '<b>BANYAN / MIRROR</b>Couldn’t load the lockscreen: the car or the iPhone needs internet the first time.';
                return;
            }
            if (fresh) store.set('lockscreen', html);
            document.open();
            document.write(html);
            document.close();
        };
        var next = function () {
            var src = sources.shift();
            if (!src) { build(store.get('lockscreen'), false); return; }
            fetch(src, { cache: 'no-store' })
                .then(function (r) { return r.ok ? r.text() : null; })
                .then(function (html) { if (html && html.indexOf('id="lock-screen"') >= 0) build(html, true); else next(); })
                .catch(function () { next(); });
        };
        next();
    }

    var pin = '', mode = 'mjpeg', fill = false, connected = false, lastSeq = 0, lastStatTime = 0, pollTimer = 0, statsTimer = 0, mjpegCheck = 0;
    var rotation = parseInt(params.get('rot') || store.get('rot') || '0', 10);
    if (ROTATIONS.indexOf(rotation) < 0) rotation = 0;

    var back = params.get('back');
    $('back').href = back && /^https?:\/\//i.test(back) ? back : LOCKSCREEN_URL;

    function makeURL(path) { return path + '?pin=' + encodeURIComponent(pin) + '&t=' + Date.now(); }
    function showFrame() { screen.style.display = 'block'; waiting.style.display = 'none'; layout(); }
    function showWait() { screen.style.display = 'none'; waiting.style.display = 'flex'; }

    // "Horizontal" turns a portrait frame on its side to fill a landscape screen. A frame that is already
    // landscape (the phone itself was turned) is shown as it comes.
    function layout() {
        var portrait = screen.naturalHeight > screen.naturalWidth;
        var turn = portrait ? rotation : 0;
        var w = stage.clientWidth, h = stage.clientHeight;
        var sideways = turn === 90 || turn === 270;
        screen.style.width = (sideways ? h : w) + 'px';
        screen.style.height = (sideways ? w : h) + 'px';
        screen.style.transform = 'translate(-50%, -50%) rotate(' + turn + 'deg)';
    }
    function syncRotateButton() {
        $('rotate').textContent = 'Horizontal: ' + (rotation === 0 ? 'off' : rotation === 90 ? '↻' : '↺');
        $('rotate').classList.toggle('selected', rotation !== 0);
    }

    function setMode(next) {
        mode = next;
        $('mode').textContent = mode === 'mjpeg' ? 'MJPEG' : 'JPEG snapshots';
        clearTimeout(pollTimer); clearInterval(mjpegCheck);
        screen.onload = null; screen.onerror = null; screen.removeAttribute('src'); showWait();
        if (!connected) return;
        if (mode === 'mjpeg') {
            screen.onerror = function () { stats.textContent = 'Stream interrupted, try JPEG snapshots'; };
            screen.onload = showFrame;
            screen.src = makeURL('/stream');
            // Some Chromium builds never fire onload for an endless MJPEG stream: watch the picture size instead,
            // which also follows the phone turning between portrait and landscape.
            var lastShape = '';
            mjpegCheck = setInterval(function () {
                var shape = screen.naturalWidth + 'x' + screen.naturalHeight;
                if (screen.naturalWidth && shape !== lastShape) { lastShape = shape; showFrame(); }
            }, 500);
        } else {
            pollFrame();
        }
    }
    function pollFrame() {
        if (!connected || mode !== 'jpeg') return;
        screen.onload = function () { showFrame(); pollTimer = setTimeout(pollFrame, 65); };
        screen.onerror = function () { stats.textContent = 'Waiting for JPEG frame'; pollTimer = setTimeout(pollFrame, 500); };
        screen.src = makeURL('/frame.jpg');
    }
    function refreshStatus() {
        if (!connected) return;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', makeURL('/status'), true);
        xhr.timeout = 2600;
        xhr.onload = function () {
            if (xhr.status === 403) { disconnect('Incorrect PIN'); return; }
            if (xhr.status !== 200) return;
            try {
                var s = JSON.parse(xhr.responseText);
                var now = Date.now();
                var measured = (lastStatTime && now > lastStatTime) ? Math.round((s.frames - lastSeq) * 1000 / (now - lastStatTime)) : 0;
                lastSeq = s.frames; lastStatTime = now;
                if (!s.live) stats.textContent = s.paused ? 'Broadcast paused on the iPhone' : 'Waiting for screen broadcast…';
                else stats.textContent = 'LIVE · ' + measured + ' fps' + (measured === 0 ? ' (screen still)' : '') + ' · ' + Math.round(s.bytes / 1024) + ' KB/frame · ' + mode.toUpperCase();
            } catch (e) { /* ignore a garbled status */ }
        };
        xhr.onerror = function () { stats.textContent = 'Connection lost, check Wi-Fi'; };
        xhr.send();
    }
    function disconnect(message) {
        connected = false;
        clearInterval(statsTimer); clearTimeout(pollTimer); clearInterval(mjpegCheck);
        screen.removeAttribute('src'); showWait();
        pair.style.display = 'block'; error.textContent = message;
    }
    function connect(value) {
        pin = value; store.set('pin', value);
        error.textContent = ''; connected = true; lastStatTime = 0; lastSeq = 0;
        pair.style.display = 'none';
        setMode(mode); refreshStatus();
        statsTimer = setInterval(refreshStatus, 1800);
    }

    $('pairform').onsubmit = function (e) {
        e.preventDefault();
        var entered = $('pin').value.trim();
        if (!/^\d{6}$/.test(entered)) { error.textContent = 'Enter exactly six digits'; return; }
        connect(entered);
    };
    $('mode').onclick = function () { setMode(mode === 'mjpeg' ? 'jpeg' : 'mjpeg'); };
    $('rotate').onclick = function () {
        rotation = ROTATIONS[(ROTATIONS.indexOf(rotation) + 1) % ROTATIONS.length];
        store.set('rot', String(rotation)); syncRotateButton(); layout();
    };
    $('fit').onclick = function () { fill = !fill; screen.style.objectFit = fill ? 'cover' : 'contain'; this.textContent = fill ? 'Fill' : 'Fit'; };
    $('fullscreen').onclick = function () {
        try {
            if (document.fullscreenElement) document.exitFullscreen();
            else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
        } catch (e) { /* not supported */ }
    };
    $('hide').onclick = function () { $('hud').classList.add('hidden'); };
    $('unhide').onclick = function () { $('hud').classList.remove('hidden'); };
    window.addEventListener('resize', layout);
    syncRotateButton();

    var startPin = params.get('pin') || store.get('pin');
    if (startPin && /^\d{6}$/.test(startPin)) { $('pin').value = startPin; connect(startPin); }
})();
</script>
</body>
</html>

"""#
}
```

### `BroadcastUpload/Info.plist`

Target: BroadcastUpload (its Info.plist)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsLocalNetworking</key><true/></dict>
	<key>CFBundleDisplayName</key>
	<string>Banyan MJPEG Broadcast</string>
	<key>NSLocalNetworkUsageDescription</key>
	<string>Stream captured frames to a trusted NIO browser on your local network.</string>
	<key>NSExtension</key>
	<dict>
		<key>NSExtensionPointIdentifier</key>
		<string>com.apple.broadcast-services-upload</string>
		<key>NSExtensionPrincipalClass</key>
		<string>$(PRODUCT_MODULE_NAME).SampleHandler</string>
		<key>RPBroadcastProcessMode</key>
		<string>RPBroadcastProcessModeSampleBuffer</string>
	</dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundlePackageType</key>
	<string>XPC!</string>
	<key>CFBundleShortVersionString</key>
	<string>0.5.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleSupportedPlatforms</key>
	<array>
		<string>iPhoneOS</string>
	</array>
</dict>
</plist>
```

### `BanyanMirror/BanyanMirrorApp.swift`

Target: BanyanMirror

```swift
import SwiftUI

@main
struct BanyanMirrorApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

### `BanyanMirror/ContentView.swift`

Target: BanyanMirror

```swift
import SwiftUI
import UIKit
import ReplayKit
import Darwin

struct ContentView: View {
    @StateObject private var permission = LocalNetworkPermission()
    @State private var refreshCount = 0
    @State private var serverResult = "Not checked"
    private var addresses: [InterfaceAddress] { LocalNetwork.addresses() }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("BANYAN / MIRROR").font(.system(.largeTitle, design: .rounded).bold())
                        Text("Fast local MJPEG for NIO ET5 · v\(MirrorSettings.appVersion)").foregroundStyle(.secondary)
                    }
                    GroupBox("1 · Allow local network") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(permissionText).font(.subheadline)
                            HStack {
                                Button("Check again") { permission.request() }.buttonStyle(.bordered)
                                if permission.status == .denied {
                                    Button("Open Settings") {
                                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                                    }.buttonStyle(.borderedProminent)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GroupBox("2 · Start on iPhone") {
                        HStack(alignment: .center, spacing: 16) {
                            BroadcastPicker().frame(width: 72, height: 72)
                            Text("Tap the broadcast button, select **Banyan MJPEG Broadcast**, and confirm **Start Broadcast**. Then switch to any app.")
                                .font(.subheadline)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GroupBox("3 · Connect the parked NIO") {
                        Text("Connect the car to your iPhone's Personal Hotspot, or join both to the same trusted Wi-Fi.")
                            .font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    GroupBox("4 · Show it on the car screen") {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("In the car's browser, open your lockscreen through the iPhone. The Phone Mirror widget is on and connected there, and no browser can block it. Use the address of the network the car is on:")
                                .font(.subheadline)
                            if addresses.isEmpty { Text("No active Wi-Fi / hotspot address found.").foregroundStyle(.orange) }
                            ForEach(addresses) { addr in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("\(addr.name) · \(addr.label)").font(.caption).foregroundStyle(.secondary)
                                    Text(verbatim: "http://\(addr.ip):\(MirrorSettings.port)/?lockscreen=1")
                                        .font(.system(.subheadline, design: .monospaced))
                                        .textSelection(.enabled)
                                }
                            }
                            Text("Or, in the normal lockscreen, turn on **Phone Mirror** (Settings › Show Full Settings › Widget Visibility), enter one of these addresses and the PIN in its settings, and tap **Start phone mode** if the picture is blocked.")
                                .font(.caption).foregroundStyle(.secondary)
                            Button("Refresh IP addresses") { refreshCount += 1 }
                                .buttonStyle(.bordered)
                            Text("PIN")
                                .font(.caption.bold()).foregroundStyle(.secondary)
                            Text(MirrorSettings.viewerPIN)
                                .font(.system(size: 38, weight: .bold, design: .monospaced))
                                .foregroundStyle(.mint)
                                .textSelection(.enabled)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }.id(refreshCount)
                    GroupBox("Diagnostics") {
                        VStack(alignment: .leading, spacing: 8) {
                            Button("Test local stream server") { pingLocalServer() }
                                .buttonStyle(.borderedProminent)
                            Text(serverResult).font(.caption.monospaced())
                            Text("Start broadcasting first. Success here confirms the server listens inside the extension; you must still test Wi-Fi reachability from the car.")
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("No touch-through, audio or DRM capture. Shares the whole iPhone screen on a private unencrypted HTTP connection. Stop the broadcast when finished. Park for all tests.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(20)
            }.navigationBarHidden(true).preferredColorScheme(.dark)
        }
        .onAppear { permission.request() }
    }

    private var permissionText: String {
        switch permission.status {
        case .granted: return "Local Network access is on. The car can reach the stream."
        case .denied: return "Local Network access is off, so the car cannot connect. Turn it on in Settings › Privacy & Security › Local Network › Banyan MJPEG."
        case .checking: return "Checking… If iOS asks to find devices on your local network, tap Allow."
        case .unknown: return "Not confirmed yet. Tap Check again, and Allow if iOS asks."
        }
    }

    private func pingLocalServer() {
        guard let url = URL(string: "http://127.0.0.1:\(MirrorSettings.port)/health") else { return }
        serverResult = "Checking…"
        URLSession.shared.dataTask(with: url) { _, response, error in
            let success = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                serverResult = success ? "Server ready on port \(MirrorSettings.port)" :
                  "Unreachable: \(error?.localizedDescription ?? "HTTP request failed")"
            }
        }.resume()
    }
}

struct BroadcastPicker: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let control = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 72, height: 72))
        control.preferredExtension = MirrorSettings.extensionBundleID
        control.showsMicrophoneButton = false
        return control
    }
    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

struct InterfaceAddress: Identifiable {
    let name: String
    let ip: String
    var id: String { name + ":" + ip }
    /// en0 is Wi-Fi; bridge interfaces carry Personal Hotspot clients.
    var label: String {
        if ip == MirrorSettings.hotspotAddress || name.hasPrefix("bridge") { return "Personal Hotspot" }
        if name == "en0" { return "Wi-Fi" }
        return "Other network"
    }
}

enum LocalNetwork {
    static func addresses() -> [InterfaceAddress] {
        var list: [InterfaceAddress] = []
        var ptr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ptr) == 0, let head = ptr else { return [] }
        defer { freeifaddrs(ptr) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = head
        while let record = cursor {
            let item = record.pointee
            if let addr = item.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) {
                var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                    let name = String(cString: item.ifa_name)
                    let ip = String(cString: buffer)
                    // Skip loopback, link-local and cellular (pdp_ip*) addresses: the car cannot reach those.
                    if ip != "127.0.0.1" && !ip.hasPrefix("169.254.") && !name.hasPrefix("pdp_ip") { list.append(InterfaceAddress(name: name, ip: ip)) }
                }
            }
            cursor = item.ifa_next
        }
        return list.sorted { $0.name < $1.name }
    }
}
```

### `BanyanMirror/LocalNetworkPermission.swift`

Target: BanyanMirror

```swift
import Foundation
import Network

/// iOS blocks local-network traffic for an app until the user allows "Local Network" access, and a broadcast
/// extension cannot show that alert itself. Advertising and browsing for our own Bonjour service makes iOS show it
/// from the app, before the broadcast starts. Seeing our own service come back means access was granted.
final class LocalNetworkPermission: ObservableObject {
    enum Status { case unknown, checking, granted, denied }

    @Published private(set) var status: Status = .unknown
    private var listener: NWListener?
    private var browser: NWBrowser?
    private var timeout: DispatchWorkItem?

    func request() {
        guard status != .checking else { return }
        stop()
        status = .checking

        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        if let listener = try? NWListener(using: parameters) {
            listener.service = NWListener.Service(name: "BanyanMirror-\(UUID().uuidString.prefix(8))", type: MirrorSettings.bonjourType)
            listener.newConnectionHandler = { $0.cancel() }
            listener.start(queue: .main)
            self.listener = listener
        }

        let browseParameters = NWParameters.tcp
        browseParameters.includePeerToPeer = true
        let browser = NWBrowser(for: .bonjour(type: MirrorSettings.bonjourType, domain: nil), using: browseParameters)
        browser.stateUpdateHandler = { [weak self] state in
            // "Waiting" with a policy error is how a refusal shows up. Keep browsing: if the user switches access on,
            // our own service still appears and flips this to granted.
            if case .waiting = state { self?.status = .denied }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            if !results.isEmpty { self?.finish(.granted) }
        }
        browser.start(queue: .main)
        self.browser = browser

        // Give up after a while (the alert may still be on screen); the user can check again.
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.finish(self.status == .checking ? .unknown : self.status)
        }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: timeout)
    }

    private func finish(_ result: Status) {
        stop()
        status = result
    }

    private func stop() {
        timeout?.cancel()
        timeout = nil
        browser?.cancel()
        browser = nil
        listener?.cancel()
        listener = nil
    }
}
```

### `BanyanMirror/Info.plist`

Target: BanyanMirror (its Info.plist)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsLocalNetworking</key><true/></dict>
	<key>CFBundleDisplayName</key>
	<string>Banyan MJPEG</string>
	<key>CFBundleName</key>
	<string>BanyanMirror</string>
	<key>NSLocalNetworkUsageDescription</key>
	<string>Lets your parked car's browser receive your screen over your hotspot or trusted Wi-Fi.</string>
	<key>NSBonjourServices</key>
	<array>
		<string>_banyanmirror._tcp</string>
	</array>
	<key>UILaunchScreen</key>
	<dict/>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>0.5.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>CFBundleSupportedPlatforms</key>
	<array>
		<string>iPhoneOS</string>
	</array>
	<key>LSRequiresIPhoneOS</key>
	<true/>
</dict>
</plist>
```
