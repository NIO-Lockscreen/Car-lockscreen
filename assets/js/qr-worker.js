/*
 * QR decode worker.
 *
 * jsQR is a synchronous, CPU-heavy scan. Run on the main thread at capture rate
 * it stalls the clock and the wallpaper pan, so decoding lives here and the page
 * keeps a small pool of these. One frame in flight per worker; the page drops
 * frames when every worker is busy, which is free — the fountain layer does not
 * care which frames arrive, only how many distinct ones.
 */
/* global importScripts, jsQR */
importScripts('../vendor/qr-vendor.min.js');

self.onmessage = function (e) {
    const data = e.data;
    const id = data.id;
    try {
        const pixels = new Uint8ClampedArray(data.buf);
        // "dontInvert": a QR on a lit screen is always dark-on-light, and
        // letting jsQR retry inverted roughly doubles the cost per frame.
        const result = jsQR(pixels, data.w, data.h, { inversionAttempts: 'dontInvert' });
        const bytes = result && result.binaryData && result.binaryData.length
            ? Uint8Array.from(result.binaryData)
            : null;
        if (bytes) {
            self.postMessage({ id: id, bytes: bytes }, [bytes.buffer]);
        } else {
            self.postMessage({ id: id, bytes: null });
        }
    } catch (err) {
        self.postMessage({ id: id, bytes: null });
    }
};

// Tell the page this worker is loaded and its first (slow) JIT pass is done.
self.postMessage({ id: -1, bytes: null });
