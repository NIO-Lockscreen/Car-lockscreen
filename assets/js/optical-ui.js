/*
 * Sender and receiver for the optical link, on top of the wire format in
 * optical.js.
 *
 * The phone renders a file as an endless fountain-coded QR stream; the car
 * screen watches it through its camera and peels the file back out. Nothing
 * leaves the two devices — there is no upload, no relay and no server involved,
 * which is the entire point of the exercise.
 *
 * Tuning notes carried over from the Decimen sender, which are worth keeping:
 * - Frame payload sets the QR version. Denser wins on goodput right up until the
 *   receiving camera can no longer resolve the modules; 1465 bytes (V27) is safe
 *   for arbitrary screens, 2953 (V40) is the ceiling and wants a close hold.
 * - The mask pattern is pinned. Any declared mask is valid to a decoder, and
 *   skipping the spec's 8-way mask evaluation makes generation several times
 *   faster, which matters when a frame has ~16 ms to exist.
 * - Displays need each frame shown for at least two refresh cycles or the camera
 *   catches a torn transition, so 24 fps on a 60 Hz panel is comfortable.
 * - Error correction stays at L: the fountain layer already handles erasures,
 *   and a frame is either decoded whole or discarded.
 */
(function (global) {
    'use strict';

    const Optical = global.Optical;

    const TX_FPS_OPTIONS = [10, 15, 20, 24, 30, 60];
    const FRAME_BYTES_OPTIONS = [500, 1000, 1465, 1850, 2331, 2953];
    const DEFAULT_TX_FPS = 24;
    const DEFAULT_FRAME_BYTES = 1465;
    const QUIET_ZONE_MODULES = 4;

    /* ---------------------------------------------------------------- sender */

    /**
     * Paint a QR module matrix onto a canvas.
     *
     * Drawn at one pixel per module into a scratch canvas, then blown up with
     * smoothing off. Scaling a tiny bitmap is far cheaper than filling thousands
     * of scaled rectangles, and smoothing off keeps module edges hard — a blurred
     * edge is exactly what makes a camera misread a dense frame.
     */
    function paintQr(ctx, scratch, qr, sizePx) {
        const count = qr.modules.size;
        const modules = qr.modules.data;
        const side = count + 2 * QUIET_ZONE_MODULES;

        if (scratch.width !== side || scratch.height !== side) {
            scratch.width = side;
            scratch.height = side;
        }
        const sctx = scratch.getContext('2d');
        const image = sctx.createImageData(side, side);
        const px = new Uint32Array(image.data.buffer);
        px.fill(0xffffffff); // opaque white, little-endian ABGR
        for (let y = 0; y < count; y++) {
            const row = (y + QUIET_ZONE_MODULES) * side + QUIET_ZONE_MODULES;
            const src = y * count;
            for (let x = 0; x < count; x++) {
                if (modules[src + x]) px[row + x] = 0xff000000; // opaque black
            }
        }
        sctx.putImageData(image, 0, 0);

        const canvas = ctx.canvas;
        if (canvas.width !== sizePx || canvas.height !== sizePx) {
            canvas.width = sizePx;
            canvas.height = sizePx;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, sizePx, sizePx);
        ctx.drawImage(scratch, 0, 0, sizePx, sizePx);
    }

    /**
     * Draw a plain-text QR (the pairing code carrying this page's URL).
     *
     * Unrelated to the transfer itself — it exists so the phone can open the
     * sender without anyone typing an address. ECC M and an automatic version,
     * since it is scanned once by a human rather than streamed.
     */
    function renderTextQr(canvas, text, sizePx) {
        const qr = global.QRCodeCore.create(text, { errorCorrectionLevel: 'M' });
        paintQr(canvas.getContext('2d'), document.createElement('canvas'), qr, sizePx);
        return qr;
    }

    function OpticalSender(options) {
        this.canvas = options.canvas;
        this.onStatus = options.onStatus || function () {};
        this.onError = options.onError || function () {};
        this.scratch = document.createElement('canvas');
        this.timer = null;
        this.running = false;
        this.seq = 0;
    }

    /**
     * Begin streaming `bytes` as QR frames. Resolves once the stream is running;
     * it never "finishes", because there is no back-channel to tell it the
     * receiver is done — the user stops it.
     */
    OpticalSender.prototype.start = function (bytes, name, type, settings) {
        const self = this;
        const frameBytes = (settings && settings.frameBytes) || DEFAULT_FRAME_BYTES;
        const fps = (settings && settings.fps) || DEFAULT_TX_FPS;

        this.stop();
        return Optical.packFile(name, type, bytes).then(function (packed) {
            const container = packed.container;
            if (!Optical.fitsInOneStream(container.length, frameBytes)) {
                const minimum = Optical.minimumFrameBytes(container.length);
                throw new Error(
                    'This image needs at least ' + minimum + ' bytes per frame ' +
                    '(a frame can only number ' + Optical.MAX_SOURCE_BLOCKS + ' blocks). ' +
                    'Raise the frame size.'
                );
            }

            const blockLen = Optical.blockLength(frameBytes);
            // 16 bits, and re-drawn per stream: a receiver watching a restarted
            // sender must see a different identity or it would feed new frames
            // into a decoder holding half of the previous file.
            const sessionId = Math.floor(Math.random() * 0x10000);
            const encoder = new Optical.LTEncoder(container, blockLen, sessionId);
            const header = {
                sessionId: sessionId,
                seq: 0,
                k: encoder.k,
                blockLen: blockLen,
                totalLen: container.length,
                payloadFnv: Optical.fnv1a(container)
            };

            const ctx = self.canvas.getContext('2d');
            self.running = true;
            self.seq = 0;

            const tick = function () {
                if (!self.running) return;
                try {
                    const seq = self.seq++;
                    header.seq = seq;
                    const frame = Optical.packFrame(header, encoder.encode(seq));
                    const qr = global.QRCodeCore.create([{ data: frame, mode: 'byte' }], {
                        errorCorrectionLevel: 'L',
                        maskPattern: 0
                    });
                    const sizePx = Math.max(1, Math.floor(self.canvas.clientWidth || 480));
                    paintQr(ctx, self.scratch, qr, sizePx);
                    self.onStatus({
                        seq: seq,
                        k: encoder.k,
                        // One full pass over the source blocks; the receiver needs
                        // roughly 1.15 of these, more if it is dropping frames.
                        passes: encoder.k > 0 ? (seq + 1) / encoder.k : 0,
                        version: qr.version,
                        frameBytes: frameBytes,
                        fps: fps,
                        originalSize: packed.originalSize,
                        transmittedSize: packed.transmittedSize,
                        compression: packed.compression
                    });
                } catch (err) {
                    self.stop();
                    self.onError(err);
                }
            };

            tick();
            self.timer = setInterval(tick, Math.max(1, Math.round(1000 / fps)));
            return {
                k: encoder.k,
                frameBytes: frameBytes,
                fps: fps,
                originalSize: packed.originalSize,
                transmittedSize: packed.transmittedSize,
                compression: packed.compression
            };
        });
    };

    OpticalSender.prototype.stop = function () {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    };

    /* -------------------------------------------------------------- receiver */

    const WORKER_COUNT = 2;

    /**
     * Build the QR decode worker.
     *
     * `new Worker('assets/js/qr-worker.js')` is refused outright when the page is
     * opened as a file:// URL — the origin is "null", so the script counts as
     * cross-origin and construction throws SecurityError. That matters, because
     * everything else the receiver needs (camera, IndexedDB, blob URLs) does work
     * from file://, and dropping to main-thread decoding costs ~50 ms per frame
     * at 720p, which the dashboard feels.
     *
     * A worker built from a blob URL is allowed even on an opaque origin, and
     * importScripts() from inside it can still reach absolute file:// URLs. So
     * the blob is a two-line shim that pulls in the real sources by absolute URL.
     * The same path works unchanged over http(s), so there is no branching here.
     */
    function makeDecodeWorker() {
        const vendorUrl = new URL('assets/vendor/qr-vendor.min.js', document.baseURI).href;
        const workerUrl = new URL('assets/js/qr-worker.js', document.baseURI).href;
        const shim = 'importScripts(' +
            JSON.stringify(vendorUrl) + ',' + JSON.stringify(workerUrl) + ');';
        const blobUrl = URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
        try {
            return new Worker(blobUrl);
        } finally {
            // The worker holds its own reference once constructed; releasing the
            // URL here keeps a long session from leaking one per receiver start.
            URL.revokeObjectURL(blobUrl);
        }
    }

    function OpticalReceiver(options) {
        this.video = options.video;
        this.onProgress = options.onProgress || function () {};
        this.onComplete = options.onComplete || function () {};
        this.onError = options.onError || function () {};
        this.onStatus = options.onStatus || function () {};

        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.workers = [];
        this.busy = [];
        this.stream = null;
        this.running = false;
        this.rafId = null;
        this.nextId = 1;
        this.decoder = null;
        this.identity = null;
        this.header = null;
        this.framesSeen = 0;
        this.lastFrameAt = 0;
    }

    OpticalReceiver.prototype.start = function (deviceId) {
        const self = this;
        this.stop();

        // Everything except a named device is `ideal`, so a camera that cannot
        // hit 1080p still opens at whatever it does support.
        const preferred = {
            audio: false,
            video: deviceId
                ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
                : {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 }
                }
        };

        // A remembered deviceId goes stale whenever cameras are added, removed or
        // re-enumerated, and `exact` turns that into an OverconstrainedError
        // rather than a fallback. Retry once with no device preference so a
        // missing camera degrades to "any camera" instead of to nothing.
        const open = navigator.mediaDevices.getUserMedia(preferred).catch(function (err) {
            if (!deviceId || (err && err.name !== 'OverconstrainedError')) throw err;
            return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        });

        return open.then(function (stream) {
            self.stream = stream;
            self.video.srcObject = stream;
            self.video.setAttribute('playsinline', '');
            self.video.muted = true;
            return self.video.play();
        }).then(function () {
            self.spawnWorkers();
            self.running = true;
            self.lastFrameAt = Date.now();
            self.pump();
            return true;
        }).catch(function (err) {
            self.stop();
            self.onError(err);
            throw err;
        });
    };

    OpticalReceiver.prototype.spawnWorkers = function () {
        const self = this;
        for (let i = 0; i < WORKER_COUNT; i++) {
            let worker;
            try {
                worker = makeDecodeWorker();
            } catch (err) {
                // Last resort: decoding falls back to pump()'s inline path, which
                // is slower but keeps the receiver working.
                console.warn('QR decode worker unavailable; decoding on the main thread.', err);
                break;
            }
            const slot = i;
            worker.onmessage = function (e) {
                self.busy[slot] = false;
                if (e.data && e.data.bytes) self.handleBytes(e.data.bytes);
            };
            worker.onerror = function () { self.busy[slot] = false; };
            this.workers.push(worker);
            this.busy.push(false);
        }
        // Surfaced for diagnostics: 0 here means decoding fell back to the main
        // thread, which is the difference between smooth and visibly stuttering.
        if (typeof window !== 'undefined') window.__lastWorkerCount = this.workers.length;
    };

    /**
     * Grab a camera frame and hand it to a free worker.
     *
     * Capture is capped at 1280px on the long edge: jsQR's cost scales with pixel
     * count, and past that the extra resolution buys nothing a V40 code needs.
     */
    OpticalReceiver.prototype.pump = function () {
        const self = this;
        if (!this.running) return;

        const video = this.video;
        if (video.readyState >= 2 && video.videoWidth > 0) {
            const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
            const w = Math.round(video.videoWidth * scale);
            const h = Math.round(video.videoHeight * scale);
            if (this.canvas.width !== w || this.canvas.height !== h) {
                this.canvas.width = w;
                this.canvas.height = h;
            }
            this.ctx.drawImage(video, 0, 0, w, h);

            const free = this.busy.indexOf(false);
            if (this.workers.length === 0) {
                // Inline fallback: no worker available.
                try {
                    const image = this.ctx.getImageData(0, 0, w, h);
                    const result = global.jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
                    if (result && result.binaryData && result.binaryData.length) {
                        this.handleBytes(Uint8Array.from(result.binaryData));
                    }
                } catch (err) { /* a torn frame is not worth reporting */ }
            } else if (free !== -1) {
                try {
                    const image = this.ctx.getImageData(0, 0, w, h);
                    this.busy[free] = true;
                    this.workers[free].postMessage(
                        { id: this.nextId++, buf: image.data.buffer, w: w, h: h },
                        [image.data.buffer]
                    );
                } catch (err) {
                    this.busy[free] = false;
                }
            }
            // else: every worker is busy, so drop this frame. The fountain does
            // not care which frames it gets, only that they keep coming.
        }

        this.rafId = requestAnimationFrame(function () { self.pump(); });
    };

    OpticalReceiver.prototype.handleBytes = function (bytes) {
        const parsed = Optical.parseFrame(bytes);
        if (!parsed) return; // some other QR code in shot, or a torn read

        const header = parsed.header;
        const identity = Optical.streamIdentity(header);

        // Reset on ANY header disagreement, not just a new session id. Session
        // ids are 16 random bits, so a collision across a sender restart is rare
        // but real, and mixing two files into one decoder corrupts it silently —
        // it would only surface as a checksum failure after the whole transfer.
        if (this.identity !== identity) {
            this.identity = identity;
            this.header = header;
            this.decoder = new Optical.LTDecoder(
                header.k, header.blockLen, header.sessionId, header.totalLen
            );
            this.framesSeen = 0;
            this.onStatus({ phase: 'locked', k: header.k, totalLen: header.totalLen });
        }

        if (this.decoder.isComplete) return;

        this.decoder.addFrame(header.seq, parsed.block);
        this.framesSeen++;
        this.lastFrameAt = Date.now();

        // Progress reports frames collected, not blocks solved: the peeling
        // cascade back-loads, so a blocks-solved bar sits still and then
        // teleports to 100%.
        const needed = Math.max(1, Math.ceil(this.decoder.k * 1.15));
        this.onProgress({
            frames: this.decoder.framesNew,
            duplicates: this.decoder.framesDup,
            needed: needed,
            solved: this.decoder.solvedCount,
            k: this.decoder.k,
            ratio: Math.min(1, this.decoder.framesNew / needed),
            totalLen: this.header.totalLen
        });

        if (this.decoder.isComplete) this.finish();
    };

    OpticalReceiver.prototype.finish = function () {
        const self = this;
        const decoder = this.decoder;
        const header = this.header;
        const container = decoder.assemble();
        if (!container) return;

        // Two independent checks, and both earn their place: the FNV-1a in the
        // frame header catches a decoder that peeled to a wrong-but-complete
        // solution, and the SHA-256 inside the container covers the payload
        // itself. Neither is a security boundary — the channel is plaintext by
        // construction — they are corruption checks.
        if (Optical.fnv1a(container) !== header.payloadFnv) {
            this.resetDecode();
            this.onError(new Error('Checksum mismatch — keep the camera steady and let it retry.'));
            return;
        }

        Optical.unpackFile(container).then(function (file) {
            return Optical.verifyFile(file).then(function (ok) {
                if (!ok) throw new Error('The received file failed its SHA-256 check.');
                self.onComplete(file);
            });
        }).catch(function (err) {
            self.resetDecode();
            self.onError(err);
        });
    };

    /** Drop the current decode so a retransmission starts cleanly. */
    OpticalReceiver.prototype.resetDecode = function () {
        this.decoder = null;
        this.identity = null;
        this.header = null;
        this.framesSeen = 0;
    };

    OpticalReceiver.prototype.secondsSinceFrame = function () {
        return (Date.now() - this.lastFrameAt) / 1000;
    };

    OpticalReceiver.prototype.stop = function () {
        this.running = false;
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.workers.forEach(function (worker) { worker.terminate(); });
        this.workers = [];
        this.busy = [];
        if (this.stream) {
            this.stream.getTracks().forEach(function (track) { track.stop(); });
            this.stream = null;
        }
        if (this.video) this.video.srcObject = null;
        this.resetDecode();
    };

    /* ----------------------------------------------------------- image prep */

    /**
     * Shrink an image before it goes on the wire.
     *
     * Transfer time is linear in bytes, and a modern phone photo is several
     * megabytes of detail that a dashboard screen cannot show anyway. Re-encoding
     * to a screen-sized JPEG turns a ~4 MB pick and a multi-minute stream into a
     * few hundred KB and a few seconds. GIFs are passed through untouched —
     * re-encoding one through a canvas would flatten it to a single frame.
     */
    function prepareImage(file, maxEdge, quality) {
        if (file.type === 'image/gif') {
            return file.arrayBuffer().then(function (buf) {
                return { bytes: new Uint8Array(buf), name: file.name, type: file.type };
            });
        }

        return new Promise(function (resolve, reject) {
            const img = new Image();
            const objectUrl = URL.createObjectURL(file);
            img.onload = function () {
                URL.revokeObjectURL(objectUrl);
                const longest = Math.max(img.naturalWidth, img.naturalHeight);
                const scale = Math.min(1, maxEdge / longest);
                const w = Math.max(1, Math.round(img.naturalWidth * scale));
                const h = Math.max(1, Math.round(img.naturalHeight * scale));

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, w, h);

                canvas.toBlob(function (blob) {
                    if (!blob) {
                        reject(new Error('Could not re-encode that image.'));
                        return;
                    }
                    blob.arrayBuffer().then(function (buf) {
                        const base = (file.name || 'image').replace(/\.[^.]+$/, '');
                        resolve({
                            bytes: new Uint8Array(buf),
                            name: base + '.jpg',
                            type: 'image/jpeg',
                            width: w,
                            height: h
                        });
                    }).catch(reject);
                }, 'image/jpeg', quality);
            };
            img.onerror = function () {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('That file could not be read as an image.'));
            };
            img.src = objectUrl;
        });
    }

    global.OpticalUI = {
        TX_FPS_OPTIONS: TX_FPS_OPTIONS,
        FRAME_BYTES_OPTIONS: FRAME_BYTES_OPTIONS,
        DEFAULT_TX_FPS: DEFAULT_TX_FPS,
        DEFAULT_FRAME_BYTES: DEFAULT_FRAME_BYTES,
        OpticalSender: OpticalSender,
        OpticalReceiver: OpticalReceiver,
        prepareImage: prepareImage,
        renderTextQr: renderTextQr
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
