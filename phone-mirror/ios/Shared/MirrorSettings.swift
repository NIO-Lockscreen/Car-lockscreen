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
