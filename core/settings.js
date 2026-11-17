const ST_KEY = 'NEKOTOOL';
const LS_KEY = 'nekotools:settings:v1';

function getSTStore() {
    // ST 并不把 extension_settings 挂到 window 上，必须从 getContext() 取真实引用，
    // 否则设置只会写进 localStorage，永远不会进 ST 的 settings.json。
    try {
        const ctx = window.SillyTavern?.getContext?.() || window.getContext?.();
        const st = ctx?.extensionSettings || window.extension_settings;
        if (st && typeof st === 'object') return st;
    } catch (_) {}
    return null;
}

export const settings = {
    data: {},

    load() {
        const st = getSTStore();
        if (st && st[ST_KEY] && typeof st[ST_KEY] === 'object' && Object.keys(st[ST_KEY]).length) {
            this.data = st[ST_KEY];
            return;
        }
        if (st && st.nekotool && typeof st.nekotool === 'object' && Object.keys(st.nekotool).length) {
            this.data = st.nekotool;
            st[ST_KEY] = this.data;
            try { delete st.nekotool; } catch (_) {}
            this.save();
            return;
        }
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                this.data = JSON.parse(raw);
                if (st) st[ST_KEY] = this.data;
                this.save();
            }
        } catch { this.data = {}; }
    },

    save() {
        const st = getSTStore();
        if (st) st[ST_KEY] = this.data;
        try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); } catch {}
        try {
            const ctx = window.SillyTavern?.getContext?.()
                || (typeof window.getContext === 'function' ? window.getContext() : null);
            if (ctx && typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        } catch {}
    },

    get(id) { return this.data[id] ?? {}; },

    set(id, patch) {
        this.data[id] = { ...this.get(id), ...patch };
        this.save();
    },

    exportAll(extraState = {}) {
        return {
            __nekotool_export: true,
            version: 1,
            timestamp: Date.now(),
            data: JSON.parse(JSON.stringify(this.data)),
            state: JSON.parse(JSON.stringify(extraState || {})),
        };
    },

    importAll(obj) {
        if (!obj || typeof obj !== 'object') throw new Error('Invalid file');
        let src = {};
        if (obj.data && typeof obj.data === 'object') src = obj.data;
        else if (obj.__nekotool_export === undefined) src = obj;
        const merged = { ...this.data };
        for (const [id, cfg] of Object.entries(src)) {
            if (!cfg || typeof cfg !== 'object') continue;
            merged[id] = { ...(merged[id] || {}), ...cfg };
        }
        this.data = merged;
        this.save();
        return (obj.state && typeof obj.state === 'object') ? obj.state : {};
    }
};