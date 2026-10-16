#!/usr/bin/env python3
"""Banyan MJPEG smoke test: animated MJPEG + authenticated JPEG polling, same protocol as the iPhone extension.
Does NOT capture a phone. Draws an iPhone-shaped test screen so the lockscreen's Phone widget can be tried
without Xcode: shape detection, the horizontal button and the fallback page.
"""
import argparse
import base64
import io
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'web/receiver.html').read_bytes()
BOUNDARY = 'banyanframe'
HEARTBEAT_SECONDS = 2
# 1x1 GIF behind /alive.gif: an <img> can load it where fetch() is not allowed.
PIXEL_GIF = base64.b64decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==')
# An iPhone 15/16 screen (1179 x 2556) scaled to the extension's 960 px long edge.
PORTRAIT = (443, 960)


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 has only the small bitmap font
        return ImageFont.load_default()


class Frames:
    def __init__(self, fps=10, rotate_every=0, still=False, video_every=0):
        self.cv = threading.Condition()
        self.frame = b''
        self.size = (0, 0)
        self.sequence = 0
        self.published_at = 0.0
        self.fps = fps
        self.rotate_every = rotate_every
        self.still = still
        self.video_every = video_every
        self.running = True
        self.fonts = {s: font(s) for s in (18, 26, 34, 96)}
        threading.Thread(target=self.draw_loop, daemon=True).start()

    def draw(self, t, landscape, video=False):
        w, h = (PORTRAIT[1], PORTRAIT[0]) if landscape else PORTRAIT
        if video:
            return self.draw_video(t, w, h)
        im = Image.new('RGB', (w, h), (5, 11, 20))
        d = ImageDraw.Draw(im)
        f = self.fonts
        # Status bar, like the top of an iPhone screen.
        d.text((24, 14), time.strftime('%H:%M'), fill=(240, 244, 250), font=f[18])
        d.text((w - 50, 14), '5G', fill=(240, 244, 250), font=f[18])
        d.rounded_rectangle((w // 2 - 60, 10, w // 2 + 60, 40), radius=15, fill=(0, 0, 0))
        d.text((24, 70), 'BANYAN / MJPEG', fill=(117, 241, 204), font=f[26])
        d.text((24, 104), 'Desktop simulator', fill=(170, 195, 217), font=f[18])
        d.text((24, 128), 'Landscape frame' if landscape else 'Portrait frame', fill=(170, 195, 217), font=f[18])
        d.text((24, h // 2 - 70), f'{t:05.1f}', fill=(242, 246, 253), font=f[96])
        d.text((24, h // 2 + 40), f'{w} x {h} px · {self.fps} fps', fill=(170, 195, 217), font=f[18])
        # A ball that sweeps across, so frozen frames are obvious.
        track_y = h - 120
        d.rounded_rectangle((24, track_y - 8, w - 24, track_y + 8), radius=8, fill=(35, 64, 71))
        x = 46 + int((math.sin(t * 2.4) + 1) / 2 * (w - 92))
        d.ellipse((x - 22, track_y - 22, x + 22, track_y + 22), fill=(107, 235, 192))
        # An arrow pointing at the top of the phone screen: shows whether the picture is the right way up.
        d.polygon([(w - 60, 90), (w - 85, 130), (w - 35, 130)], fill=(255, 212, 59))
        d.text((w - 82, 136), 'TOP', fill=(255, 212, 59), font=f[18])
        d.rounded_rectangle((w // 2 - 70, h - 22, w // 2 + 70, h - 14), radius=4, fill=(220, 225, 235))
        return self.encode(im)

    def draw_video(self, t, w, h):
        """A 16:9 video played full screen: black bars above and below (or beside) the picture."""
        im = Image.new('RGB', (w, h), (0, 0, 0))
        d = ImageDraw.Draw(im)
        vw, vh = (w, w * 9 // 16) if w * 9 // 16 <= h else (h * 16 // 9, h)
        x0, y0 = (w - vw) // 2, (h - vh) // 2
        for i in range(vh):  # a sky-to-sea gradient, never black
            k = i / max(1, vh - 1)
            d.line((x0, y0 + i, x0 + vw - 1, y0 + i), fill=(int(40 + 60 * k), int(90 + 80 * k), int(170 - 40 * k)))
        bx = x0 + 30 + int((math.sin(t * 2.4) + 1) / 2 * (vw - 60))
        d.ellipse((bx - 18, y0 + vh // 2 - 18, bx + 18, y0 + vh // 2 + 18), fill=(255, 212, 59))
        d.text((x0 + 16, y0 + 12), f'VIDEO 16:9  {t:05.1f}', fill=(255, 255, 255), font=self.fonts[18])
        return self.encode(im)

    def encode(self, im):
        result = io.BytesIO()
        im.save(result, 'JPEG', quality=61, optimize=False)
        return result.getvalue(), im.size

    def draw_loop(self):
        start = time.monotonic()
        while self.running:
            t = time.monotonic() - start
            landscape = bool(self.rotate_every) and int(t // self.rotate_every) % 2 == 1
            video = bool(self.video_every) and int(t // self.video_every) % 2 == 1
            jpeg, size = self.draw(t, landscape, video)
            with self.cv:
                self.frame, self.size = jpeg, size
                self.sequence += 1
                self.published_at = time.time()
                self.cv.notify_all()
            if self.still:  # like a phone whose screen is not changing: no new frames at all
                with self.cv:
                    self.cv.wait_for(lambda: not self.running)
                return
            elapsed = time.monotonic() - start
            time.sleep(max(0, (self.sequence / self.fps) - elapsed))


class Handler(BaseHTTPRequestHandler):
    server_version = 'BanyanMJPEG/0.3'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        if urlsplit(self.path).path not in ('/stream', '/frame.jpg', '/status'):
            super().log_message(fmt, *args)

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')

    def send_body(self, body, mime='text/plain', code=200):
        self.send_response(code)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # Preflight for the HTTPS lockscreen reading /status across the local network.
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        parsed = urlsplit(self.path)
        if parsed.path in ('/', '/index.html'):
            return self.send_body(HTML, 'text/html; charset=utf-8')
        if parsed.path == '/health':
            return self.send_body(b'{"server":"BanyanMJPEG","listening":true}', 'application/json')
        if parsed.path == '/alive.gif':
            return self.send_body(PIXEL_GIF, 'image/gif')
        if parse_qs(parsed.query).get('pin', [''])[0] != self.server.pin:
            return self.send_body(b'Wrong PIN', code=403)
        frames = self.server.frames
        with frames.cv:
            jpeg, count, size, published = frames.frame, frames.sequence, frames.size, frames.published_at
        if parsed.path == '/status':
            d = {'live': bool(jpeg), 'broadcasting': True, 'paused': False, 'bytes': len(jpeg), 'frames': count,
                 'width': size[0], 'height': size[1],
                 'lastFrameAgeMs': int((time.time() - published) * 1000) if jpeg else -1,
                 'viewers': 1, 'transport': 'MJPEG', 'fps': frames.fps}
            return self.send_body(json.dumps(d).encode(), 'application/json')
        if parsed.path == '/frame.jpg':
            return self.send_body(jpeg, 'image/jpeg', 200 if jpeg else 503)
        if parsed.path != '/stream':
            return self.send_body(b'Not found', code=404)
        self.send_response(200)
        self.send_header('Content-Type', f'multipart/x-mixed-replace; boundary={BOUNDARY}')
        self.send_header('Cache-Control', 'no-cache, no-store')
        self.cors()
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True
        # The boundary goes out right after each frame, so the browser shows that frame immediately.
        self.wfile.write(f'--{BOUNDARY}\r\n'.encode())
        seen = -1
        try:
            while frames.running:
                with frames.cv:
                    # A still screen sends nothing new; re-send the last frame now and then (like the phone does).
                    frames.cv.wait_for(lambda: frames.sequence != seen or not frames.running, timeout=HEARTBEAT_SECONDS)
                    seen = frames.sequence
                    jpg = frames.frame
                if not jpg:
                    continue
                header = f'Content-Type: image/jpeg\r\nContent-Length: {len(jpg)}\r\n\r\n'.encode()
                self.wfile.write(header + jpg + f'\r\n--{BOUNDARY}\r\n'.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass


def serve(port=8765, pin='684293', fps=10, rotate_every=0, still=False, video_every=0):
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    server.daemon_threads = True
    server.pin = pin
    server.frames = Frames(fps, rotate_every, still, video_every)
    print(f'Server running: http://127.0.0.1:{port}/  |  PIN {pin}  |  {fps}fps')
    print('In the lockscreen Phone widget, enter this computer\'s LAN IPv4 (not 127.0.0.1) and the PIN. CTRL+C to quit.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopping server…')
    finally:
        server.frames.running = False
        with server.frames.cv:
            server.frames.cv.notify_all()
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--port', type=int, default=8765)
    p.add_argument('--pin', default='684293')
    p.add_argument('--fps', type=int, default=10)
    p.add_argument('--rotate-every', type=float, default=0, help='switch between portrait and landscape frames every N seconds (0 = never)')
    p.add_argument('--still', action='store_true', help='send one frame and then nothing new, like an unchanging phone screen')
    p.add_argument('--video-every', type=float, default=0, help='switch between the app screen and a letterboxed 16:9 video every N seconds (0 = never)')
    args = p.parse_args()
    serve(args.port, args.pin, args.fps, args.rotate_every, args.still, args.video_every)
