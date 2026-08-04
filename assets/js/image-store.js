/*
 * Local image store.
 *
 * Wallpapers and GIFs used to be remote URLs on an image host, so "storing" one
 * meant keeping a string in localStorage. Images now arrive as bytes over the
 * optical link and never touch a server, so the bytes themselves have to live
 * somewhere: localStorage tops out around 5 MB and holds strings only, which a
 * single phone photo blows past once base64 has inflated it by a third.
 *
 * So blobs go in IndexedDB, keyed by a stable `local:<uuid>` reference. The
 * wallpaper and GIF lists in localStorage keep holding plain strings — either a
 * `local:` reference or an ordinary http(s) URL the user pasted — which is what
 * lets the existing list, dedupe and "is this the selected one" logic keep
 * comparing strings and not care where the pixels came from.
 *
 * ready() resolves every stored blob to an object URL up front so url() can stay
 * synchronous: the render paths assign `background-image` inline, and making
 * them all async to look up a handful of wallpapers would be a much larger and
 * more fragile change than eagerly minting a few object URLs at boot.
 */
(function (global) {
    'use strict';

    const DB_NAME = 'carLockscreenImages';
    const DB_VERSION = 1;
    const STORE = 'images';
    const PREFIX = 'local:';

    /** ref -> object URL, populated by ready() and kept in step by put()/remove(). */
    const urls = new Map();
    let dbPromise = null;
    let readyPromise = null;

    function isLocalRef(ref) {
        return typeof ref === 'string' && ref.startsWith(PREFIX);
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            let request;
            try {
                request = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (err) {
                reject(err);
                return;
            }
            request.onupgradeneeded = function () {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE, { keyPath: 'id' });
                }
            };
            request.onsuccess = function () { resolve(request.result); };
            request.onerror = function () { reject(request.error); };
            request.onblocked = function () { reject(new Error('Image store is blocked by another tab.')); };
        });
        return dbPromise;
    }

    function tx(mode, run) {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                const transaction = db.transaction(STORE, mode);
                const store = transaction.objectStore(STORE);
                let result;
                try {
                    result = run(store);
                } catch (err) {
                    reject(err);
                    return;
                }
                transaction.oncomplete = function () { resolve(result && result.value); };
                transaction.onerror = function () { reject(transaction.error); };
                transaction.onabort = function () { reject(transaction.error); };
            });
        });
    }

    /** Wrap a request so its result survives until the transaction completes. */
    function boxed(request) {
        const box = { value: undefined };
        request.onsuccess = function () { box.value = request.result; };
        return box;
    }

    function newRef() {
        const uuid = (global.crypto && global.crypto.randomUUID)
            ? global.crypto.randomUUID()
            : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
        return PREFIX + uuid;
    }

    /**
     * Load every stored blob and mint its object URL.
     *
     * Failures here are deliberately soft: a browser in private mode, or one that
     * refuses IndexedDB entirely, should still show the clock and the widgets
     * rather than dying at boot. url() then just returns non-local refs as-is.
     */
    function ready() {
        if (readyPromise) return readyPromise;
        readyPromise = tx('readonly', function (store) {
            return boxed(store.getAll());
        }).then(function (records) {
            (records || []).forEach(function (record) {
                if (!record || !record.blob) return;
                if (urls.has(record.id)) return;
                urls.set(record.id, URL.createObjectURL(record.blob));
            });
            return true;
        }).catch(function (err) {
            console.warn('Image store unavailable; local images will not persist.', err);
            return false;
        });
        return readyPromise;
    }

    /**
     * Resolve a stored reference to something an <img> or background-image can use.
     * Plain URLs pass through untouched, so a pasted https:// wallpaper still works.
     */
    function url(ref) {
        if (!isLocalRef(ref)) return ref;
        return urls.get(ref) || '';
    }

    function has(ref) {
        return isLocalRef(ref) ? urls.has(ref) : false;
    }

    /** Persist a blob and return its stable `local:` reference. */
    function put(blob, name, type) {
        const id = newRef();
        const record = {
            id: id,
            blob: blob,
            name: name || 'image',
            type: type || blob.type || 'application/octet-stream',
            added: Date.now()
        };
        return tx('readwrite', function (store) {
            store.put(record);
        }).then(function () {
            urls.set(id, URL.createObjectURL(blob));
            return id;
        });
    }

    function remove(ref) {
        if (!isLocalRef(ref)) return Promise.resolve(false);
        return tx('readwrite', function (store) {
            store.delete(ref);
        }).then(function () {
            const objectUrl = urls.get(ref);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            urls.delete(ref);
            return true;
        }).catch(function (err) {
            console.warn('Could not remove stored image.', err);
            return false;
        });
    }

    /**
     * Drop stored blobs nothing points at any more.
     *
     * Removing a wallpaper only rewrites a localStorage list; without this the
     * bytes would sit in IndexedDB forever and the store would grow without
     * bound as wallpapers are cycled.
     */
    function collectGarbage(referenced) {
        const keep = new Set(Array.from(referenced || []).filter(isLocalRef));
        const doomed = [];
        urls.forEach(function (_objectUrl, ref) {
            if (!keep.has(ref)) doomed.push(ref);
        });
        return Promise.all(doomed.map(remove)).then(function () { return doomed.length; });
    }

    function estimate() {
        if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
        return navigator.storage.estimate().catch(function () { return null; });
    }

    global.ImageStore = {
        PREFIX: PREFIX,
        isLocalRef: isLocalRef,
        ready: ready,
        url: url,
        has: has,
        put: put,
        remove: remove,
        collectGarbage: collectGarbage,
        estimate: estimate
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
