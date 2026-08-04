# Car Lockscreen

A single-page dashboard lockscreen for a car head unit or tablet: clock,
weather, notes, internet radio, a rear-seat camera view, a GIF widget and a taxi
meter — all positioned by dragging, all state kept in the browser.

Images get onto the screen **optically**. The phone renders a picture as an
animated QR stream and the car's camera reads it back. Nothing is uploaded,
there is no relay, no account and no API key anywhere in the path.

## Running it

Serve the directory over HTTP and open `index.html`:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

It needs to be served rather than opened as a `file://` URL, because the QR
decode runs in a Web Worker and the camera needs a secure context. For a real
install, any static host works — or `localhost` / HTTPS on your own LAN, which
is what the camera and the phone both require.

## Sending an image from your phone

1. On the car screen, open **Settings → Wallpapers → Add from Phone**. The
   camera view opens.
2. Tap **Open on phone** and scan the pairing code — it carries this page's
   address, nothing else. (Or just browse to the same URL with `?upload=true`.)
3. On the phone, choose an image. It starts streaming as QR frames immediately.
4. Hold the phone in front of the car's camera, filling the dashed frame. The
   progress bar tracks frames collected; the image lands as your wallpaper when
   it completes.

The GIF widget uses the same flow — tap it, or **Add new GIF** in its chooser.

### If it will not lock on

- Fill the frame with the phone and hold it steady; focus matters more than distance.
- Drop the sender to **1465 B** and **24 fps**. 2953 B is a V40 code and needs a
  close, sharp hold; 1465 B (V27) is the safe setting for arbitrary cameras.
- Turn the phone's brightness up and avoid glare on the screen.

Dropped frames only cost time, never correctness — see below.

## How the transfer works

A screen-to-camera link has no back-channel: the sender cannot be told which
frames arrived. So instead of looping the file in order and hoping, the sender
emits **fountain-coded** frames ([Luby transform](https://en.wikipedia.org/wiki/Luby_transform_code)).
Each frame is the XOR of a pseudorandom subset of the file's blocks, with the
subset derived deterministically from the frame's sequence number. The receiver
collects *any* ~1.15 × K distinct frames, in any order, and peels the file out.

Every frame is self-describing — 20-byte header, no handshake — so the receiver
can lock onto a stream already in flight, and a new session id simply starts a
fresh transfer. Integrity is checked twice: an FNV-1a over the whole container in
the frame header, and a SHA-256 of the payload inside it.

The wire format is a port of [Decimen Optical
Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) and is
bit-compatible with it. Implementation notes live at the top of
`assets/js/optical.js`.

**This is not encryption.** Whatever is on the sending screen is readable by any
camera pointed at it. What the optical path buys is the absence of a network,
not confidentiality.

## Where images are stored

Received images are blobs in IndexedDB, referenced from the wallpaper and GIF
lists as `local:<uuid>`. Those lists still live in `localStorage`, and an entry
may equally be an ordinary `https://` URL you pasted, so both kinds coexist.
Blobs that nothing references any more are collected on startup and whenever a
wallpaper or GIF is removed.

## Layout

```
index.html          markup, styles, widget logic, and the inline icon sprite
assets/
  js/optical.js     the wire format: frame header, DCF2 container, LT codes
  js/optical-ui.js  sender and receiver on top of it, plus image downscaling
  js/qr-worker.js   jsQR decode worker, so capture never blocks the UI
  js/image-store.js IndexedDB blob store behind the `local:` references
  vendor/           jsQR + node-qrcode, bundled (see LICENSES.md)
  fonts/            self-hosted woff2 and the OFL text
```

## Third-party services

Weather comes from [Open-Meteo](https://open-meteo.com/): free, no API key,
open data. Radio and video widgets contact a stream only once you press play.
That is the whole list — see [LICENSES.md](LICENSES.md).

## License

The project is licensed under the terms in [LICENSE](LICENSE). Vendored
libraries, fonts and icons keep their own licenses, recorded in
[LICENSES.md](LICENSES.md).
