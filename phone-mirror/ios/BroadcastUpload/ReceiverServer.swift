import Foundation
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
            sendOnce(conn, code: 200, mime: "application/json", body: Data("{\"server\":\"BanyanMJPEG\",\"listening\":true}".utf8)); return
        }
        if path.path == "/alive.gif" {
            // An <img> can load this where fetch() is not allowed: the lockscreen uses it to notice a stopped broadcast.
            sendOnce(conn, code: 200, mime: "image/gif", body: ReceiverServer.pixelGIF); return
        }
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
    private func sendOnce(_ conn: NWConnection, code: Int, mime: String, body: Data) {
        let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 503: "Service Unavailable"][code] ?? "Error"
        let head = "HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(mime)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(body)
        conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
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
