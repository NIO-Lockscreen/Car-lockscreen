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
