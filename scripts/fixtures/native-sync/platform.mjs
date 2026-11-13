const server = () => process.env.NT_SERVER || null;
// NT_BROWSER=1 runs the same app code as the browser (PWA): no native
// SQLite, the offline queue in IndexedDB (indexeddb.mjs).
export const isNative = process.env.NT_BROWSER !== '1';
export const getServerUrl = server;
export const getAuthToken = () => process.env.NT_TOKEN || null;
export const setAuthToken = t => { if (t == null) delete process.env.NT_TOKEN; else process.env.NT_TOKEN = t; };
export const apiUrl = p => (server() || '') + p;
export const resolveAssetUrl = x => x;
export const restoreCachedAssetUrl = x => x;
export const getNativeMode = () => (server() ? 'server' : 'local');
export const setNativeMode = () => {};
export const setServerUrl = () => {};
export const needsNativeSetup = () => false;
export const iconUrl = x => x;
export const bootMirrorAuth = () => {};
export const loadImageMap = async () => ({});
export const setImageMap = () => {};
export const explainConnectError = e => String(e);
