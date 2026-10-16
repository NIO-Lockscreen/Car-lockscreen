// Offline support for the lockscreen.
// - The page itself: network first (so updates arrive), falling back to the cached copy when there is no
//   signal or the network takes longer than NAV_TIMEOUT_MS (tunnels, rural areas).
// - Fonts, icons and the QR library from the CDNs: served from cache, refreshed in the background.
// - Wallpapers: the page keeps its saved wallpapers in WALLPAPER_CACHE; images found there are served from it.
// Everything else (weather, stocks, radio, video, the phone relay, the phone mirror) goes straight to the network.
// Bump STATIC_CACHE when this file changes in a way that needs the old static cache dropped.
const STATIC_CACHE = 'lockscreen-static-v1';
const WALLPAPER_CACHE = 'lockscreen-wallpapers';
const NAV_TIMEOUT_MS = 4000;
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];
const SHELL_URL = new URL('./', self.registration.scope).href;
const PRECACHE = [SHELL_URL, 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys
            .filter((key) => key.startsWith('lockscreen-') && key !== STATIC_CACHE && key !== WALLPAPER_CACHE)
            .map((key) => caches.delete(key))))
        .then(() => self.clients.claim()));
});

const isShell = (url) => url.origin === self.location.origin
    && (url.href.split(/[?#]/)[0] === SHELL_URL || url.pathname === new URL('index.html', SHELL_URL).pathname);

const shellResponse = (event) => {
    const network = fetch(event.request).then((res) => {
        if (!res.ok) return res;
        const copy = res.clone();
        return caches.open(STATIC_CACHE).then((cache) => cache.put(SHELL_URL, copy)).then(() => res);
    });
    event.waitUntil(network.catch(() => {}));
    return caches.match(SHELL_URL, { cacheName: STATIC_CACHE }).then((cached) => {
        if (!cached) return network;
        return Promise.race([
            network.catch(() => cached),
            new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS)),
        ]);
    });
};

const staleWhileRevalidate = (event) => caches.open(STATIC_CACHE).then((cache) => cache.match(event.request).then((cached) => {
    const network = fetch(event.request).then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(event.request, res.clone()).catch(() => {});
        return res;
    });
    if (!cached) return network;
    event.waitUntil(network.catch(() => {}));
    return cached;
}));

// An opaque (no-CORS) copy can only answer a no-CORS request, e.g. a CSS background but not a crossOrigin <img>.
const wallpaperResponse = (event) => caches.open(WALLPAPER_CACHE)
    .then((cache) => cache.match(event.request, { ignoreVary: true }))
    .then((cached) => (cached && (cached.type !== 'opaque' || event.request.mode === 'no-cors') ? cached : fetch(event.request)));

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    // Plain-HTTP requests to other hosts (the phone mirror's stream on the local network) must go straight from the page:
    // fetched from here they count as blocked mixed content, and an endless MJPEG stream has no business in a cache.
    if (url.protocol === 'http:' && url.origin !== self.location.origin) return;
    if (req.mode === 'navigate') {
        if (isShell(url)) event.respondWith(shellResponse(event));
        return;
    }
    if (req.destination === 'image' && url.origin !== self.location.origin) {
        event.respondWith(wallpaperResponse(event));
        return;
    }
    if (url.origin === self.location.origin || CDN_HOSTS.includes(url.hostname)) {
        event.respondWith(staleWhileRevalidate(event));
    }
});
