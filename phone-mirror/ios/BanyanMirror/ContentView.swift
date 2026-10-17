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
                        Text("Fast local MJPEG for NIO ET5 · v0.3").foregroundStyle(.secondary)
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
                                    Text(verbatim: "http://\(addr.ip):\(MirrorSettings.port)/lockscreen/")
                                        .font(.system(.subheadline, design: .monospaced))
                                        .textSelection(.enabled)
                                }
                            }
                            Text("Or, in the normal lockscreen, turn on **Phone Mirror** (Settings › Show Full Settings › Widget Visibility), enter one of these addresses and the PIN in its settings, and tap **Open via iPhone** if the picture is blocked.")
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
