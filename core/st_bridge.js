import { settings } from './settings.js';

function extractStringName(item) {
    if (typeof item === 'string') return item.trim();
    if (item && typeof item === 'object') {
        const keys = ['name', 'file_id', 'filename', 'id', 'title'];
        for (const k of keys) {
            if (typeof item[k] === 'string' && item[k].trim()) return item[k].trim();
        }
    }
    return '';
}

function cleanAndDedupeList(arr) {
    const set = new Set();
    for (const item of arr) {
        const name = extractStringName(item);
        if (name && name !== '[object Object]') set.add(name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

const loreCache = new Map();

export const stBridge = {
    getContext() {
        return window.SillyTavern?.getContext?.() || window.getContext?.() || {};
    },

    getLoreManagerConfig() {
        const cfg = settings.get('loremanager');
        return {
            activeBooks: Array.isArray(cfg.activeBooks) ? cfg.activeBooks : null,
            syncCharLifecycle: cfg.syncCharLifecycle !== false,
            autoActivateCharBook: cfg.autoActivateCharBook !== false,
            independentInject: cfg.independentInject !== false,
        };
    },

    saveLoreManagerConfig(patch) {
        settings.set('loremanager', patch);
    },

    getCharacterName() {
        const char = this.getCurrentCharacter();
        return char ? char.name : null;
    },

    getCurrentCharacter() {
        const ctx = this.getContext();
        const charId = ctx.characterId;
        if (charId !== undefined && charId !== null && ctx.characters && ctx.characters[charId]) {
            return ctx.characters[charId];
        }
        return null;
    },

    getWorldNames() {
        const ctx = this.getContext();
        const raw = [];

        if (typeof ctx.getWorldInfoNames === 'function') {
            try {
                const names = ctx.getWorldInfoNames();
                if (Array.isArray(names)) raw.push(...names);
            } catch (_) {}
        }

        if (Array.isArray(ctx.world_names)) {
            raw.push(...ctx.world_names);
        }

        const selectEl = document.getElementById('world_info');
        if (selectEl && selectEl.options) {
            for (const opt of selectEl.options) {
                const txt = (opt.text || '').trim();
                if (txt && txt !== 'None' && !txt.startsWith('---')) raw.push(txt);
            }
        }

        const wInfo = ctx.world_info || ctx.worldInfo;
        if (wInfo && typeof wInfo === 'object' && !Array.isArray(wInfo)) {
            raw.push(...Object.keys(wInfo));
        }

        return cleanAndDedupeList(raw);
    },

    async fetchWorldNamesFromApi() {
        const ctx = this.getContext();
        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };
            const res = await fetch('/api/worldinfo/list', {
                method: 'POST',
                headers,
                body: JSON.stringify({})
            });
            if (!res.ok) return [];
            const data = await res.json();
            let raw = [];
            if (Array.isArray(data)) raw = data;
            else if (data && typeof data === 'object') raw = Object.keys(data);
            
            const names = cleanAndDedupeList(raw);
            if (names.length) {
                if (!Array.isArray(ctx.world_names)) ctx.world_names = [];
                let changed = false;
                for (const n of names) {
                    if (!ctx.world_names.includes(n)) {
                        ctx.world_names.push(n);
                        changed = true;
                    }
                }
                if (changed) {
                    ctx.world_names = cleanAndDedupeList(ctx.world_names);
                }
            }
            return names;
        } catch (e) {
            console.warn('[nekotools] /api/worldinfo/list 请求失败', e);
            return [];
        }
    },

    async loadWorldInfoAsync(name, forceApi = false) {
        if (!forceApi && loreCache.has(name)) return loreCache.get(name);

        const ctx = this.getContext();
        if (!forceApi && typeof ctx.loadWorldInfo === 'function') {
            try {
                const book = await ctx.loadWorldInfo(name);
                if (book) { loreCache.set(name, book); return book; }
            } catch (e) {}
        }
        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name })
            });
            if (!res.ok) return null;
            const book = await res.json();
            loreCache.set(name, book);
            return book;
        } catch (e) {
            return null;
        }
    },

    getLorebook(name) {
        return loreCache.get(name) || null;
    },

    getGloballyActivatedWorlds() {
        if (window.extension_settings?.world_info?.globalSelect) {
            return window.extension_settings.world_info.globalSelect;
        }
        return [];
    },

    async mountGlobalWorldbook(name, activate) {
        const ctx = this.getContext();
        if (!window.extension_settings) window.extension_settings = {};
        if (!window.extension_settings.world_info) window.extension_settings.world_info = {};
        if (!Array.isArray(window.extension_settings.world_info.globalSelect)) {
            window.extension_settings.world_info.globalSelect = [];
        }

        const arr = window.extension_settings.world_info.globalSelect;
        const idx = arr.indexOf(name);
        if (activate && idx === -1) arr.push(name);
        else if (!activate && idx !== -1) arr.splice(idx, 1);

        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
        
        if (window.eventSource && window.event_types && window.event_types.WORLDINFO_SETTINGS_UPDATED) {
            window.eventSource.emit(window.event_types.WORLDINFO_SETTINGS_UPDATED);
        }

        setTimeout(() => {
            if (window.jQuery) {
                const selectEl = window.jQuery('#world_info_global');
                if (selectEl.length) {
                    if (selectEl.data('multipleSelect')) {
                        selectEl.multipleSelect('refresh');
                    }
                }
            }
        }, 100);

        return true;
    },

    async preloadActivatedLorebooks() {
        const names = this.getGloballyActivatedWorlds();
        for (const name of names) {
            await this.loadWorldInfoAsync(name, true);
        }
    },

    collectMatchedLoreEntries(recentText = '') {
        const names = this.getGloballyActivatedWorlds();
        const matched = [];
        const lowerText = String(recentText).toLowerCase();

        for (const name of names) {
            const book = loreCache.get(name) || this.getLorebook(name);
            if (!book || !book.entries) continue;
            for (const entry of Object.values(book.entries)) {
                if (entry.disable) continue;
                
                if (entry.constant) {
                    matched.push(entry);
                } else if (entry.key && entry.key.length > 0) {
                    let hasKey = false;
                    for (const k of entry.key) {
                        if (!k) continue;
                        if (lowerText.includes(k.toLowerCase())) {
                            hasKey = true;
                            break;
                        }
                    }
                    if (hasKey) matched.push(entry);
                }
            }
        }
        return matched;
    },

    async createWorldbook(name, initContent = 'NEKOTOOL初始化') {
        const ctx = this.getContext();
        if (!ctx) return false;

        const initData = {
            entries: {
                "1": {
                    uid: "1",
                    key: ["初始化"],
                    comment: "NEKOTOOL初始化",
                    content: initContent,
                    constant: true,
                    selective: true,
                    order: 100,
                    position: 0,
                    disable: false,
                    excludeRecursion: true,
                    preventRecursion: true
                }
            }
        };

        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };

            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ name, data: initData })
            });

            if (!res.ok) throw new Error(`API 失败: ${res.status}`);

            loreCache.set(name, initData);
            const wInfo = ctx.world_info || ctx.worldInfo;
            if (wInfo) wInfo[name] = initData;
            
            if (!Array.isArray(ctx.world_names)) ctx.world_names = [];
            if (!ctx.world_names.includes(name)) {
                ctx.world_names.push(name);
                ctx.world_names.sort();
            }
            return true;
        } catch (e) {
            console.error('[nekotools] 创建世界书失败', e);
            return false;
        }
    },

    async deleteWorldbook(name, { syncUnbindChar = true, deleteLinkedChar = false } = {}) {
        const ctx = this.getContext();
        try {
            if (syncUnbindChar && Array.isArray(ctx.characters)) {
                for (const char of ctx.characters) {
                    if (char.data?.extensions?.world === name) {
                        char.data.extensions.world = '';
                        if (typeof ctx.saveCharacterDebounced === 'function') {
                            ctx.saveCharacterDebounced(char.avatar);
                        }
                    }
                }
                await new Promise(r => setTimeout(r, 300));
            }

            const res = await fetch('/api/worldinfo/delete', {
                method: 'POST',
                headers: {
                    ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name })
            });
            
            if (res.ok) {
                loreCache.delete(name);
                if (ctx.world_names) {
                    const idx = ctx.world_names.indexOf(name);
                    if (idx !== -1) ctx.world_names.splice(idx, 1);
                }
                const wInfo = ctx.world_info || ctx.worldInfo;
                if (wInfo && wInfo[name]) delete wInfo[name];
                
                await this.mountGlobalWorldbook(name, false);
                return true;
            }
            return false;
        } catch (e) {
            console.error('[nekotools] 删除世界书失败', e);
            return false;
        }
    },

    async deleteEntries(bookName, uids) {
        const book = await this.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries) return false;
        for (const uid of uids) {
            delete book.entries[uid];
        }
        await this.persistLorebook(bookName, book);
        return true;
    },

    async forwardEntries(sourceName, targetName, uids) {
        const src = await this.loadWorldInfoAsync(sourceName, true);
        let dst = await this.loadWorldInfoAsync(targetName, true);

        if (!src || !src.entries) return false;
        
        if (!dst) {
            const created = await this.createWorldbook(targetName, '转发生成');
            if (!created) return false;
            dst = await this.loadWorldInfoAsync(targetName, true);
        }

        for (const uid of uids) {
            const entry = src.entries[uid];
            if (!entry) continue;
            const newUid = Date.now().toString() + Math.floor(Math.random() * 1000);
            dst.entries[newUid] = { ...JSON.parse(JSON.stringify(entry)), uid: newUid };
        }
        await this.persistLorebook(targetName, dst);
        return true;
    },

    async forwardBooks(sourceNames, targetName) {
        let dst = await this.loadWorldInfoAsync(targetName, true);
        if (!dst) {
            const created = await this.createWorldbook(targetName, '合并转发生成');
            if (!created) return { ok: false, count: 0 };
            dst = await this.loadWorldInfoAsync(targetName, true);
        }
        if (!dst.entries) dst.entries = {};

        let count = 0;
        for (const srcName of sourceNames) {
            if (srcName === targetName) continue;
            const src = await this.loadWorldInfoAsync(srcName, true);
            if (!src || !src.entries) continue;
            for (const entry of Object.values(src.entries)) {
                const newUid = Date.now().toString() + Math.floor(Math.random() * 10000);
                dst.entries[newUid] = { ...JSON.parse(JSON.stringify(entry)), uid: newUid };
                count++;
            }
        }
        await this.persistLorebook(targetName, dst);
        return { ok: true, count };
    },

    async toggleEntryState(bookName, uid, field) {
        const book = await this.loadWorldInfoAsync(bookName, true);
        if (!book || !book.entries || !book.entries[uid]) return false;
        const entry = book.entries[uid];
        entry[field] = !entry[field];
        await this.persistLorebook(bookName, book);
        return true;
    },

    async syncFromCharacterCard(charId, silent = false) {
        const ctx = this.getContext();
        const targetChar = charId !== null && charId !== undefined ? ctx.characters?.[charId] : this.getCurrentCharacter();
        if (!targetChar) return false;
        
        const charName = targetChar.name || '未命名角色';
        const book = targetChar.data?.character_book;
        const existingWorld = targetChar.data?.extensions?.world;
        
        if (existingWorld && this.getWorldNames().includes(existingWorld)) {
            return existingWorld;
        }
        
        if (!book || !book.entries || !book.entries.length) return false;
        
        const targetName = `【角色卡内嵌】${charName}`;
        const exists = this.getWorldNames().includes(targetName);
        if (exists && silent) return targetName;
        
        const initData = { entries: {} };
        book.entries.forEach((e, index) => {
            const uid = (Date.now() + index).toString();
            initData.entries[uid] = {
                uid: uid,
                key: e.keys || [],
                keysecondary: e.secondary_keys || [],
                comment: e.comment || e.name || `条目_${index}`,
                content: e.content || '',
                constant: e.constant || false,
                selective: e.selective || false,
                order: e.insertion_order || 100,
                position: e.position === 'before_char' ? 0 : 4,
                disable: e.enabled === false,
                excludeRecursion: true,
                preventRecursion: true
            };
        });
        
        try {
            const headers = {
                ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                'Content-Type': 'application/json'
            };
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ name: targetName, data: initData })
            });
            if (!res.ok) return false;
            
            loreCache.set(targetName, initData);
            const wInfo = ctx.world_info || ctx.worldInfo;
            if (wInfo) wInfo[targetName] = initData;
            
            if (!Array.isArray(ctx.world_names)) ctx.world_names = [];
            if (!ctx.world_names.includes(targetName)) {
                ctx.world_names.push(targetName);
                ctx.world_names.sort();
            }
            
            if (!targetChar.data.extensions) targetChar.data.extensions = {};
            targetChar.data.extensions.world = targetName;
            
            if (!silent && typeof ctx.saveCharacterDebounced === 'function') {
                ctx.saveCharacterDebounced(targetChar.avatar);
            }
            return targetName;
        } catch (e) {
            console.error('[nekotools] 角色卡同步失败', e);
            return false;
        }
    },

    async cleanupCharacterWorldbooks(payload) {
        const char = payload?.character || payload;
        if (!char) return;
        const charName = char.name;
        if (!charName) return;
        
        const booksToDelete = [];
        if (char.data?.extensions?.world) booksToDelete.push(char.data.extensions.world);
        booksToDelete.push(`【角色卡内嵌】${charName}`);
        booksToDelete.push(`【NEKOTOOL世界加载器·${charName}】`);
        
        for (const book of booksToDelete) {
            const worldNames = this.getWorldNames();
            if (worldNames.includes(book)) {
                await this.deleteWorldbook(book, { syncUnbindChar: false });
            }
        }
    },

    async updateEntry(bookName, title, content, isConstant = false, keywords = [], extra = {}) {
        const book = await this.loadWorldInfoAsync(bookName, true);
        if (!book) return;
        if (!book.entries) book.entries = {};

        let entryId = null;
        for (const [uid, entry] of Object.entries(book.entries)) {
            if (entry.comment === title) {
                entryId = uid;
                break;
            }
        }

        if (!entryId) {
            entryId = Date.now().toString() + Math.floor(Math.random() * 1000);
            book.entries[entryId] = {
                uid: entryId,
                key: isConstant ? [] : (keywords.length ? keywords : [title]),
                keysecondary: [],
                comment: title,
                content: content,
                constant: isConstant,
                selective: !isConstant,
                order: 100,
                position: 0,
                disable: false,
                excludeRecursion: true,
                preventRecursion: true,
                ...extra,
            };
        } else {
            const entry = book.entries[entryId];
            entry.content = content;
            entry.constant = isConstant;
            entry.selective = !isConstant;
            if (!isConstant && keywords.length) entry.key = keywords;
            Object.assign(entry, extra);
        }

        await this.persistLorebook(bookName, book);
    },

    async persistLorebook(bookName, bookData) {
        const ctx = this.getContext();
        loreCache.set(bookName, bookData);
        try {
            if (ctx && typeof ctx.saveWorldInfo === 'function' && bookData) {
                await ctx.saveWorldInfo(bookName, bookData, true);
            } else {
                const headers = {
                    ...(typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {}),
                    'Content-Type': 'application/json'
                };
                await fetch('/api/worldinfo/edit', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name: bookName, data: bookData })
                });
            }
        } catch (e) {
            console.warn('[nekotools] 保存世界书失败', e);
        }
    },

    hideOldMessages(keepCount = 2) {
        const ctx = this.getContext();
        if (!ctx || !ctx.chat) return;
        let aiCount = 0;
        let cutoffIndex = -1;
        for (let i = ctx.chat.length - 1; i >= 0; i--) {
            const msg = ctx.chat[i];
            if (!msg.is_user && !msg.is_system) {
                aiCount++;
                if (aiCount === keepCount + 1) {
                    cutoffIndex = i;
                    break;
                }
            }
        }
        if (cutoffIndex >= 0) {
            for (let i = 0; i < cutoffIndex; i++) {
                const msg = ctx.chat[i];
                if (msg.extra && msg.extra.nekotool_favorite) continue;
                msg.extra = { ...(msg.extra || {}), hidden: true };
            }
            if (typeof ctx.saveChat === 'function') {
                ctx.saveChat().then(() => {
                    if (window.SillyTavern?.eventSource) {
                        window.SillyTavern.eventSource.emit('chat_changed');
                    }
                });
            }
        }
    }
};