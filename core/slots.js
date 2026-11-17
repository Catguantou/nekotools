// 存档位：列表、新建、切换、删除、快速存档/导入。
// 依赖 st_bridge 的世界书接口；档名规则与存档格式在 worldfmt.js。

import { stBridge } from './st_bridge.js';
import { settings } from './settings.js';
import { invalidateConfig } from './worldcfg.js';
import { readIndex, addChar as addIndexChar, removeChar as removeIndexChar } from './worldindex.js';
import {
    slotName,
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

function currentLayer() {
    const ctx = stBridge.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    return chat.length;
}

/** 记录这一档最后一次被使用的时间与层数（列表显示用，层号与酒馆一致） */
export function touchSlot(bookName) {
    if (!bookName) return;
    setSlotMeta(bookName, {
        lastPlayed: new Date().toISOString(),
        lastLayer: currentLayer(),
    });
}

/** 读取这一档最近一次的状态栏时钟（不写世界书，只存设置） */
export function getSlotClock(bookName) {
    if (!bookName) return null;
    const clock = readMeta()[bookName]?.clock;
    return clock && typeof clock === 'object' ? clock : null;
}

/** 保存这一档的状态栏时钟；不往世界书里写任何东西 */
export function setSlotClock(bookName, clock) {
    if (!bookName) return;
    setSlotMeta(bookName, { clock: clock || null });
}

/** 读取当前档的「索引」角色段，返回 [{ name, tier, location, action, layer, raw }] */
export async function readRoster(bookName) {
    if (!bookName) return [];
    const index = await readIndex(bookName);
    return index.chars;
}

/** 往索引角色段补一行（钉住时用） */
export async function addRosterName(bookName, name, value = 'T1') {
    return addIndexChar(bookName, name, value);
}

/** 读某个角色的六字段条目；没有返回空串 */
export async function readCharacterEntry(bookName, name) {
    if (!bookName || !name) return '';
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    const entry = book && book.entries
        ? Object.values(book.entries).find(e => e && e.comment === `角色·${name}`)
        : null;
    return entry ? String(entry.content || '') : '';
}

/** 保存某个角色的六字段条目（手动编辑）；写后复核 */
export async function saveCharacterEntry(bookName, name, content) {
    if (!bookName || !name) return false;
    const text = String(content || '');
    await stBridge.updateEntry(bookName, `角色·${name}`, text, false, [name]);
    const after = await readCharacterEntry(bookName, name);
    return after === text;
}

/** 从索引里删掉一个名字（读最新内容再删，避免覆盖 AI 刚写的内容） */
export async function removeRosterName(bookName, name) {
    if (!bookName || !name) return false;
    return removeIndexChar(bookName, name);
}

/** 删除某个角色的六字段条目（拉黑时用） */
export async function removeCharacterEntry(bookName, name) {
    if (!bookName || !name) return false;
    const book = await stBridge.loadWorldInfoAsync(bookName, true);
    if (!book || !book.entries) return false;
    let uid = null;
    for (const [key, entry] of Object.entries(book.entries)) {
        if (entry && entry.comment === `角色·${name}`) {
            uid = key;
            break;
        }
    }
    if (!uid) return false;
    delete book.entries[uid];
    await stBridge.persistLorebook(bookName, book);
    return true;
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
            progress: meta[name]?.mainProgress ?? meta[name]?.progress ?? null,
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
        progress: meta[b.name]?.mainProgress ?? meta[b.name]?.progress ?? null,
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
    notifySlotsChanged();
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
    notifySlotsChanged();
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
    invalidateConfig(target.name);

    if (wasActive) {
        const rest = stBridge.listTrackerBooksForCurrentChar();
        if (rest.length) await switchSlot(rest[rest.length - 1].slot);
    }
    notifySlotsChanged();
    return true;
}

function notifySlotsChanged() {
    try { window.dispatchEvent(new CustomEvent('nekotool:slots-changed')); } catch (_) {}
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
    // 立刻 revoke 在部分浏览器会取消下载，延后释放
    setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/** 快速存档：把当前档导成 JSON 下载；返回导出的档名 */
export async function exportCurrent() {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');
    const name = stBridge.currentTrackerName();
    if (!name) throw new Error('当前没有可导出的存档');
    // 存在性只认 /list：没有书时 /get 会返回假书 {entries:{}}
    if (!(await stBridge.bookExists(name))) throw new Error('当前档还没建，先发一条消息让追踪书写入');

    const book = await stBridge.loadWorldInfoAsync(name, true);
    if (!book || !book.entries) throw new Error('读取当前存档失败');

    // 档位按「当前角色的列表」算，不直接解析书名：
    // 角色名本身以 ·数字 结尾时，基础档也会被 parseSlotName 误判成第 N 档
    const entry = stBridge.listTrackerBooksForCurrentChar().find(b => b.name === name);
    const slot = entry ? entry.slot : 1;
    const payload = buildSaveFile({ card: charName, slot, book });
    downloadJson(`nekotool_${sanitizeWorldName(charName)}_slot${slot}_${dateStamp()}.json`, payload);
    touchSlot(name);
    return { name, slot };
}

/**
 * 快速导入：按存档里记录的档位恢复（不是覆盖当前档）。
 * 目标档已存在时先确认、自动备份，再整本覆盖；导入完切到该档。
 */
export async function importCurrent(file) {
    const charName = stBridge.getCharacterName();
    if (!charName) throw new Error('还没有选中角色卡');
    if (stBridge._batch) throw new Error('正在结算上一轮，稍后再导入');

    const text = await file.text();
    const parsed = parseSaveFile(text);
    if (parsed.card !== charName) {
        throw new Error(`这是「${parsed.card}」的存档，不能导入到当前角色`);
    }

    const targetName = slotName(charName, parsed.slot);
    const exists = await stBridge.bookExists(targetName);

    if (exists) {
        const ok = window.confirm(`第 ${parsed.slot} 档已有内容，导入会整本覆盖（会先自动备份一份）。继续？`);
        if (!ok) throw new Error('已取消导入');
        const before = await stBridge.loadWorldInfoAsync(targetName, true);
        if (before && before.entries) {
            downloadJson(
                `nekotool_backup_${sanitizeWorldName(charName)}_slot${parsed.slot}_${dateStamp()}.json`,
                buildSaveFile({ card: charName, slot: parsed.slot, book: before })
            );
        }
    } else {
        const created = await stBridge.createWorldbook(targetName);
        if (!created) throw new Error('新建目标档失败');
    }

    const wrote = await stBridge._writeBook(targetName, parsed.book);
    if (!wrote) throw new Error('写入失败（没落盘）');
    invalidateConfig(targetName);

    const after = await stBridge.loadWorldInfoAsync(targetName, true);
    if (!after || !after.entries) throw new Error('导入后读取失败');
    const want = Object.keys(parsed.book.entries).length;
    const got = Object.keys(after.entries).length;
    if (got !== want) throw new Error(`导入后条目数不对（期望 ${want}，实际 ${got}）`);

    await switchSlot(parsed.slot);
    notifySlotsChanged();
    return { name: targetName, entries: got, slot: parsed.slot };
}
