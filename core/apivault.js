// 设备本地加密仓库：API Key 不写入酒馆 settings.json，只存 IndexedDB。
// AES-GCM 密钥生成后以 “不可导出” CryptoKey 保存在同一 IndexedDB 中，
// 插件只保存 profileId，不保存明文 Key。

const DB_NAME = 'nekotool_api_vault';
const STORE = 'vault';
const KEY_ID = 'device-aes-key';

function openDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('当前浏览器不支持 IndexedDB'));
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('打开本地加密仓库失败'));
    });
}

let keyPromise = null;

async function getDeviceKey() {
    if (!window.isSecureContext || !window.crypto?.subtle) {
        throw new Error('API Key 需要 https 或 localhost 才能保存（当前不是安全上下文）');
    }
    if (keyPromise) return keyPromise;
    keyPromise = loadOrCreateKey().catch(e => {
        keyPromise = null;
        throw e;
    });
    return keyPromise;
}

async function loadOrCreateKey() {
    const db = await openDb();
    const existing = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY_ID);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
    if (existing) return existing;
    const key = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(key, KEY_ID);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    return key;
}

export async function saveSecret(id, plainText) {
    if (!id) throw new Error('缺少配置 ID');
    const key = await getDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(String(plainText || ''));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put({ iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) }, `secret:${id}`);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}

export async function getSecret(id) {
    if (!id) return '';
    const key = await getDeviceKey();
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(`secret:${id}`);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
    if (!record) return '';
    try {
        const iv = new Uint8Array(record.iv);
        const data = new Uint8Array(record.data);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
        return new TextDecoder().decode(decrypted);
    } catch (_) {
        console.warn('[nekotools] API Key 解密失败，请重新录入');
        return '';
    }
}

export async function deleteSecret(id) {
    if (!id) return;
    const db = await openDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(`secret:${id}`);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
}
