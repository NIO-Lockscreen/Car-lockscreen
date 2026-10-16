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
