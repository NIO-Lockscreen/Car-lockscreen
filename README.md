# Car Lockscreen

A single-page dashboard lockscreen for a car head unit or tablet: clock,
weather, notes, internet radio, a rear-seat camera view, a GIF widget and a taxi
meter — all positioned by dragging, all state kept in the browser.

Images get onto the screen **optically**. The phone renders a picture as an
animated QR stream and the car's camera reads it back. Nothing is uploaded,
there is no relay, no account and no API key anywhere in the path.

## Running it

**No server required.** Opening `index.html` straight off disk works, camera
included — Chrome treats `file://` as a secure context, so `getUserMedia`,
IndexedDB, blob URLs and `localStorage` are all available. Copy the folder onto
the device and open it.

Serving over HTTP also works and changes nothing functionally:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/
```

The reason to serve it is the *phone*, not the car: a `file://` path on the car
means nothing to another device, so the pairing code has no address to point at.
Only the car needs a camera and therefore a secure context — the sender is just a
file picker and a canvas, so plain HTTP on a LAN address is enough for the phone.

The one `file://` wrinkle is handled internally: `new Worker('…/qr-worker.js')`
is refused on an opaque origin, so the decode worker is constructed from a blob
URL that pulls its sources in by absolute URL. Full worker performance either
way, and no main-thread stutter.

## Getting an image onto the screen

There are two routes, both offline. Open **Settings → Wallpapers → Add from
Phone** on the car screen to reach either.

### Already have the file on this device?

Tap **Pick a local file**. USB stick, SD card, a download — anything the device's
file picker can see goes straight into storage with no transfer at all. This is
the shortest path and worth trying first.

### Otherwise: send it optically from your phone

1. The camera view is already open.
2. Get the sender open on the phone. Tap **Open on phone** and scan the pairing
   code — it carries this page's address and nothing else. If the car is running
   from `file://` that address is meaningless to the phone, so instead point the
   phone at any copy of this page (a static host, or the same folder served on
   your LAN) with `?upload=true` on the end.
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
