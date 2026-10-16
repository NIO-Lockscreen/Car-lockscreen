"""Integration tests of the real receiver protocol, including multipart MJPEG bytes."""
import http.client
import json
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from server import BOUNDARY, PORTRAIT, Frames, Handler


def start_server(frames):
    http_server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    http_server.daemon_threads = True
    http_server.pin = '684293'
    http_server.frames = frames
    threading.Thread(target=http_server.serve_forever, daemon=True).start()
    time.sleep(.3)
    return http_server


def stop_server(http_server):
    http_server.frames.running = False
    with http_server.frames.cv:
        http_server.frames.cv.notify_all()
    http_server.shutdown()
    http_server.server_close()


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = start_server(Frames(10))
        cls.port = cls.http.server_address[1]

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.http)

    def request(self, path, method='GET'):
        con = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        con.request(method, path)
        r = con.getresponse()
        result = r.status, r.getheader('Content-Type'), r.read(), dict(r.getheaders())
        con.close()
        return result

    def test_health(self):
        self.assertIn(b'"listening":true', self.request('/health')[2])

    def test_alive_pixel_needs_no_pin(self):
        code, typ, data, _ = self.request('/alive.gif')
        self.assertEqual((code, typ), (200, 'image/gif'))
        self.assertTrue(data.startswith(b'GIF89a'))

    def test_pin_rejected(self):
        self.assertEqual(self.request('/frame.jpg?pin=wrong')[0], 403)
        self.assertEqual(self.request('/stream?pin=wrong')[0], 403)

    def test_ui(self):
        status, typ, body, _ = self.request('/')
        self.assertEqual(status, 200)
        self.assertIn(b'BANYAN', body)

    def test_still_frame(self):
        code, typ, data, headers = self.request('/frame.jpg?pin=684293')
        self.assertEqual(code, 200)
        self.assertEqual(typ, 'image/jpeg')
        self.assertTrue(data.startswith(b'\xff\xd8'))
        self.assertTrue(data.endswith(b'\xff\xd9'))
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')

    def test_status_reports_portrait_iphone_shape(self):
        code, _, body, headers = self.request('/status?pin=684293')
        self.assertEqual(code, 200)
        status = json.loads(body)
        self.assertTrue(status['live'])
        self.assertEqual((status['width'], status['height']), PORTRAIT)
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')

    def test_local_network_preflight(self):
        code, _, _, headers = self.request('/status?pin=684293', method='OPTIONS')
        self.assertEqual(code, 204)
        self.assertEqual(headers.get('Access-Control-Allow-Private-Network'), 'true')
        self.assertEqual(headers.get('Access-Control-Allow-Origin'), '*')

    def test_mjpeg_ends_each_frame_with_boundary(self):
        con = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        con.request('GET', '/stream?pin=684293')
        r = con.getresponse()
        self.assertEqual(r.status, 200)
        self.assertIn('multipart/x-mixed-replace', r.getheader('Content-Type'))
        self.assertEqual(r.getheader('Access-Control-Allow-Origin'), '*')
        opening = r.read(len(f'--{BOUNDARY}\r\n'))
        self.assertEqual(opening, f'--{BOUNDARY}\r\n'.encode())
        head = b''
        while not head.endswith(b'\r\n\r\n'):
            head += r.read(1)
        self.assertIn(b'Content-Type: image/jpeg', head)
        length = int(head.split(b'Content-Length: ')[1].split(b'\r\n')[0])
        jpeg = r.read(length)
        self.assertTrue(jpeg.startswith(b'\xff\xd8') and jpeg.endswith(b'\xff\xd9'))
        # The closing boundary arrives with the frame, not with the next one.
        self.assertEqual(r.read(len(f'\r\n--{BOUNDARY}\r\n')), f'\r\n--{BOUNDARY}\r\n'.encode())
        con.close()


class StillScreenTest(unittest.TestCase):
    def test_still_screen_resends_last_frame(self):
        http_server = start_server(Frames(10, still=True))
        try:
            con = http.client.HTTPConnection('127.0.0.1', http_server.server_address[1], timeout=5)
            con.request('GET', '/stream?pin=684293')
            r = con.getresponse()
            started = time.monotonic()
            frames = 0
            buffer = b''
            while frames < 2 and time.monotonic() - started < 4.5:
                buffer += r.read1(65536)
                frames = buffer.count(b'Content-Type: image/jpeg')
            self.assertGreaterEqual(frames, 2, 'a still screen should still get the last frame re-sent')
            con.close()
        finally:
            stop_server(http_server)


if __name__ == '__main__':
    unittest.main(verbosity=2)
