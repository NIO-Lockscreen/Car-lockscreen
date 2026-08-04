# Third-party licenses

The lockscreen loads nothing from a CDN at runtime — everything it needs is
committed under `assets/`. This file records where those files came from and
what they are licensed under.

## Vendored JavaScript — `assets/vendor/qr-vendor.min.js`

One bundle, built with esbuild from two upstream packages:

| Library | Version | License | Used for |
| --- | --- | --- | --- |
| [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | Decoding QR frames out of camera images |
| [node-qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | Encoding QR frames (core only — the canvas, SVG and PNG renderers are not bundled) |

Rebuild it with:

```bash
npm install jsqr qrcode esbuild
cat > entry.js <<'EOF'
import jsQR from "jsqr";
import * as QRCodeCore from "qrcode/lib/core/qrcode.js";
globalThis.jsQR = jsQR;
globalThis.QRCodeCore = { create: QRCodeCore.create };
EOF
npx esbuild entry.js --bundle --minify --format=iife --target=es2020 \
  --outfile=assets/vendor/qr-vendor.min.js
```

## Optical transfer protocol — `assets/js/optical.js`

The wire format is a port of [Decimen Optical
Transfer](https://github.com/bashalarmistalt/decimen-optical-transfer) by Evan
Crawley, MIT licensed. The TypeScript modules `shared/protocol.ts` and
`shared/fountain.ts` were rewritten as a single browser script; the frame
header, the DCF2 container, the robust-soliton distribution, `dlog()`,
`frameSeed()` and `frameIndices()` are all bit-compatible with upstream, so this
page interoperates with any other Decimen implementation.

## Icons — inline sprite in `index.html`

[Font Awesome Free](https://fontawesome.com) 7.3.1 solid glyphs. The icon paths
are licensed **CC BY 4.0**; only the 29 glyphs this page uses are included,
copied into an inline `<symbol>` sprite. Font Awesome's own CSS and webfonts are
not used.

## Fonts — `assets/fonts/`

Seven families from the Google Fonts API, latin and latin-ext subsets only, all
licensed under the **SIL Open Font License 1.1**. Full text and per-family
copyright holders are in [`assets/fonts/OFL.txt`](assets/fonts/OFL.txt).

Oswald · Roboto · Roboto Mono · Playfair Display · Source Code Pro · Inter · Lora

## Runtime network services

The only host the page contacts on its own is
[Open-Meteo](https://open-meteo.com/) — free, keyless, CORS-enabled open data —
for the weather widget, via `api.open-meteo.com` and
`geocoding-api.open-meteo.com`. Radio and video widgets contact a stream URL
only when the user starts playback.
