/*
 * Optical file transfer — fountain-coded QR streaming over a screen/camera gap.
 *
 * A faithful port of the wire format from Decimen Optical Transfer
 * (https://github.com/bashalarmistalt/decimen-optical-transfer, MIT), rewritten
 * from TypeScript modules into one browser script so the lockscreen keeps its
 * no-build, no-CDN deployment.
 *
 * THIS FILE IS WIRE FORMAT. The sender and the receiver derive the fountain
 * block sets independently and never compare notes, so any change to the header
 * layout, the degree distribution, dlog(), frameSeed() or frameIndices() breaks
 * compatibility with every other Decimen implementation — including a sender
 * page a user saved months ago. Change it only on purpose.
 *
 * Frame layout (little-endian), 20-byte header + `blockLen` payload bytes:
 *    0  u8   magic 0xD1
 *    1  u8   magic 0x0C
 *    2  u16  sessionId   random per sender start
 *    4  u32  seq         drives the fountain PRNG
 *    8  u16  k           source block count
 *   10  u16  blockLen    payload bytes per frame
 *   12  u32  totalLen    file-container length in bytes
 *   16  u32  payloadFnv  FNV-1a of the whole container, checked on completion
 *
 * There is no handshake: every frame is self-describing, so a receiver locks
 * onto a stream mid-flight and a new session id simply starts a fresh transfer.
 */
