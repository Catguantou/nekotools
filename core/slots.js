// 存档位：列表、新建、切换、删除、快速存档/导入。
// 依赖 st_bridge 的世界书接口；档名规则与存档格式在 worldfmt.js。

import { stBridge } from './st_bridge.js';
import { settings } from './settings.js';
import {
    slotName,
    slotNumber,
    sanitizeWorldName,
    buildSaveFile,
    parseSaveFile,
    slotLabel,
} from './worldfmt.js';

function readMeta() {
    const cfg = settings.get('worldsim');
    const meta = cfg && typeof cfg.slotMeta === 'object' ? cfg.slotMeta : {};
    return meta;
}

function setSlotMeta(bookName, patch) {
    if (!bookName) return;
    const meta = readMeta();
    meta[bookName] = { ...(meta[bookName] || {}), ...patch };
    settings.set('worldsim', { slotMeta: meta });
}

function removeSlotMeta(bookName) {
    const meta = readMeta();
    if (meta[bookName]) {
        delete meta[bookName];
        settings.set('worldsim', { slotMeta: meta });
    }
}

function currentAiCount() {
    const ctx = stBridge.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    return chat.filter(m => m && !m.is_user && !m.is_system).length;
}

/** 记录这一档最后一次被使用的时间与层数（列表显示用） */
export function touchSlot(bookName) {
    if (!bookName) return;
    setSlotMeta(bookName, {
        lastPlayed: new Date().toISOString(),
        lastLayer: currentAiCount(),
    });
}

/** 当前角色的所有档；没有档时返回一个“第 1 档（未创建）”的占位 */
export function listSlots() {
    const charName = stBridge.getCharacterName();
    if (!charName) return [];
    const meta = readMeta();
    const current = stBridge.currentTrackerName();
    const books = stBridge.listTrackerBooksForCurrentChar();

    if (!books.length) {
        const name = slotName(charName, 1);
        return [{
            n: 1,
            label: slotLabel(1),
            name,
            active: false,
            exists: false,
            current: true,
            lastPlayed: '',
            lastLayer: 0,
            progress: meta[name]?.progress ?? null,
        }];
    }

    return books.map(b => ({
        n: b.slot,
        label: slotLabel(b.slot),
        name: b.name,
        active: b.active,
        exists: true,
        current: b.name === current,
        lastPlayed: meta[b.name]?.lastPlayed || '',
        lastLayer: Number(meta[b.name]?.lastLayer) || 0,
        progress: meta[b.name]?.progress ?? null,
    }));
}

/** 新建下一档并激活它；返回 { name, slot } */
export async function createSlot() {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');

    const books = stBridge.listTrackerBooksForCurrentChar();
    const next = books.length ? Math.max(...books.map(b => b.slot)) + 1 : 1;
    const name = slotName(charName, next);

    const book = await stBridge.ensureWorldbook(name);
    if (!book) throw new Error('新建存档失败（世界书没建出来）');
    await stBridge.deactivateStaleAutoBooks(name);
    touchSlot(name);
    return { name, slot: next };
}

/** 切到第 n 档：先挂新、再摘旧 */
export async function switchSlot(n) {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');

    const target = stBridge.listTrackerBooksForCurrentChar().find(b => b.slot === Number(n));
    if (!target) throw new Error(`第 ${n} 档不存在`);

    const ok = await stBridge.mountGlobalWorldbook(target.name, true);
    if (!ok) throw new Error('切换失败：酒馆没找到这本书');
    if (!stBridge.isGloballyActivated(target.name)) throw new Error('切换失败：激活状态没生效');

    await stBridge.deactivateStaleAutoBooks(target.name);
    touchSlot(target.name);
    return target.name;
}

/** 删除第 n 档；若删的是当前档，自动切到剩下编号最大的档 */
export async function deleteSlot(n) {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');

    const target = stBridge.listTrackerBooksForCurrentChar().find(b => b.slot === Number(n));
    if (!target) throw new Error(`第 ${n} 档不存在`);

    const wasActive = target.active || target.name === stBridge.currentTrackerName();
    const ok = await stBridge.deleteWorldbook(target.name, { syncUnbindChar: false });
    if (!ok) throw new Error('删除失败（文件没删掉）');
    removeSlotMeta(target.name);

    if (wasActive) {
        const rest = stBridge.listTrackerBooksForCurrentChar();
        if (rest.length) await switchSlot(rest[rest.length - 1].slot);
    }
    return true;
}

function dateStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadJson(filename, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

/** 快速存档：把当前档导成 JSON 下载；返回导出的档名 */
export async function exportCurrent() {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');
    const name = stBridge.currentTrackerName();
    if (!name) throw new Error('当前没有可导出的存档');

    const book = await stBridge.loadWorldInfoAsync(name, true);
    if (!book || !book.entries) throw new Error('读取当前存档失败');

    const slot = slotNumber(name) || 1;
    const payload = buildSaveFile({ card: charName, slot, book });
    downloadJson(`nekotool_${sanitizeWorldName(charName)}_slot${slot}_${dateStamp()}.json`, payload);
    touchSlot(name);
    return { name, slot };
}

/** 快速导入：校验后覆盖当前档；覆盖前自动下载当前档备份 */
export async function importCurrent(file) {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');

    const text = await file.text();
    const parsed = parseSaveFile(text);
    if (parsed.card !== charName) {
        throw new Error(`这是「${parsed.card}」的存档，不能导入到当前角色`);
    }

    const name = stBridge.currentTrackerName();
    if (!name) throw new Error('当前没有可写入的存档');
    const slot = slotNumber(name) || 1;

    const before = await stBridge.loadWorldInfoAsync(name, true);
    if (before && before.entries) {
        downloadJson(
            `nekotool_backup_${sanitizeWorldName(charName)}_slot${slot}_${dateStamp()}.json`,
            buildSaveFile({ card: charName, slot, book: before })
        );
    }

    await stBridge._writeBook(name, parsed.book);
    const after = await stBridge.loadWorldInfoAsync(name, true);
    if (!after || !after.entries) throw new Error('导入后读取失败');
    touchSlot(name);
    return { name, entries: Object.keys(after.entries).length };
}