(function (global) {
    'use strict';

    const HEADER_LEN = 20;
    const MAGIC0 = 0xd1;
    const MAGIC1 = 0x0c;

    const FILE_HEADER_LEN = 49;
    const FILE_MAGIC = new Uint8Array([0x44, 0x43, 0x46, 0x32]); // "DCF2"
    const MAX_FILE_BYTES = 64 * 1024 * 1024;

    /** `k` is a u16 in the frame header, so a stream cannot carry more blocks. */
    const MAX_SOURCE_BLOCKS = 0xffff;

    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    /* ---------------------------------------------------------------- hashing */

    function fnv1a(bytes) {
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
            h ^= bytes[i];
            h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
    }

    /** splitmix32 — deterministic across JS engines (integer ops only). */
    function splitmix32(seed) {
        let s = seed | 0;
        return function () {
            s = (s + 0x9e3779b9) | 0;
            let t = s ^ (s >>> 16);
            t = Math.imul(t, 0x21f0aaad);
            t ^= t >>> 15;
            t = Math.imul(t, 0x735a2d97);
            t ^= t >>> 15;
            return t >>> 0;
        };
    }

    async function digest(bytes) {
        // Copy: crypto.subtle rejects views backed by a SharedArrayBuffer, and a
        // subarray of a larger buffer would hash the wrong extent.
        const stable = Uint8Array.from(bytes);
        return new Uint8Array(await crypto.subtle.digest('SHA-256', stable));
    }

    /* ------------------------------------------------------------ compression */

    async function gzipAsync(bytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    /*
     * Inflate with a hard output ceiling.
     *
     * The gzip trailer's declared size arrives over the optical channel like
     * everything else, so it is a hint and never a bound. Counting bytes off the
     * stream and aborting past `maxBytes` is what stops an 80 KB capture from
     * claiming to be small and inflating to gigabytes.
     */
    async function gunzipAsync(bytes, maxBytes) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > maxBytes) {
                await reader.cancel();
                throw new Error('The recovered file expands past its declared length.');
            }
            chunks.push(value);
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    /** Media types whose bytes are already entropy-coded. */
    const PRECOMPRESSED_TYPES = new Set([
        'application/gzip', 'application/java-archive', 'application/vnd.rar',
        'application/x-7z-compressed', 'application/x-brotli', 'application/x-bzip',
        'application/x-bzip2', 'application/x-gzip', 'application/x-lzma',
        'application/x-rar-compressed', 'application/x-xz', 'application/x-zip-compressed',
        'application/zip', 'application/zstd'
    ]);
    const COMPRESSIBLE_IMAGES = /^image\/(bmp|x-ms-bmp|svg\+xml|tiff|x-icon|vnd\.microsoft\.icon)$/;
    const COMPRESSIBLE_AUDIO = /^audio\/(wav|x-wav|wave|vnd\.wave|aiff|x-aiff|basic|l16)$/;

    /*
     * Would gzip be a waste of time here? Deliberately a list rather than a
     * heuristic: a wrong "skip" costs a few percent of transfer size, a wrong
     * "try" costs a whole extra full-size buffer. Wallpapers are JPEG/PNG/WebP,
     * so in this app the answer is almost always yes-skip.
     */
    function isPrecompressedType(type) {
        const media = String(type || '').split(';')[0].trim().toLowerCase();
        if (media.startsWith('video/')) return true;
        if (media.startsWith('image/')) return !COMPRESSIBLE_IMAGES.test(media);
        if (media.startsWith('audio/')) return !COMPRESSIBLE_AUDIO.test(media);
        if (media.startsWith('application/vnd.openxmlformats-officedocument.')) return true;
        if (media.startsWith('application/vnd.oasis.opendocument.')) return true;
        if (media.endsWith('+zip')) return true;
        return PRECOMPRESSED_TYPES.has(media);
    }

    /*
     * Reduce a name to a bare basename. Applied on BOTH ends: the sender doing it
     * is a convenience, the receiver doing it is the part that matters, because
     * the name it unpacks is whatever the other screen chose to display.
     */
    function safeFileName(name) {
        const base = String(name == null ? '' : name).split(/[\\/]/).pop() || '';
        const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'transfer.bin' : cleaned;
    }

    /* -------------------------------------------------------- file container */

    /** Wrap raw bytes in the DCF2 container: name, media type, SHA-256, payload. */
    async function packFile(name, type, bytes) {
        if (bytes.length === 0) throw new Error('Choose a non-empty file.');
        if (bytes.length > MAX_FILE_BYTES) {
            throw new Error('Files are limited to ' + (MAX_FILE_BYTES / 1024 / 1024) + ' MB.');
        }

        const nameBytes = textEncoder.encode(safeFileName(name));
        const typeBytes = textEncoder.encode(type || 'application/octet-stream');
        if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
            throw new Error('The file name or media type is too long.');
        }

        // Too small to be worth a gzip header, or a format gzip cannot help with.
        const tryGzip = bytes.length >= 768 && !isPrecompressedType(type);
        const results = await Promise.all([
            digest(bytes),
            tryGzip ? gzipAsync(bytes) : Promise.resolve(undefined)
        ]);
        const sha256 = results[0];
        const compressed = results[1];
        const useGzip = compressed !== undefined && compressed.length + 64 < bytes.length;
        const transmitted = useGzip ? compressed : bytes;

        const out = new Uint8Array(
            FILE_HEADER_LEN + nameBytes.length + typeBytes.length + transmitted.length
        );
        const view = new DataView(out.buffer);
        out.set(FILE_MAGIC, 0);
        view.setUint8(4, useGzip ? 1 : 0);
        view.setUint16(5, nameBytes.length, true);
        view.setUint16(7, typeBytes.length, true);
        view.setUint32(9, bytes.length, true);
        view.setUint32(13, transmitted.length, true);
        out.set(sha256, 17);
        out.set(nameBytes, FILE_HEADER_LEN);
        out.set(typeBytes, FILE_HEADER_LEN + nameBytes.length);
        out.set(transmitted, FILE_HEADER_LEN + nameBytes.length + typeBytes.length);

        return {
            container: out,
            compression: useGzip ? 'gzip' : 'none',
            originalSize: bytes.length,
            transmittedSize: transmitted.length
        };
    }

    async function unpackFile(container) {
        if (container.length < FILE_HEADER_LEN) {
            throw new Error('The recovered file header is incomplete.');
        }
        for (let i = 0; i < FILE_MAGIC.length; i++) {
            if (container[i] !== FILE_MAGIC[i]) throw new Error('The recovered file header is invalid.');
        }

        const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
        const compressionByte = view.getUint8(4);
        if (compressionByte > 1) throw new Error('The recovered file uses unsupported compression.');
        const compression = compressionByte === 1 ? 'gzip' : 'none';
        const nameLength = view.getUint16(5, true);
        const typeLength = view.getUint16(7, true);
        const fileLength = view.getUint32(9, true);
        const transmittedLength = view.getUint32(13, true);
        const dataOffset = FILE_HEADER_LEN + nameLength + typeLength;

        if (fileLength === 0 || fileLength > MAX_FILE_BYTES ||
            transmittedLength === 0 || transmittedLength > MAX_FILE_BYTES ||
            dataOffset + transmittedLength !== container.length) {
            throw new Error('The recovered file length does not match its header.');
        }

        const transmitted = container.slice(dataOffset);
        if (compression === 'gzip') {
            if (transmitted.length < 18) throw new Error('The recovered gzip payload is incomplete.');
            const trailer = new DataView(
                transmitted.buffer, transmitted.byteOffset + transmitted.byteLength - 4, 4
            );
            if (trailer.getUint32(0, true) !== fileLength) {
                throw new Error('The gzip payload length does not match its file header.');
            }
        }
        const bytes = compression === 'gzip'
            ? await gunzipAsync(transmitted, fileLength)
            : transmitted;
        if (bytes.length !== fileLength) {
            throw new Error('The decompressed file length does not match its header.');
        }

        return {
            name: safeFileName(
                textDecoder.decode(container.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + nameLength))
            ),
            type: textDecoder.decode(container.subarray(FILE_HEADER_LEN + nameLength, dataOffset))
                || 'application/octet-stream',
            sha256: container.slice(17, 49),
            bytes: bytes,
            compression: compression,
            transmittedSize: transmittedLength
        };
    }

    async function verifyFile(file) {
        const actual = await digest(file.bytes);
        if (actual.length !== file.sha256.length) return false;
        for (let i = 0; i < actual.length; i++) {
            if (actual[i] !== file.sha256[i]) return false;
        }
        return true;
    }

    /* --------------------------------------------------------------- framing */

    function packFrame(h, block) {
        const out = new Uint8Array(HEADER_LEN + block.length);
        const dv = new DataView(out.buffer);
        dv.setUint8(0, MAGIC0);
        dv.setUint8(1, MAGIC1);
        dv.setUint16(2, h.sessionId, true);
        dv.setUint32(4, h.seq, true);
        dv.setUint16(8, h.k, true);
        dv.setUint16(10, h.blockLen, true);
        dv.setUint32(12, h.totalLen, true);
        dv.setUint32(16, h.payloadFnv, true);
        out.set(block, HEADER_LEN);
        return out;
    }

    function parseFrame(bytes) {
        if (bytes.length <= HEADER_LEN) return null;
        if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const header = {
            sessionId: dv.getUint16(2, true),
            seq: dv.getUint32(4, true),
            k: dv.getUint16(8, true),
            blockLen: dv.getUint16(10, true),
            totalLen: dv.getUint32(12, true),
            payloadFnv: dv.getUint32(16, true)
        };
        if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
        if (bytes.length !== HEADER_LEN + header.blockLen) return null;
        return { header: header, block: bytes.subarray(HEADER_LEN) };
    }

    /*
     * Everything that must hold constant for a decoder to keep accepting frames.
     * `seq` is deliberately absent — it is the one field that varies in a stream.
     *
     * The receiver resets on ANY disagreement, not just a new session id: session
     * ids are 16 bits drawn at random per sender restart, so a collision across a
     * restart is rare but real, and a mismatched frame fed into the old decoder
     * corrupts it silently, surfacing only as a checksum failure at the very end.
     */
    function streamIdentity(h) {
        return h.sessionId + ':' + h.k + ':' + h.blockLen + ':' + h.totalLen + ':' + h.payloadFnv;
    }

    /* -------------------------------------------------------- fountain codes */

    const LN2 = 0.6931471805599453;

    /*
     * Deterministic natural log: exact-ops range reduction plus an atanh series.
     *
     * Math.log is implementation-approximated — V8 (a sending Android phone) and
     * JavaScriptCore (a receiving iPhone) may differ by an ulp, which is enough to
     * shift a CDF entry, flip a sampled degree and silently desynchronise the two
     * ends. This uses only exactly-specified IEEE-754 operations.
     */
    function dlog(x) {
        let e = 0;
        let m = x;
        while (m >= 1.5) { m /= 2; e++; }
        while (m < 0.75) { m *= 2; e--; }
        const z = (m - 1) / (m + 1);
        const z2 = z * z;
        let term = z;
        let sum = 0;
        for (let n = 1; n <= 21; n += 2) {
            sum += term / n;
            term *= z2;
        }
        return e * LN2 + 2 * sum;
    }

    const SOLITON_C = 0.1;
    const SOLITON_DELTA = 0.5;

    /** Robust-soliton degree CDF for k source blocks. */
    function solitonCdf(k) {
        const cdf = new Float64Array(k);
        if (k === 1) {
            cdf[0] = 1;
            return cdf;
        }
        const R = Math.max(1, SOLITON_C * dlog(k / SOLITON_DELTA) * Math.sqrt(k));
        const spike = Math.min(k, Math.ceil(k / R));
        let total = 0;
        for (let d = 1; d <= k; d++) {
            const rho = d === 1 ? 1 / k : 1 / (d * (d - 1));
            let tau = 0;
            if (d < spike) tau = R / (d * k);
            else if (d === spike) tau = (R * Math.max(0, dlog(R / SOLITON_DELTA))) / k;
            total += rho + tau;
            cdf[d - 1] = total;
        }
        for (let i = 0; i < k; i++) cdf[i] = cdf[i] / total;
        cdf[k - 1] = 1;
        return cdf;
    }

    function frameSeed(sessionId, seq) {
        let h = (Math.imul(sessionId + 1, 0x9e3779b1) ^ (seq + 0x85ebca6b)) | 0;
        h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
        return (h ^ (h >>> 16)) | 0;
    }

    /** The block indices XORed into frame `seq` — derived identically on both ends. */
    function frameIndices(k, cdf, sessionId, seq) {
        const rnd = splitmix32(frameSeed(sessionId, seq));
        // inverse-CDF sample the degree
        const u = rnd() * Math.pow(2, -32);
        let lo = 0;
        let hi = k - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cdf[mid] >= u) hi = mid;
            else lo = mid + 1;
        }
        const d = Math.min(k, lo + 1);
        if (d > k >> 3) {
            // large degree: partial Fisher-Yates over an identity array
            const scratch = new Uint32Array(k);
            for (let i = 0; i < k; i++) scratch[i] = i;
            const out = new Array(d);
            for (let i = 0; i < d; i++) {
                const j = i + (rnd() % (k - i));
                const t = scratch[i];
                scratch[i] = scratch[j];
                scratch[j] = t;
                out[i] = scratch[i];
            }
            return out;
        }
        const set = new Set();
        while (set.size < d) set.add(rnd() % k);
        return Array.from(set);
    }

    function xorInto(dst, src) {
        for (let i = 0; i < dst.length; i++) dst[i] = (dst[i] ^ src[i]) >>> 0;
    }

    function LTEncoder(payload, blockLen, sessionId) {
        this.blockLen = blockLen;
        this.sessionId = sessionId;
        this.k = Math.max(1, Math.ceil(payload.length / blockLen));
        this.words = Math.ceil(blockLen / 4);
        this.blocks = new Uint32Array(this.k * this.words);
        const bytes = new Uint8Array(this.blocks.buffer);
        for (let b = 0; b < this.k; b++) {
            const src = payload.subarray(b * blockLen, Math.min((b + 1) * blockLen, payload.length));
            bytes.set(src, b * this.words * 4);
        }
        this.cdf = solitonCdf(this.k);
    }

    LTEncoder.prototype.encode = function (seq) {
        const idx = frameIndices(this.k, this.cdf, this.sessionId, seq);
        const out = new Uint32Array(this.words);
        for (let i = 0; i < idx.length; i++) {
            const off = idx[i] * this.words;
            for (let w = 0; w < this.words; w++) out[w] = (out[w] ^ this.blocks[off + w]) >>> 0;
        }
        return new Uint8Array(out.buffer, 0, this.blockLen);
    };

    function LTDecoder(k, blockLen, sessionId, totalLen) {
        this.k = k;
        this.blockLen = blockLen;
        this.sessionId = sessionId;
        this.totalLen = totalLen;
        this.words = Math.ceil(blockLen / 4);
        this.cdf = solitonCdf(k);
        this.solved = new Array(k).fill(null);
        this.byBlock = new Map();
        this.seen = new Set();
        this.solvedCount = 0;
        this.framesNew = 0;
        this.framesDup = 0;
    }

    Object.defineProperty(LTDecoder.prototype, 'isComplete', {
        get: function () { return this.solvedCount >= this.k; }
    });

    LTDecoder.prototype.addFrame = function (seq, block) {
        if (this.seen.has(seq)) {
            this.framesDup++;
            return;
        }
        this.seen.add(seq);
        this.framesNew++;
        if (this.isComplete) return;

        const idx = new Set(frameIndices(this.k, this.cdf, this.sessionId, seq));
        const words = new Uint32Array(this.words);
        new Uint8Array(words.buffer).set(block.subarray(0, this.blockLen));
        for (const b of Array.from(idx)) {
            const s = this.solved[b];
            if (s) {
                xorInto(words, s);
                idx.delete(b);
            }
        }
        if (idx.size === 0) return; // fully redundant
        if (idx.size === 1) {
            this.resolve(idx.values().next().value, words);
            return;
        }
        const pf = { idx: idx, words: words };
        for (const b of idx) {
            let set = this.byBlock.get(b);
            if (!set) {
                set = new Set();
                this.byBlock.set(b, set);
            }
            set.add(pf);
        }
    };

    /*
     * Peeling cascade: solve a block, reduce every frame waiting on it, repeat.
     *
     * Progress UX note: this back-loads. Blocks solved hockey-sticks near the end
     * while frame ARRIVAL is linear, so the progress bar shows frames collected —
     * showing blocks solved looks stalled and then teleports.
     */
    LTDecoder.prototype.resolve = function (b0, w0) {
        const queue = [[b0, w0]];
        while (queue.length > 0) {
            const entry = queue.pop();
            const b = entry[0];
            const w = entry[1];
            if (this.solved[b]) continue;
            this.solved[b] = w;
            this.solvedCount++;
            const waiting = this.byBlock.get(b);
            if (!waiting) continue;
            this.byBlock.delete(b);
            for (const pf of waiting) {
                xorInto(pf.words, w);
                pf.idx.delete(b);
                if (pf.idx.size === 1) {
                    const r = pf.idx.values().next().value;
                    const set = this.byBlock.get(r);
                    if (set) set.delete(pf);
                    if (!this.solved[r]) queue.push([r, pf.words]);
                }
            }
        }
    };

    LTDecoder.prototype.assemble = function () {
        if (!this.isComplete) return null;
        const out = new Uint8Array(this.totalLen);
        for (let b = 0; b < this.k; b++) {
            const start = b * this.blockLen;
            const len = Math.min(this.blockLen, this.totalLen - start);
            if (len > 0) out.set(new Uint8Array(this.solved[b].buffer, 0, len), start);
        }
        return out;
    };

    /* ------------------------------------------------------- frame capacity */

    function blockLength(frameBytes) {
        return frameBytes - HEADER_LEN;
    }

    function sourceBlockCount(payloadBytes, frameBytes) {
        return Math.ceil(payloadBytes / blockLength(frameBytes));
    }

    function fitsInOneStream(payloadBytes, frameBytes) {
        return sourceBlockCount(payloadBytes, frameBytes) <= MAX_SOURCE_BLOCKS;
    }

    /** The smallest bytes-per-frame that can carry this payload at all. */
    function minimumFrameBytes(payloadBytes) {
        return Math.ceil(payloadBytes / MAX_SOURCE_BLOCKS) + HEADER_LEN;
    }

    global.Optical = {
        HEADER_LEN: HEADER_LEN,
        MAX_FILE_BYTES: MAX_FILE_BYTES,
        MAX_SOURCE_BLOCKS: MAX_SOURCE_BLOCKS,
        fnv1a: fnv1a,
        splitmix32: splitmix32,
        dlog: dlog,
        solitonCdf: solitonCdf,
        frameIndices: frameIndices,
        isPrecompressedType: isPrecompressedType,
        packFile: packFile,
        unpackFile: unpackFile,
        verifyFile: verifyFile,
        packFrame: packFrame,
        parseFrame: parseFrame,
        streamIdentity: streamIdentity,
        LTEncoder: LTEncoder,
        LTDecoder: LTDecoder,
        blockLength: blockLength,
        sourceBlockCount: sourceBlockCount,
        fitsInOneStream: fitsInOneStream,
        minimumFrameBytes: minimumFrameBytes
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
