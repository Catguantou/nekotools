// 聊天输入栏的快捷入口：按钮 + 菜单 + 弹窗基建 + 存档面板。
// 只做 DOM 与交互；世界书读写都在 core/slots.js。

import {
    listSlots,
    createSlot,
    switchSlot,
    deleteSlot,
    exportCurrent,
    importCurrent,
    getSlotClock,
    getSlotLog,
    getSlotMeta,
    readRoster,
    readCharacterEntry,
    saveCharacterEntry,
    removeRosterName,
    removeCharacterEntry,
    addRosterName,
} from './slots.js';
import {
    slotLabel,
    parseStatusFields,
    parseCharacterYaml,
    normalizePlayerProfile,
    formatPlayerSummary,
} from './worldfmt.js';
import { loadConfig, saveConfig } from './worldcfg.js';
import { readMap, findPath, travelEntries } from './worldmap.js';
import { refreshChar } from './worldindex.js';
import { readMain, readQuests, readQuestHistory, clampProgress, saveMain, saveQuests } from './worldquest.js';
import { generateQuiet, getEventSource, getEventTypes } from './st_api.js';
import { applyRefreshData, buildRefreshContract, refreshIndexHeader } from '../modules/worldsim.js';
import { settings } from './settings.js';
import { stBridge } from './st_bridge.js';
import { getSecret } from './apivault.js';

const BTN_ID = 'nt-quick-btn';
const POP_ID = 'nt-quick-pop';
const MODAL_ID = 'nt-quick-modal';
const FLOAT_ID = 'nt-float-btn';

let mounted = false;
let modalCloser = null;

function $(id) {
    return document.getElementById(id);
}

function toast(msg, type = 'info') {
    try {
        if (window.toastr && typeof window.toastr[type] === 'function') {
            window.toastr[type](msg);
            return;
        }
    } catch (_) {}
    console.log('[nekotools]', msg);
}

function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ========== 时间跳跃提示 ==========

function currentJump() {
    const cfg = settings.get('worldsim');
    const jump = cfg && cfg.clockJump;
    if (!jump || typeof jump !== 'object') return null;
    // 6 小时没处理就自动过期，免得旧提示永远挂着
    if (jump.at && Date.now() - Number(jump.at) > 6 * 3600 * 1000) return null;
    const cur = stBridge.currentTrackerName();
    if (jump.book && cur && jump.book !== cur) return null;
    return jump;
}

function updateJumpUi() {
    const jump = currentJump();
    const btn = $(BTN_ID);
    if (btn) btn.classList.toggle('has-alert', Boolean(jump));
    const banner = $('nt-quick-jump');
    if (!banner) return;
    banner.hidden = !jump;
    if (jump) {
        const text = banner.querySelector('.nt-quick-jump-text');
        if (text) text.textContent = `剧情时间跳了 ${jump.days} 天，世界还没补算（第 5 期接入）`;
    }
}

function dismissJump() {
    settings.set('worldsim', { clockJump: null });
    updateJumpUi();
}

// ========== 弹窗基建 ==========

function closeModal() {
    const mask = $(MODAL_ID);
    if (mask) {
        mask.remove();
        if (typeof modalCloser === 'function') {
            const fn = modalCloser;
            modalCloser = null;
            try { fn(); } catch (_) {}
        }
        if (quickMenuEnabled()) showFloatButton();
    }
}

/**
 * 打开一个轻量弹窗。
 * body 传 Node 或字符串；footer 传 [{ label, primary, onClick }]。
 * onClick 返回 false 时保持弹窗打开（适合异步操作后原地刷新）。
 */
export function openModal({ title = '', body = null, footer = null, wide = false, onClose = null } = {}) {
    closeModal();
    hideFloatButton();

    const mask = document.createElement('div');
    mask.id = MODAL_ID;
    mask.className = 'nt-quick-modal-mask';
    mask.addEventListener('click', (e) => {
        if (e.target === mask) closeModal();
    });

    const panel = document.createElement('div');
    panel.className = 'nt-quick-modal' + (wide ? ' wide' : '');

    const head = document.createElement('div');
    head.className = 'nt-quick-modal-head';
    const titleEl = document.createElement('div');
    titleEl.className = 'nt-quick-modal-title';
    titleEl.textContent = title;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nt-quick-modal-x';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', closeModal);
    head.appendChild(titleEl);
    head.appendChild(closeBtn);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'nt-quick-modal-body';
    if (body instanceof Node) bodyEl.appendChild(body);
    else bodyEl.textContent = String(body ?? '');

    const footEl = document.createElement('div');
    footEl.className = 'nt-quick-modal-foot';
    const actions = Array.isArray(footer) && footer.length ? footer : [{ label: '关闭', primary: true }];
    for (const action of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `nt-quick-btn-text${action.primary ? ' primary' : ''}`;
        b.textContent = action.label;
        b.addEventListener('click', async () => {
            if (b.disabled) return;
            b.disabled = true;
            let keep = true;
            try {
                if (typeof action.onClick === 'function') keep = await action.onClick();
            } catch (e) {
                toast(e && e.message ? e.message : String(e), 'error');
                return;
            } finally {
                b.disabled = false;
            }
            if (keep === false) return;
            closeModal();
        });
        footEl.appendChild(b);
    }

    panel.appendChild(head);
    panel.appendChild(bodyEl);
    if (actions.length) panel.appendChild(footEl);
    mask.appendChild(panel);
    document.body.appendChild(mask);

    modalCloser = typeof onClose === 'function' ? onClose : null;
    return mask;
}

// ========== 存档面板 ==========

function pickImportFile(after) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
            const r = await importCurrent(file);
            toast(`已导入：第 ${r.slot} 档 / ${r.entries} 个条目`, 'success');
            after();
        } catch (e) {
            const msg = e && e.message ? e.message : '导入失败';
            toast(msg, msg.includes('已取消') ? 'info' : 'error');
        }
    };
    input.click();
}

function renderSlots(container) {
    container.textContent = '';
    const slots = listSlots();
    if (!slots.length) {
        container.textContent = '没有选中角色卡。';
        return;
    }

    const hint = document.createElement('div');
    hint.className = 'nt-quick-note';
    hint.textContent = '当前档 = 正在使用的那本世界书。切换后下一句话会写进新档。';
    container.appendChild(hint);

    for (const s of slots) {
        const row = document.createElement('div');
        row.className = 'nt-quick-slot' + (s.current ? ' current' : '');

        const main = document.createElement('div');
        main.className = 'nt-quick-slot-main';

        const title = document.createElement('div');
        title.className = 'nt-quick-slot-title';
        const state = s.active ? ' · 已激活' : (s.current ? ' · 当前（未激活）' : '');
        title.textContent = `${s.label}${state}${s.exists ? '' : '（未创建）'}`;

        const meta = document.createElement('div');
        meta.className = 'nt-quick-slot-meta';
        const bits = [];
        if (s.lastPlayed) bits.push(formatTime(s.lastPlayed));
        if (s.lastLayer) bits.push(`第 ${s.lastLayer} 层`);
        if (s.progress != null) bits.push(`主线 ${s.progress}%`);
        meta.textContent = bits.length ? bits.join(' · ') : '还没玩过';

        main.appendChild(title);
        main.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'nt-quick-slot-actions';

        if (s.exists && !s.active) {
            const enter = document.createElement('button');
            enter.type = 'button';
            enter.className = 'nt-quick-btn-text';
            enter.textContent = '进入';
            enter.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (enter.disabled) return;
                enter.disabled = true;
                try {
                    await switchSlot(s.n);
                    toast(`已切到${s.label}`, 'success');
                    renderSlots(container);
                } catch (err) {
                    toast(err && err.message ? err.message : '切换失败', 'error');
                } finally {
                    enter.disabled = false;
                }
            });
            actions.appendChild(enter);
        }

        if (s.exists) {
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'nt-quick-btn-text danger';
            del.textContent = '删除';
            del.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (del.disabled) return;
                if (!window.confirm(`确定删除${s.label}？这一档的进度会消失（建议先快速存档）。`)) return;
                del.disabled = true;
                try {
                    await deleteSlot(s.n);
                    toast('已删除', 'success');
                    renderSlots(container);
                } catch (err) {
                    toast(err && err.message ? err.message : '删除失败', 'error');
                } finally {
                    del.disabled = false;
                }
            });
            actions.appendChild(del);
        }

        row.appendChild(main);
        row.appendChild(actions);
        container.appendChild(row);
    }
}

function showSlotsModal() {
    const body = document.createElement('div');
    body.className = 'nt-quick-slots';
    renderSlots(body);

    openModal({
        title: '存档',
        body,
        footer: [
            {
                label: '新建存档',
                onClick: async () => {
                    try {
                        const r = await createSlot();
                        toast(`已新建${slotLabel(r.slot)}`, 'success');
                        renderSlots(body);
                    } catch (e) {
                        toast(e && e.message ? e.message : '新建失败', 'error');
                    }
                    return false;
                },
            },
            {
                label: '快速存档',
                onClick: async () => {
                    try {
                        await exportCurrent();
                        toast('已导出存档文件', 'success');
                        renderSlots(body);
                    } catch (e) {
                        toast(e && e.message ? e.message : '导出失败', 'error');
                    }
                    return false;
                },
            },
            {
                label: '快速导入',
                onClick: () => {
                    pickImportFile(() => renderSlots(body));
                    return false;
                },
            },
            { label: '关闭', primary: true },
        ],
    });
}

// ========== 菜单 ==========

function floatState() {
    const cfg = settings.get('worldsim') || {};
    const s = cfg.quickFloat || {};
    return {
        side: s.side === 'left' ? 'left' : 'right',
        top: Number(s.top) || Math.round(window.innerHeight * 0.58),
        hidden: Boolean(s.hidden),
    };
}

function saveFloatState(patch) {
    settings.set('worldsim', { quickFloat: { ...floatState(), ...patch } });
}

function applyFloatPosition(btn, state, animate = false) {
    if (!btn) return state;
    const size = btn.offsetWidth || 32;
    const visibleLeft = state.side === 'left' ? 6 : window.innerWidth - size - 6;
    const hiddenLeft = state.side === 'left' ? -(size - 18) : window.innerWidth - 18;
    const top = Math.max(60, Math.min(Number(state.top) || 300, window.innerHeight - 150));
    btn.style.left = `${state.hidden ? hiddenLeft : visibleLeft}px`;
    btn.style.top = `${top}px`;
    btn.style.transition = animate ? 'left .18s ease, top .18s ease' : 'none';
    btn.classList.toggle('nt-float-hidden', Boolean(state.hidden));
    return { ...state, top };
}

function hideFloatButton() {
    const btn = $(FLOAT_ID);
    if (btn) btn.style.display = 'none';
}

function showFloatButton() {
    const btn = $(FLOAT_ID);
    if (!btn || $(MODAL_ID)) return;
    btn.style.display = '';
    applyFloatPosition(btn, floatState());
}

function initFloatDrag(btn) {
    let drag = null;
    let suppressClickUntil = 0;
    const onMove = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        if (Math.hypot(dx, dy) > 6) drag.moved = true;
        if (!drag.moved) return;
        if (e.cancelable) e.preventDefault();
        const size = btn.offsetWidth || 32;
        const left = Math.max(-(size - 18), Math.min(window.innerWidth - 18, drag.startLeft + dx));
        const top = Math.max(60, Math.min(window.innerHeight - 150, drag.startTop + dy));
        btn.style.left = `${left}px`;
        btn.style.top = `${top}px`;
        btn.style.transition = 'none';
    };
    const onFinish = (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onFinish);
        window.removeEventListener('pointercancel', onFinish);
        btn.classList.remove('nt-dragging');
        if (!d.moved) return;
        suppressClickUntil = Date.now() + 400;
        const size = btn.offsetWidth || 32;
        const left = parseFloat(btn.style.left) || 0;
        const top = parseFloat(btn.style.top) || d.startTop;
        const side = left + size / 2 < window.innerWidth / 2 ? 'left' : 'right';
        const hidden = left <= 24 || left + size >= window.innerWidth - 24;
        saveFloatState({ side, top, hidden });
        applyFloatPosition(btn, { side, top, hidden }, true);
    };
    btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        if (drag) return;
        const st = floatState();
        drag = {
            id: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startLeft: parseFloat(btn.style.left) || 0,
            startTop: parseFloat(btn.style.top) || st.top,
            moved: false,
        };
        btn.classList.add('nt-dragging');
        try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        // 监听挂到 window：手指移出竖条、或浏览器没给 pointer capture 时也能继续拖
        window.addEventListener('pointermove', onMove, { passive: false });
        window.addEventListener('pointerup', onFinish);
        window.addEventListener('pointercancel', onFinish);
    });
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < suppressClickUntil) return;
        if (btn.classList.contains('nt-float-hidden')) {
            saveFloatState({ hidden: false });
            applyFloatPosition(btn, floatState(), true);
            return;
        }
        togglePop();
    });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('dragstart', (e) => e.preventDefault());
}

function ensureFloatButton() {
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    const existing = $(FLOAT_ID);
    if (!mobile || !quickMenuEnabled()) {
        if (existing) existing.remove();
        return;
    }
    if (existing) {
        const pop = $(POP_ID);
        const modalOpen = Boolean($(MODAL_ID));
        existing.style.display = (pop && !pop.hidden) || modalOpen ? 'none' : '';
        if (!existing.classList.contains('nt-dragging')) applyFloatPosition(existing, floatState());
        return;
    }
    const btn = document.createElement('div');
    btn.id = FLOAT_ID;
    btn.className = 'nt-float-btn';
    btn.title = 'NEKOTOOL 快捷菜单（可拖到屏幕边缘隐藏）';
    btn.textContent = 'TOOL';
    initFloatDrag(btn);
    document.body.appendChild(btn);
    applyFloatPosition(btn, floatState());
}

function closePop() {
    const pop = $(POP_ID);
    if (pop) pop.hidden = true;
    showFloatButton();
}

function updateQuickStatus() {
    const pop = $(POP_ID);
    if (!pop) return;
    const name = stBridge.currentTrackerName();
    const books = stBridge.listTrackerBooksForCurrentChar();
    const tracking = pop.querySelector('.nt-quick-status-tracking');
    if (tracking) tracking.classList.toggle('on', Boolean(name));
    const book = pop.querySelector('.nt-quick-status-book');
    if (book) book.textContent = `${books.length} ACTIVE BOOK`;
}

function placePop() {
    const btn = $(BTN_ID);
    const pop = $(POP_ID);
    if (!btn || !pop) return;
    const mobile = window.matchMedia('(max-width: 640px)').matches;
    if (mobile) {
        // 手机：接近红圈大小，但左右不铺满
        const state = floatState();
        const width = Math.min(260, window.innerWidth - 16);
        const maxHeight = Math.min(620, window.innerHeight - 24);
        const left = state.side === 'left' ? 8 : window.innerWidth - width - 8;
        pop.style.left = `${left}px`;
        pop.style.right = 'auto';
        pop.style.width = `${width}px`;
        pop.style.maxWidth = 'none';
        pop.style.top = '12px';
        pop.style.bottom = 'auto';
        pop.style.maxHeight = `${maxHeight}px`;
        pop.style.overflowY = 'auto';
        return;
    }
    pop.style.top = '';
    pop.style.right = '';
    pop.style.width = '';
    pop.style.maxWidth = '';
    pop.style.maxHeight = '';
    pop.style.overflowY = '';
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth || 230;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    pop.style.left = left + 'px';
    pop.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + 'px';
}

function openPop() {
    const pop = $(POP_ID);
    if (!pop) return;
    // 开关变化不重建菜单：每次打开时按当前设置刷新两个入口的显隐
    try { applyPlayerMenuFlags(pop); } catch (err) { console.warn('[nekotools] 刷新玩家菜单项失败', err); }
    if (window.matchMedia('(max-width: 640px)').matches) {
        try { document.activeElement?.blur(); } catch (_) {}
    }
    // 先显示，再刷新内容；任何刷新异常都不能导致菜单打不开
    pop.hidden = false;
    try { updateJumpUi(); } catch (err) { console.warn('[nekotools] 刷新跳时提示失败', err); }
    try { updateClockUi(); } catch (err) { console.warn('[nekotools] 刷新时钟失败', err); }
    try { updateQuickStatus(); } catch (err) { console.warn('[nekotools] 刷新追踪状态失败', err); }
    try { placePop(); } catch (err) { console.warn('[nekotools] 计算菜单位置失败', err); }
    hideFloatButton();
}

function togglePop() {
    let pop = $(POP_ID);
    if (!pop) {
        buildPop();
        pop = $(POP_ID);
    }
    if (!pop) return;
    if (pop.hidden) openPop();
    else closePop();
}

function showSoon(label) {
    toast(`${label}：后续版本接入`);
}

function readClock() {
    // 优先读最后一条 AI 消息里的状态栏（最实时）；读不到再用存下来的
    const chat = stBridge.getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user) continue;
        const text = String(msg.mes || '');
        const idx = text.indexOf('[[NT_STATUS]]');
        if (idx === -1) continue;
        const line = text.slice(idx + '[[NT_STATUS]]'.length).split('\n')[0];
        const fields = parseStatusFields(line);
        if (fields && (fields.time || fields.place)) return { ...fields, layer: i + 1 };
    }

    const name = stBridge.currentTrackerName();
    const stored = name ? getSlotClock(name) : null;
    return stored && (stored.time || stored.place) ? stored : null;
}

function showClockModal() {
    const clock = readClock();

    const body = document.createElement('div');
    if (!clock || !(clock.time || clock.place)) {
        body.textContent = '还没有时钟。发一条消息，等模型输出状态栏后会自动记录。';
        openModal({ title: '世界时钟', body });
        return;
    }

    const rows = [
        ['时间', clock.time],
        ['地点', clock.place],
        ['天气', clock.weather],
        ['温度', clock.temperature],
        ['最后更新', clock.layer ? `第 ${clock.layer} 层` : ''],
    ];
    for (const [label, value] of rows) {
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'nt-quick-clock-row';
        const l = document.createElement('span');
        l.className = 'nt-quick-clock-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'nt-quick-clock-value';
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        body.appendChild(row);
    }
    openModal({ title: '世界时钟', body });
}

function updateClockUi() {
    const hint = document.querySelector('#nt-quick-pop .nt-quick-item[data-key="clock"] .nt-quick-item-hint');
    if (!hint) return;
    const clock = readClock();
    hint.textContent = clock && (clock.time || clock.place)
        ? `${clock.time || '—'} · ${clock.place || '—'}`
        : '还没有时钟';
}

// ========== 新闻日报 ==========

function parseNewsLines(content) {
    const rows = [];
    let section = '';
    for (const raw of String(content || '').split('\n')) {
        const line = raw.trim();
        if (line === '【新闻日报】' || line === '【社会新闻】' || line === '【以下为新闻日报】') { section = 'news'; continue; }
        if (line.startsWith('【') && line !== '【新闻日报】' && line !== '【社会新闻】' && line !== '【以下为新闻日报】') { section = ''; continue; }
        if (line.startsWith('【以下为')) { section = ''; continue; }
        if (section !== 'news') continue;
        const m = line.match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
        if (m) rows.push({ title: m[1].trim(), value: m[2].trim() });
    }
    return rows;
}

async function readNews(book) {
    const data = await stBridge.loadWorldInfoAsync(book);
    if (!data || !data.entries) return [];
    const entries = Object.values(data.entries);
    const direct = entries.find(e => e && (e.comment === '新闻日报' || e.comment === '社会新闻'));
    if (direct) {
        const rows = [];
        for (const line of String(direct.content || '').split('\n')) {
            const m = line.trim().match(/^-\s*([^｜|]+)[｜|]([\s\S]*)$/);
            if (m) rows.push({ title: m[1].trim(), value: m[2].trim() });
        }
        return rows;
    }
    const old = entries.find(e => e && e.comment === '世界局势');
    return old ? parseNewsLines(old.content) : [];
}

function showNewsModal() {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const clock = readClock();
    readNews(book).then(rows => {
        const body = document.createElement('div');
        body.className = 'nt-news';
        const head = document.createElement('div');
        head.className = 'nt-news-head';
        head.textContent = clock && clock.time ? `${clock.time} · 新闻日报` : '新闻日报';
        body.appendChild(head);
        if (!rows.length) {
            const note = document.createElement('div');
            note.className = 'nt-quick-note';
            note.textContent = '还没有新闻。世界 tick 后会写进「新闻日报」条目。';
            body.appendChild(note);
            openModal({ title: '新闻日报', body, wide: true, footer: [{ label: '关闭', primary: true }] });
            return;
        }
        for (const row of rows.slice(-20).reverse()) {
            const card = document.createElement('div');
            card.className = 'nt-news-card';
            const title = document.createElement('div');
            title.className = 'nt-news-title';
            title.textContent = row.title;
            const meta = document.createElement('div');
            meta.className = 'nt-news-meta';
            meta.textContent = row.value;
            card.appendChild(title);
            card.appendChild(meta);
            body.appendChild(card);
        }
        openModal({ title: '新闻日报', body, wide: true, footer: [{ label: '关闭', primary: true }] });
    }).catch(e => {
        console.warn('[nekotools] 新闻日报读取失败', e);
        toast('新闻日报读取失败', 'error');
    });
}

// ========== 世界日志 ==========

function showWorldLogModal() {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const body = document.createElement('div');
    body.className = 'nt-world-log';
    const rows = getSlotLog(book);
    if (!rows.length) {
        body.textContent = '还没有世界变化记录。发一轮消息后，插件会把角色/国家/支线变化记在这里。';
        openModal({ title: '世界日志', body });
        return;
    }
    for (const row of rows.slice().reverse()) {
        const line = document.createElement('div');
        line.className = 'nt-world-log-row';
        const time = new Date(row.at || Date.now()).toLocaleString('zh-CN', { hour12: false });
        const meta = document.createElement('span');
        meta.className = 'nt-world-log-meta';
        meta.textContent = `${time} · 第 ${row.layer || '?'} 层`;
        const text = document.createElement('span');
        text.className = 'nt-world-log-text';
        text.textContent = row.text;
        line.appendChild(meta);
        line.appendChild(text);
        body.appendChild(line);
    }
    openModal({ title: '世界日志', body });
}

// ========== 角色管理 ==========

const CHAR_FIELD_ORDER = ['姓名', '性别', '外貌', '身份', '位置', '心情', '日程', '当前行动', '下一步', '长期目标', '近期打算', '状态', '后台运行', '关键记忆', '特殊变化', '人际关系', '已知', '秘密', '更新于'];

function currentLayerNo() {
    const chat = stBridge.getContext().chat || [];
    return chat.length;
}

function charAge(item) {
    if (!item.layer) return '';
    const age = Math.max(0, currentLayerNo() - item.layer);
    return age === 0 ? '本层更新' : `${age} 层前`;
}

function charFields(content) {
    const parsed = parseCharacterYaml(content);
    return Object.entries(parsed)
        .filter(([key]) => key !== '日程')
        .map(([key, value]) => {
            let text;
            if (Array.isArray(value)) text = value.join('\n');
            else if (value && typeof value === 'object') {
                text = Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n');
            } else text = String(value ?? '');
            return { key, value: text };
        });
}

function activeTrackerBookName() {
    try {
        const active = stBridge.getGloballyActivatedWorlds() || [];
        for (let i = active.length - 1; i >= 0; i--) {
            if (stBridge.isTrackerBook(active[i])) return active[i];
        }
    } catch (_) {}
    return stBridge.currentTrackerName();
}

async function showRosterModal(preselectName = '') {
    let book = activeTrackerBookName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }

    const body = document.createElement('div');
    body.className = 'nt-quick-chars-wrap';

    const headerEl = document.createElement('div');
    headerEl.className = 'nt-quick-roster-head';
    const headerText = document.createElement('span');
    headerText.className = 'nt-quick-roster-text';
    headerEl.appendChild(headerText);
    body.appendChild(headerEl);

    const cols = document.createElement('div');
    cols.className = 'nt-quick-chars';
    const left = document.createElement('div');
    left.className = 'nt-quick-chars-left';
    const right = document.createElement('div');
    right.className = 'nt-quick-chars-right';
    cols.appendChild(left);
    cols.appendChild(right);
    body.appendChild(cols);

    let list = [];
    let cfg = { pinned: [], blocked: [] };
    let selected = '';
    let editing = false;
    let detailTab = 'archive';
    let rosterQuery = '';
    let rosterFilter = 'all';
    let renderSeq = 0;
    let clockNow = readClock();
    let mapData = await readMap(book);

    const updateHeader = () => {
        const place = clockNow && clockNow.place ? clockNow.place : '未知地点';
        const time = clockNow && clockNow.time ? clockNow.time : '未知时间';
        headerText.textContent = `第 ${currentLayerNo()} 层 · ${place} · ${time}`;
    };
    updateHeader();

    const graphBtn = document.createElement('button');
    graphBtn.type = 'button';
    graphBtn.className = 'nt-quick-btn-text';
    graphBtn.textContent = '关系网';
    graphBtn.style.marginLeft = 'auto';
    graphBtn.addEventListener('click', () => showRelationshipModal(book));
    headerEl.appendChild(graphBtn);

    let rosterPoll = null;
    openModal({
        title: '角色管理',
        body,
        wide: true,
        footer: [{ label: '关闭', primary: true }],
        onClose: () => { if (rosterPoll) clearInterval(rosterPoll); },
    });

    const refresh = async () => {
        cfg = await loadConfig(book, { force: true });
        clockNow = readClock();
        mapData = await readMap(book);
        updateHeader();
        list = await readRoster(book);
        if (!selected || !list.some(x => x.name === selected)) selected = list[0] ? list[0].name : '';
        if (preselectName && list.some(x => x.name === preselectName)) selected = preselectName;
        editing = false;
        renderList();
        await renderDetail();
    };

    const togglePin = async (name) => {
        const pinned = cfg.pinned.includes(name)
            ? cfg.pinned.filter(n => n !== name)
            : [...cfg.pinned, name];
        const saved = await saveConfig(book, { pinned });
        if (!saved) {
            toast('保存失败：追踪书可能已被删除', 'error');
            return;
        }
        cfg = saved;

        // 新钉住但索引里没有：补一行；钉住 = 关注，自动升到 T1
        if (pinned.includes(name)) {
            if (!list.some(x => x.name === name)) {
                await addRosterName(book, name, `T1｜第 ${currentLayerNo()} 层`);
            }
            await refreshChar(book, name, { tier: 'T1', layer: currentLayerNo() });
            list = await readRoster(book);
        } else if (list.some(x => x.name === name)) {
            // 取消钉住：自动降到 T2，不再是每轮必更新的 T1
            await refreshChar(book, name, { tier: 'T2' });
            list = await readRoster(book);
        }
        renderList();
        await renderDetail();
    };

    const blockChar = async (name) => {
        if (!window.confirm(`把「${name}」加入黑名单？之后不再记录它、从索引移除，并删掉它的档案。`)) return;
        const saved = await saveConfig(book, {
            blocked: [...new Set([...cfg.blocked, name])],
            pinned: cfg.pinned.filter(n => n !== name),
        });
        if (!saved) {
            toast('保存失败：追踪书可能已被删除', 'error');
            return;
        }
        cfg = saved;
        // 读最新索引再删，别用打开面板时的旧快照覆盖 AI 刚写的人
        await removeRosterName(book, name);
        await removeCharacterEntry(book, name);
        list = await readRoster(book);
        selected = list[0] ? list[0].name : '';
        renderList();
        await renderDetail();
    };

    const unblock = async (name) => {
        const saved = await saveConfig(book, { blocked: cfg.blocked.filter(n => n !== name) });
        if (!saved) {
            toast('保存失败：追踪书可能已被删除', 'error');
            return;
        }
        cfg = saved;
        renderList();
    };

    function renderList() {
        left.textContent = '';
        const curSite = (findPath(mapData, (clockNow && clockNow.place) || '').site) || (clockNow && clockNow.place) || '';
        const q = rosterQuery.trim().toLowerCase();
        const visible = list.filter(item => {
            if (q && !item.name.toLowerCase().includes(q)) return false;
            if (rosterFilter === 'here' && charPlace(mapData, item) !== curSite) return false;
            if (rosterFilter === 'pinned' && !cfg.pinned.includes(item.name)) return false;
            return true;
        });
        const head = document.createElement('div');
        head.className = 'nt-quick-chars-head';
        head.textContent = `角色 ${visible.length}/${list.length}`;
        left.appendChild(head);

        const search = document.createElement('input');
        search.className = 'nt-quick-input nt-quick-char-search';
        search.placeholder = '搜索名字';
        search.value = rosterQuery;
        search.addEventListener('change', () => { rosterQuery = search.value; renderList(); });
        left.appendChild(search);

        const filters = document.createElement('div');
        filters.className = 'nt-quick-char-filters';
        for (const [key, label] of [['here', '在场'], ['pinned', '关注'], ['all', '全部']]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nt-quick-btn-text' + (rosterFilter === key ? ' primary' : '');
            b.textContent = label;
            b.addEventListener('click', () => { rosterFilter = key; renderList(); });
            filters.appendChild(b);
        }
        left.appendChild(filters);

        // 手动钉住/拉黑一个还没进索引的名字
        const addRow = document.createElement('div');
        addRow.className = 'nt-quick-chars-add';
        const nameInput = document.createElement('input');
        nameInput.className = 'nt-quick-input';
        nameInput.placeholder = '名字';
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'nt-quick-btn-text';
        pinBtn.textContent = '钉住';
        pinBtn.addEventListener('click', async () => {
            const n = nameInput.value.trim();
            if (!n) return;
            nameInput.value = '';
            await togglePin(n);
        });
        const blockBtn = document.createElement('button');
        blockBtn.type = 'button';
        blockBtn.className = 'nt-quick-btn-text danger';
        blockBtn.textContent = '拉黑';
        blockBtn.addEventListener('click', async () => {
            const n = nameInput.value.trim();
            if (!n) return;
            nameInput.value = '';
            await blockChar(n);
        });
        addRow.appendChild(nameInput);
        addRow.appendChild(pinBtn);
        addRow.appendChild(blockBtn);
        left.appendChild(addRow);

        for (const item of visible) {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'nt-quick-char-row' + (item.name === selected ? ' active' : '');

            const star = document.createElement('span');
            const pinned = cfg.pinned.includes(item.name);
            star.className = 'nt-quick-char-star' + (pinned ? ' pinned' : '');
            star.textContent = pinned ? '★' : '☆';
            star.title = pinned ? '取消钉住' : '钉住（长期关注）';
            star.addEventListener('click', async (e) => {
                e.stopPropagation();
                await togglePin(item.name);
            });

            const main = document.createElement('span');
            main.className = 'nt-quick-char-main';
            const name = document.createElement('span');
            name.className = 'nt-quick-char-name';
            name.textContent = item.name;
            const meta = document.createElement('span');
            meta.className = 'nt-quick-char-meta';
            const curSite = (findPath(mapData, (clockNow && clockNow.place) || '').site) || (clockNow && clockNow.place) || '';
            const here = curSite && charPlace(mapData, item) === curSite ? '在场' : '';
            meta.textContent = [here, item.tier, item.location, charAge(item)].filter(Boolean).join(' · ');
            main.appendChild(name);
            main.appendChild(meta);

            row.appendChild(star);
            row.appendChild(main);
            row.addEventListener('click', () => {
                selected = item.name;
                editing = false;
                renderList();
                renderDetail();
            });
            left.appendChild(row);
        }

        if (cfg.blocked.length) {
            const head2 = document.createElement('div');
            head2.className = 'nt-quick-chars-head';
            head2.textContent = `黑名单 ${cfg.blocked.length}`;
            left.appendChild(head2);
            for (const name of cfg.blocked) {
                const row = document.createElement('div');
                row.className = 'nt-quick-char-row blocked';
                const main = document.createElement('span');
                main.className = 'nt-quick-char-main';
                const n = document.createElement('span');
                n.className = 'nt-quick-char-name';
                n.textContent = name;
                main.appendChild(n);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'nt-quick-btn-text';
                btn.textContent = '解除';
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await unblock(name);
                });
                row.appendChild(main);
                row.appendChild(btn);
                left.appendChild(row);
            }
        }
    }

    async function renderDetail() {
        const seq = ++renderSeq;
        right.textContent = '';
        const item = list.find(x => x.name === selected);
        if (!item) {
            const note = document.createElement('div');
            note.className = 'nt-quick-note';
            note.textContent = '还没有角色。发几轮消息，模型会按 P_10 契约自己写；也可以先钉住一个名字。';
            right.appendChild(note);
            return;
        }

        const model = await readCharacterEntry(book, item.name);
        if (seq !== renderSeq) return;

        const title = document.createElement('div');
        title.className = 'nt-quick-char-detail-title';
        title.textContent = `${item.name}${item.tier ? ` · ${item.tier}` : ''}`;
        right.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'nt-quick-char-detail-meta';
        meta.textContent = [
            item.location ? `位置：${item.location}${clockNow && clockNow.place === item.location ? '（在场）' : ''}` : '',
            item.action ? `最近行动：${item.action}` : '',
            item.layer ? `最后更新：第 ${item.layer} 层（${charAge(item)}）` : '',
        ].filter(Boolean).join('\n');
        meta.style.whiteSpace = 'pre-line';
        right.appendChild(meta);

        const actions = document.createElement('div');
        actions.className = 'nt-quick-char-actions';
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'nt-quick-btn-text';
        pin.textContent = cfg.pinned.includes(item.name) ? '取消钉住' : '钉住';
        pin.addEventListener('click', () => togglePin(item.name));
        const block = document.createElement('button');
        block.type = 'button';
        block.className = 'nt-quick-btn-text danger';
        block.textContent = '拉黑';
        block.addEventListener('click', () => blockChar(item.name));

        const tierSel = document.createElement('select');
        tierSel.className = 'nt-edit-select nt-quick-tier-select';
        for (const t of ['T1', 'T2', 'T3', 'T4']) {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            tierSel.appendChild(opt);
        }
        tierSel.value = (String(item.tier || 'T3').match(/T[1-4]/i) || ['T3'])[0].toUpperCase();
        tierSel.addEventListener('change', async () => {
            await refreshChar(book, item.name, { tier: tierSel.value });
            list = await readRoster(book);
            renderList();
            await renderDetail();
        });

        const update = document.createElement('button');
        update.type = 'button';
        update.className = 'nt-quick-btn-text';
        update.textContent = '请求更新';
        update.addEventListener('click', () => showRefreshModal(item.name).catch(err => toast(`打开请求更新失败：${err && err.message ? err.message : err}`, 'error')));

        actions.appendChild(pin);
        actions.appendChild(block);
        actions.appendChild(tierSel);
        actions.appendChild(update);
        right.appendChild(actions);

        if (editing) {
            const ta = document.createElement('textarea');
            ta.className = 'nt-prompt-textarea nt-quick-char-edit';
            ta.value = model;
            right.appendChild(ta);

            const save = document.createElement('button');
            save.type = 'button';
            save.className = 'nt-quick-btn-text primary';
            save.textContent = '保存';
            save.addEventListener('click', async () => {
                await saveCharacterEntry(book, item.name, ta.value);
                toast('角色档案已保存', 'success');
                editing = false;
                renderDetail();
            });
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'nt-quick-btn-text';
            cancel.textContent = '取消';
            cancel.addEventListener('click', () => { editing = false; renderDetail(); });

            const bar = document.createElement('div');
            bar.className = 'nt-quick-char-actions';
            bar.appendChild(save);
            bar.appendChild(cancel);
            right.appendChild(bar);
            return;
        }

        const fields = charFields(model);
        const tabs = [
            { key: 'archive', label: '档案', fields: ['姓名', '性别', '年龄', '外貌', '身份', '长期目标'] },
            { key: 'now', label: '当下', fields: ['位置', '心情', '状态', '当前行动', '下一步', '特殊变化', '更新于'] },
            { key: 'backstage', label: '幕后', fields: ['后台运行', '日程', '近期打算', '最近变化'] },
            { key: 'memory', label: '认知', fields: ['关键记忆', '已知', '秘密'] },
            { key: 'relations', label: '关系', fields: ['人际关系'] },
        ];
        if (!tabs.some(t => t.key === detailTab)) detailTab = 'archive';
        const tabBar = document.createElement('div');
        tabBar.className = 'nt-char-tabs';
        for (const tab of tabs) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nt-char-tab' + (detailTab === tab.key ? ' active' : '');
            b.textContent = tab.label;
            b.addEventListener('click', () => { detailTab = tab.key; renderDetail(); });
            tabBar.appendChild(b);
        }
        right.appendChild(tabBar);

        if (!fields.length) {
            const note = document.createElement('div');
            note.className = 'nt-quick-note';
            note.textContent = '这个角色还没有档案。等模型在 ws_update 里写 chars，或者点下面的「编辑档案」自己填。';
            right.appendChild(note);
        } else {
            const active = tabs.find(t => t.key === detailTab) || tabs[0];
            const known = new Set(tabs.flatMap(t => t.fields));
            const wanted = new Set(active.fields);
            const visible = fields.filter(f => detailTab === 'archive' && !known.has(f.key) ? true : wanted.has(f.key));
            const ordered = [...visible].sort((a, b) => {
                const ia = CHAR_FIELD_ORDER.indexOf(a.key);
                const ib = CHAR_FIELD_ORDER.indexOf(b.key);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
            if (!ordered.length) {
                const note = document.createElement('div');
                note.className = 'nt-quick-note';
                note.textContent = active.key === 'relations' ? '暂无记录的人际关系。' : '这一页暂无内容。';
                right.appendChild(note);
            } else {
                for (const f of ordered) {
                    const row = document.createElement('div');
                    row.className = 'nt-quick-char-field';
                    if (f.key) {
                        const k = document.createElement('div');
                        k.className = 'nt-quick-char-field-key';
                        k.textContent = f.key;
                        row.appendChild(k);
                    }
                    const v = document.createElement('div');
                    v.className = 'nt-quick-char-field-value';
                    v.textContent = f.value;
                    row.appendChild(v);
                    right.appendChild(row);
                }
            }
            if (active.key === 'relations') {
                const graph = document.createElement('button');
                graph.type = 'button';
                graph.className = 'nt-quick-btn-text';
                graph.textContent = '打开关系网';
                graph.addEventListener('click', () => showRelationshipModal(book));
                const bar = document.createElement('div');
                bar.className = 'nt-quick-char-actions';
                bar.appendChild(graph);
                right.appendChild(bar);
            }
        }

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'nt-quick-btn-text';
        edit.textContent = '编辑档案';
        edit.addEventListener('click', () => { editing = true; renderDetail(); });
        const bar = document.createElement('div');
        bar.className = 'nt-quick-char-actions';
        bar.appendChild(edit);
        right.appendChild(bar);
    }

    rosterPoll = setInterval(async () => {
        if (!$(MODAL_ID)) {
            if (rosterPoll) clearInterval(rosterPoll);
            rosterPoll = null;
            return;
        }
        const next = activeTrackerBookName();
        if (next && next !== book) {
            book = next;
            selected = '';
            try { await refresh(); } catch (e) { console.warn('[nekotools] 角色面板跟随世界书失败', e); }
        }
    }, 1200);

    await refresh();
}

// ========== 角色关系网 ==========

function relationValue(text) {
    const s = String(text || '');
    const good = Number((s.match(/好感\s*(\d+)/) || [])[1]);
    const trust = Number((s.match(/信任\s*(\d+)/) || [])[1]);
    if (Number.isFinite(good) || Number.isFinite(trust)) return Math.max(good || 0, trust || 0);
    return 50;
}

async function showRelationshipModal(book) {
    if (!book) return;
    const data = await stBridge.loadWorldInfoAsync(book);
    if (!data || !data.entries) {
        toast('追踪书读取失败', 'error');
        return;
    }
    const roster = await readRoster(book);
    const tierOfName = new Map(roster.map(c => [c.name, c.tier]));
    const chars = Object.values(data.entries)
        .filter(e => e && e.comment && e.comment.startsWith('角色·'))
        .map(e => ({
            name: e.comment.slice(3),
            yaml: parseCharacterYaml(e.content),
        }))
        .slice(0, 18);
    const names = new Set(chars.map(c => c.name));

    const body = document.createElement('div');
    body.className = 'nt-rel-graph-wrap';
    const note = document.createElement('div');
    note.className = 'nt-map-note';
    note.textContent = '连线来自角色档案的人际关系；点节点回到角色管理。只读，不写书、不调用模型。';
    body.appendChild(note);
    if (!chars.length) {
        body.appendChild(noteLine('还没有角色档案。'));
        openModal({ title: '角色关系网', body, wide: true, footer: [{ label: '关闭', primary: true }] });
        return;
    }

    const graph = document.createElement('div');
    graph.className = 'nt-rel-graph';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'nt-rel-links');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    graph.appendChild(svg);
    const nodes = document.createElement('div');
    nodes.className = 'nt-rel-nodes';
    graph.appendChild(nodes);

    const cx = 50;
    const cy = 48;
    const radius = chars.length === 1 ? 0 : 34;
    const pos = new Map();
    chars.forEach((c, i) => {
        const angle = chars.length === 1 ? 0 : (Math.PI * 2 * i / chars.length) - Math.PI / 2;
        pos.set(c.name, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
    });

    const seen = new Set();
    let edgeCount = 0;
    for (const c of chars) {
        const rel = c.yaml['人际关系'];
        if (!rel || typeof rel !== 'object') continue;
        for (const [target, value] of Object.entries(rel)) {
            if (!names.has(target) || target === c.name) continue;
            const key = [c.name, target].sort().join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            const a = pos.get(c.name);
            const b = pos.get(target);
            if (!a || !b) continue;
            const score = relationValue(value);
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', a.x);
            line.setAttribute('y1', a.y);
            line.setAttribute('x2', b.x);
            line.setAttribute('y2', b.y);
            line.setAttribute('stroke-opacity', String(0.2 + Math.min(0.65, score / 160)));
            line.setAttribute('stroke-width', score >= 60 ? '0.45' : '0.3');
            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = `${c.name} → ${target}：${String(value)}`;
            line.appendChild(title);
            svg.appendChild(line);
            edgeCount++;
        }
    }

    for (const c of chars) {
        const p = pos.get(c.name);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nt-rel-node';
        btn.style.left = `${p.x}%`;
        btn.style.top = `${p.y}%`;
        btn.title = `${c.name}${tierOfName.get(c.name) ? ` · ${tierOfName.get(c.name)}` : ''}`;
        const nameEl = document.createElement('span');
        nameEl.className = 'nt-rel-node-name';
        nameEl.textContent = c.name;
        const meta = document.createElement('span');
        meta.className = 'nt-rel-node-meta';
        meta.textContent = [tierOfName.get(c.name), c.yaml['身份'], c.yaml['位置']].filter(Boolean).join(' · ');
        btn.appendChild(nameEl);
        btn.appendChild(meta);
        btn.addEventListener('click', () => showRosterModal(c.name).catch(err => toast(`打开角色详情失败：${err && err.message ? err.message : err}`, 'error')));
        nodes.appendChild(btn);
    }

    body.appendChild(graph);
    if (!edgeCount) {
        const empty = noteLine('还没有记录到人际关系。等角色档案出现「人际关系」后再来看。');
        body.appendChild(empty);
    }
    openModal({ title: '角色关系网', body, wide: true, footer: [{ label: '关闭', primary: true }] });
}

function noteLine(text) {
    const note = document.createElement('div');
    note.className = 'nt-quick-note';
    note.textContent = text;
    return note;
}

// ========== 快捷行动 ==========

async function sendUserText(text) {
    // 必须走酒馆输入框 + 发送按钮：/send 只插消息、不触发 AI 生成
    const ta = document.getElementById('send_textarea');
    const btn = document.getElementById('send_but');
    if (!ta || !btn) return false;

    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    // 等酒馆把发送按钮从隐藏状态切回来
    await new Promise(r => setTimeout(r, 40));

    if (btn.classList.contains('displayNone')) {
        ta.focus();
        return false;
    }
    btn.click();
    return true;
}

async function sendContinue() {
    const ctx = stBridge.getContext();
    const chat = Array.isArray(ctx.chat) ? ctx.chat : [];
    const last = chat[chat.length - 1];
    if (last && last.is_user) {
        toast('最后一条是你的消息，先等回复再续写', 'warning');
        return false;
    }

    // 直接点酒馆的「继续」按钮；它才会走完整生成流程
    const btn = document.getElementById('mes_continue');
    if (!btn || btn.classList.contains('displayNone')) return false;
    btn.click();
    return true;
}

function actionRow(label, control) {
    const row = document.createElement('div');
    row.className = 'nt-quick-form-row';
    const l = document.createElement('span');
    l.className = 'nt-quick-form-label';
    l.textContent = label;
    row.appendChild(l);
    row.appendChild(control);
    return row;
}

async function showActionModal() {
    const book = stBridge.currentTrackerName();
    const list = book ? await readRoster(book) : [];

    const body = document.createElement('div');
    body.className = 'nt-quick-action';

    const target = document.createElement('select');
    target.className = 'nt-quick-input';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（不指定）';
    target.appendChild(none);
    for (const item of list) {
        const opt = document.createElement('option');
        opt.value = item.name;
        opt.textContent = item.name;
        target.appendChild(opt);
    }

    const action = document.createElement('input');
    action.className = 'nt-quick-input';
    action.placeholder = '干什么（可留空）';

    const place = document.createElement('input');
    place.className = 'nt-quick-input';
    place.placeholder = '去哪里（可留空）';

    const jump = document.createElement('input');
    jump.type = 'number';
    jump.min = '0';
    jump.className = 'nt-quick-input nt-quick-jump-num';
    jump.placeholder = '0';

    const unit = document.createElement('select');
    unit.className = 'nt-quick-input nt-quick-jump-unit';
    for (const u of ['小时', '天', '个月', '年']) {
        const opt = document.createElement('option');
        opt.value = u;
        opt.textContent = u;
        unit.appendChild(opt);
    }

    const jumpWrap = document.createElement('div');
    jumpWrap.className = 'nt-quick-jump-wrap';
    jumpWrap.appendChild(jump);
    jumpWrap.appendChild(unit);

    body.appendChild(actionRow('对象', target));
    body.appendChild(actionRow('动作', action));
    body.appendChild(actionRow('地点', place));
    body.appendChild(actionRow('时间跳跃', jumpWrap));

    const hint = document.createElement('div');
    hint.className = 'nt-quick-note';
    hint.textContent = '执行会把拼好的话直接发出去（一次正常请求）；续写等于点「继续」。';
    body.appendChild(hint);

    const compose = () => {
        const parts = [];
        const jv = Number(jump.value) || 0;
        if (jv > 0) parts.push(`（时间跳到 ${jv} ${unit.value}后）`);
        if (target.value) parts.push(`我去找${target.value}。`);
        if (action.value.trim()) parts.push(`${action.value.trim()}。`);
        if (place.value.trim()) parts.push(`前往${place.value.trim()}。`);
        return parts.join(' ');
    };

    openModal({
        title: '快捷行动',
        body,
        footer: [
            {
                label: '执行',
                primary: true,
                onClick: async () => {
                    const text = compose();
                    if (!text) {
                        toast('至少填一项再执行', 'warning');
                        return false;
                    }
                    const ok = await sendUserText(text);
                    toast(ok ? '已发送' : '发送失败，检查酒馆输入框', ok ? 'success' : 'error');
                    return ok;
                },
            },
            {
                label: '续写',
                onClick: async () => {
                    const ok = await sendContinue();
                    toast(ok ? '已续写' : '当前没有可续写的内容', ok ? 'success' : 'warning');
                    return ok;
                },
            },
        ],
    });
}

const MAP_DIR_POS = {
    '北': [50, 30], '东北': [70, 36], '东': [80, 52], '东南': [70, 68],
    '南': [50, 74], '西南': [30, 68], '西': [20, 52], '西北': [30, 36], '中': [50, 52],
};
const MAP_DIR_RING = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

function normalizeDirection(value) {
    const s = String(value || '').trim();
    if (!s) return '';
    if (s === '中央') return '中';
    if (/^(东北|西北|东南|西南|北|南|东|西|中)$/.test(s)) return s;
    if (/东北/.test(s)) return '东北';
    if (/西北/.test(s)) return '西北';
    if (/东南/.test(s)) return '东南';
    if (/西南/.test(s)) return '西南';
    if (/北/.test(s)) return '北';
    if (/南/.test(s)) return '南';
    if (/东/.test(s)) return '东';
    if (/西/.test(s)) return '西';
    if (/中/.test(s)) return '中';
    return '';
}

function mapHash(text) {
    let h = 0;
    for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) | 0;
    return Math.abs(h);
}

function mapInferDirection(place) {
    const text = `${place && place.direction ? place.direction : ''} ${place && place.desc ? place.desc : ''} ${place && place.type ? place.type : ''}`;
    if (/东北/.test(text)) return '东北';
    if (/西北/.test(text)) return '西北';
    if (/东南/.test(text)) return '东南';
    if (/西南/.test(text)) return '西南';
    if (/北/.test(text)) return '北';
    if (/南/.test(text)) return '南';
    if (/东/.test(text)) return '东';
    if (/西/.test(text)) return '西';
    if (/中|中央/.test(text)) return '中';
    return '';
}

function mapNodePosition(place, name, index) {
    let dir = normalizeDirection(place && place.direction) || mapInferDirection(place);
    if (!dir) dir = MAP_DIR_RING[index % MAP_DIR_RING.length];
    const base = MAP_DIR_POS[dir] || [50, 52];
    const h = mapHash(name);
    const jx = ((h % 7) - 3) * 1.4;
    const jy = (((h >> 4) % 7) - 3) * 1.3;
    return {
        dir,
        x: Math.max(9, Math.min(91, base[0] + jx)),
        y: Math.max(20, Math.min(84, base[1] + jy)),
    };
}

/** 角色实际所在地：兼容 location 写成「T1核心」、真实地点写在 action 里的情况 */
function charPlace(data, c) {
    for (const text of [c && c.location, c && c.action]) {
        const value = String(text || '').trim();
        if (!value) continue;
        const p = findPath(data, value);
        if (p && p.site && data.sites && data.sites[p.site]) return p.site;
    }
    return String((c && c.location) || '').trim();
}

function currentMapPath(data) {    const parts = String(data.current || '').split('｜').map(s => s.trim()).filter(Boolean);
    const valid = (p) => p && (
        (p.site && data.sites && data.sites[p.site])
        || (p.city && data.cities && data.cities[p.city])
        || (p.region && data.regions && data.regions[p.region])
    );
    for (const part of parts) {
        const p = findPath(data, part);
        if (valid(p)) return { region: p.region, city: p.city, site: p.site };
    }
    if (parts.length) {
        const p = findPath(data, parts[0]);
        if (valid(p)) return { region: p.region, city: p.city, site: p.site };
    }
    return { region: '', city: '', site: '' };
}

function mapIcon(type, name) {
    const t = `${type || ''}${name || ''}`;
    if (/酒馆|酒吧|旅店|客栈|食堂/.test(t)) return '▣';
    if (/市场|集市|商店|商会|摊|货/.test(t)) return '◈';
    if (/王宫|城堡|宫殿|神殿|教会|教堂/.test(t)) return '⬢';
    if (/城门|要塞|军营|兵营|哨/.test(t)) return '⬡';
    if (/森林|野外|山|草原|海|河|湖|港|码头|沙漠/.test(t)) return '△';
    if (/贫民|街区|街道|小巷|后巷|巷/.test(t)) return '▤';
    if (/图书馆|学院|学校|书/.test(t)) return '▥';
    if (/广场|喷泉|公园/.test(t)) return '◉';
    if (/城市|都城|港城|镇/.test(t)) return '⬡';
    if (/区域|王国|帝国|国家|地区|大陆/.test(t)) return '◇';
    if (/宅|家|房间|客房|屋/.test(t)) return '▢';
    return '◌';
}

function mapTone(type, name) {
    const t = `${type || ''}${name || ''}`;
    if (/森林|野外|山|草原|海|河|湖|沙漠|港|码头/.test(t)) return 'wild';
    if (/酒馆|酒吧|旅店|客栈|商店|市场|摊|宅|家|房间|屋|楼/.test(t)) return 'indoor';
    if (/王宫|城堡|宫殿|神殿|教会|要塞|军营/.test(t)) return 'royal';
    if (/城市|都城|镇|街区|广场|街道|巷/.test(t)) return 'urban';
    if (/区域|王国|帝国|国家|地区|大陆/.test(t)) return 'region';
    return 'place';
}

async function showMapModal(opts = {}) {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }

    const data = await readMap(book);
    const roster = await readRoster(book);
    const clockNow = readClock();
    const cur = currentMapPath(data);

    const body = document.createElement('div');
    body.className = 'nt-quick-map parchment';
    const hud = document.createElement('div');
    hud.className = 'nt-quick-map-hud';
    const crumbs = document.createElement('div');
    crumbs.className = 'nt-quick-map-crumbs';
    const actions = document.createElement('div');
    actions.className = 'nt-quick-map-actions';
    const info = document.createElement('div');
    info.className = 'nt-quick-map-info';
    hud.appendChild(crumbs);
    hud.appendChild(actions);
    hud.appendChild(info);
    const content = document.createElement('div');
    content.className = 'nt-quick-map-content';
    body.appendChild(hud);
    body.appendChild(content);

    let mode = 'map';
    let peopleQuery = '';
    let mapZoom = 1;
    let mapCanvas = null;
    const state = { level: 'world', region: '', city: '', site: '' };

    const setStateFromPath = (p) => {
        state.region = p.region || '';
        state.city = p.city || '';
        state.site = p.site || '';
        if (p.site && data.sites[p.site]) state.level = 'site';
        else if (p.city && data.cities[p.city]) state.level = 'city';
        else if (p.region && data.regions[p.region]) state.level = 'region';
        else state.level = 'world';
    };
    setStateFromPath(cur);
    if (!opts.focusCurrent) {
        state.level = 'world';
        state.region = '';
        state.city = '';
        state.site = '';
    }

    const jumpTo = (loc) => {
        const p = findPath(data, loc);
        if (p.site && data.sites[p.site]) {
            setStateFromPath(p);
        } else if (p.city && data.cities[p.city]) {
            state.level = 'city'; state.region = p.region; state.city = p.city; state.site = '';
        } else if (p.region && data.regions[p.region]) {
            state.level = 'region'; state.region = p.region; state.city = ''; state.site = '';
        } else {
            toast('地图里还没有这个地点', 'warning');
            return;
        }
        mode = 'map';
        render();
    };

    openModal({ title: '世界地图', body, wide: true, footer: [{ label: '关闭', primary: true }] });
    const modalPanel = document.querySelector('#nt-quick-modal .nt-quick-modal');
    if (modalPanel) modalPanel.classList.add('nt-map-modal');

    const isCurrent = (level, name) => {
        if (level === 'region') return cur.region === name;
        if (level === 'city') return cur.city === name;
        if (level === 'site') return cur.site === name;
        return false;
    };

    const makeBtn = (label, onClick, active = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nt-quick-map-btn' + (active ? ' active' : '');
        b.textContent = label;
        b.addEventListener('click', onClick);
        return b;
    };

    const applyMapZoom = () => {
        if (mapCanvas) mapCanvas.style.zoom = String(mapZoom);
    };
    const setMapZoom = (next) => {
        mapZoom = Math.max(0.6, Math.min(2.2, Math.round(next * 100) / 100));
        applyMapZoom();
    };

    const renderHUD = () => {
        crumbs.textContent = '';
        const addCrumb = (label, level) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nt-quick-map-crumb';
            b.textContent = label;
            b.addEventListener('click', () => {
                mode = 'map';
                state.level = level;
                if (level === 'world') { state.region = ''; state.city = ''; state.site = ''; }
                if (level === 'region') { state.city = ''; state.site = ''; }
                if (level === 'city') { state.site = ''; }
                render();
            });
            crumbs.appendChild(b);
        };
        addCrumb('世界', 'world');
        if (state.region) addCrumb(state.region, 'region');
        if (state.city) addCrumb(state.city, 'city');
        if (state.site) addCrumb(state.site, 'site');

        actions.textContent = '';
        actions.appendChild(makeBtn('我在哪', () => {
            setStateFromPath(cur);
            mode = 'map';
            render();
        }, mode === 'map' && state.site && state.site === cur.site));
        actions.appendChild(makeBtn('找角色', () => {
            mode = 'people';
            render();
        }, mode === 'people'));
        actions.appendChild(makeBtn('＋', () => setMapZoom(mapZoom + 0.15)));
        actions.appendChild(makeBtn('－', () => setMapZoom(mapZoom - 0.15)));
        actions.appendChild(makeBtn('重置', () => setMapZoom(1)));

        const place = (clockNow && clockNow.place) || cur.site || cur.city || '未知地点';
        const time = (clockNow && clockNow.time) || '';
        info.textContent = `第 ${currentLayerNo()} 层 · ${place}${time ? ' · ' + time : ''}`;
    };

    const makeNode = (name, place, x, y, level, onClick) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `nt-map-node nt-map-node-${level} tone-${mapTone(place.type, name)}`;
        b.style.left = `${x}%`;
        b.style.top = `${y}%`;
        const icon = document.createElement('span');
        icon.className = 'nt-map-node-icon';
        icon.textContent = mapIcon(place.type, name);
        const label = document.createElement('span');
        label.className = 'nt-map-node-label';
        label.textContent = name;
        const sub = document.createElement('span');
        sub.className = 'nt-map-node-sub';
        const dir = normalizeDirection(place.direction) || mapInferDirection(place);
        sub.textContent = [dir ? `方位·${dir}` : '', place.type].filter(Boolean).join(' / ');
        b.appendChild(icon);
        b.appendChild(label);
        b.appendChild(sub);
        if (isCurrent(level, name)) {
            const tag = document.createElement('span');
            tag.className = 'nt-map-node-current';
            tag.textContent = '当前';
            b.appendChild(tag);
        }
        b.addEventListener('click', onClick);
        return b;
    };

    const section = (text) => {
        const el = document.createElement('div');
        el.className = 'nt-map-section';
        el.textContent = text;
        return el;
    };

    const note = (text) => {
        const el = document.createElement('div');
        el.className = 'nt-map-note';
        el.textContent = text;
        return el;
    };

    const personChip = (c, loc) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nt-map-person';
        const avatar = document.createElement('span');
        avatar.className = 'nt-map-avatar';
        avatar.textContent = String(c.name || '?').slice(0, 1);
        const body = document.createElement('span');
        body.className = 'nt-map-person-body';
        const nm = document.createElement('span');
        nm.className = 'nt-map-person-name';
        nm.textContent = c.name;
        const mt = document.createElement('span');
        mt.className = 'nt-map-person-meta';
        mt.textContent = [c.tier, c.action].filter(Boolean).join(' · ') || (loc || '位置未知');
        body.appendChild(nm);
        body.appendChild(mt);
        b.appendChild(avatar);
        b.appendChild(body);
        if (loc) b.addEventListener('click', () => jumpTo(loc));
        return b;
    };

    const renderDetail = () => {
        const detail = document.createElement('div');
        detail.className = 'nt-map-detail';

        if (state.level === 'site' && data.sites[state.site]) {
            const site = data.sites[state.site];
            const head = document.createElement('div');
            head.className = 'nt-map-detail-head';
            const icon = document.createElement('span');
            icon.className = 'nt-map-detail-icon';
            icon.textContent = mapIcon(site.type, state.site);
            const tw = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'nt-map-detail-title';
            title.textContent = state.site;
            const sub = document.createElement('div');
            sub.className = 'nt-map-detail-sub';
            sub.textContent = [state.region, state.city, site.type].filter(Boolean).join(' / ');
            tw.appendChild(title);
            tw.appendChild(sub);
            head.appendChild(icon);
            head.appendChild(tw);
            if (isCurrent('site', state.site)) {
                const tag = document.createElement('span');
                tag.className = 'nt-map-detail-current';
                tag.textContent = '当前';
                head.appendChild(tag);
            }
            detail.appendChild(head);

            const facts = document.createElement('div');
            facts.className = 'nt-map-detail-facts';
            const addFact = (label, value) => {
                if (!value) return;
                const row = document.createElement('div');
                row.className = 'nt-map-fact';
                const l = document.createElement('span');
                l.className = 'nt-map-fact-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.className = 'nt-map-fact-value';
                v.textContent = value;
                row.appendChild(l);
                row.appendChild(v);
                facts.appendChild(row);
            };
            addFact('可交互', site.interact);
            addFact('常驻', site.regulars);
            addFact('路程', site.travel || '未记录（下一次地图更新补）');
            addFact('方位', normalizeDirection(site.direction) || mapInferDirection(site));
            detail.appendChild(facts);

            detail.appendChild(section('出口 / 周边'));
            const exits = document.createElement('div');
            exits.className = 'nt-map-exits';
            for (const exit of site.exits || []) {
                const target = data.sites[exit];
                const travel = travelEntries(site.travel).find(t => t.to === exit
                    || t.to.includes(exit) || exit.includes(t.to));
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'nt-map-exit';
                b.textContent = `➜ ${exit}${travel ? ` · ${travel.label}` : ''}`;
                if (target) b.addEventListener('click', () => jumpTo(exit));
                else { b.disabled = true; b.className += ' disabled'; }
                exits.appendChild(b);
            }
            if (!(site.exits || []).length) exits.appendChild(note('没有记录出口。'));
            detail.appendChild(exits);

            const present = roster.filter(c => charPlace(data, c) === state.site);
            detail.appendChild(section(`在场角色 · ${present.length}`));
            if (!present.length) detail.appendChild(note('暂无记录到角色在这里。'));
            else {
                const people = document.createElement('div');
                people.className = 'nt-map-people-row';
                for (const c of present) people.appendChild(personChip(c, state.site));
                detail.appendChild(people);
            }
            return detail;
        }

        if (state.level === 'city' && data.cities[state.city]) {
            const city = data.cities[state.city];
            const title = document.createElement('div');
            title.className = 'nt-map-detail-title';
            title.textContent = state.city;
            const sub = document.createElement('div');
            sub.className = 'nt-map-detail-sub';
            sub.textContent = [state.region, city.type, city.direction ? `方位·${city.direction}` : ''].filter(Boolean).join(' / ');
            detail.appendChild(title);
            detail.appendChild(sub);
            const desc = document.createElement('div');
            desc.className = 'nt-map-detail-desc';
            desc.textContent = city.desc || '点击地图上的小地点查看详情。';
            detail.appendChild(desc);
            return detail;
        }

        if (data.regions[state.region]) {
            const region = data.regions[state.region];
            const title = document.createElement('div');
            title.className = 'nt-map-detail-title';
            title.textContent = state.region;
            const sub = document.createElement('div');
            sub.className = 'nt-map-detail-sub';
            sub.textContent = [region.type, region.direction ? `方位·${region.direction}` : ''].filter(Boolean).join(' / ');
            detail.appendChild(title);
            detail.appendChild(sub);
            const desc = document.createElement('div');
            desc.className = 'nt-map-detail-desc';
            desc.textContent = region.desc || '点击地图上的城市进入中地图。';
            detail.appendChild(desc);
            return detail;
        }

        const title = document.createElement('div');
        title.className = 'nt-map-detail-title';
        title.textContent = '世界地图';
        const sub = document.createElement('div');
        sub.className = 'nt-map-detail-sub';
        sub.textContent = `${Object.keys(data.regions || {}).length} 个区域 · 点击区域查看中地图`;
        detail.appendChild(title);
        detail.appendChild(sub);
        return detail;
    };

    const renderMap = () => {
        content.textContent = '';
        const regions = Object.keys(data.regions || {});
        if (!regions.length) {
            content.appendChild(note('还没有地图。发一轮消息，AI 会生成大地图 / 中地图 / 小地点。'));
            return;
        }

        let level = state.level;
        let items = [];
        let mapTitle = '';
        if (level === 'world') {
            mapTitle = '大地图';
            items = Object.entries(data.regions || {}).map(([name, p]) => ({ name, p, level: 'region' }));
        } else if (level === 'region') {
            const region = data.regions[state.region];
            if (!region) { state.level = 'world'; render(); return; }
            mapTitle = state.region;
            items = Object.entries(data.cities || {})
                .filter(([, c]) => c.region === state.region)
                .map(([name, p]) => ({ name, p, level: 'city' }));
        } else {
            const city = data.cities[state.city];
            if (!city) { state.level = state.region ? 'region' : 'world'; render(); return; }
            mapTitle = state.city;
            items = Object.entries(data.sites || {})
                .filter(([, s]) => s.city === state.city)
                .map(([name, p]) => ({ name, p, level: 'site' }));
        }
        if (!items.length) {
            content.appendChild(note(level === 'world' ? '还没有区域。' : '这一层还没有节点。'));
            return;
        }

        const canvas = document.createElement('div');
        canvas.className = 'nt-map-canvas';
        const links = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        links.setAttribute('class', 'nt-map-links');
        links.setAttribute('viewBox', '0 0 100 100');
        links.setAttribute('preserveAspectRatio', 'none');
        canvas.appendChild(links);

        const nodes = document.createElement('div');
        nodes.className = 'nt-map-nodes';
        canvas.appendChild(nodes);
        const zoomWrap = document.createElement('div');
        zoomWrap.className = 'nt-map-zoom';
        zoomWrap.appendChild(canvas);
        content.appendChild(zoomWrap);
        mapCanvas = canvas;
        applyMapZoom();
        zoomWrap.addEventListener('wheel', (e) => {
            if (e.target.closest('input, textarea')) return;
            e.preventDefault();
            setMapZoom(mapZoom + (e.deltaY < 0 ? 0.1 : -0.1));
        }, { passive: false });

        const canvasW = Math.max(240, canvas.clientWidth || 800);
        const canvasH = Math.max(220, canvas.clientHeight || 450);
        const positions = new Map();
        const placed = [];
        const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
        const nodeBox = (name) => {
            const len = [...String(name || '')].length;
            const pxW = Math.min(158, Math.max(78, len * 12 + 30));
            return {
                w: Math.min(40, Math.max(9, (pxW / canvasW) * 100)),
                h: Math.min(30, Math.max(8, (54 / canvasH) * 100)),
            };
        };
        const hit = (a, b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 1.2
            && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 1.2;
        items.forEach((item, index) => {
            const size = nodeBox(item.name);
            const minX = size.w / 2 + 2;
            const maxX = 100 - size.w / 2 - 2;
            const minY = size.h / 2 + 2;
            const maxY = 100 - size.h / 2 - 2;
            let pos = { ...mapNodePosition(item.p, item.name, index), ...size };
            pos.x = clamp(pos.x, minX, maxX);
            pos.y = clamp(pos.y, minY, maxY);
            let guard = 0;
            while (placed.some(p => hit(p, pos)) && guard < 60) {
                const ang = guard * 2.399 + index * 1.7;
                const radius = 3 + guard * 0.9;
                pos = {
                    ...pos,
                    x: clamp(pos.x + Math.cos(ang) * radius, minX, maxX),
                    y: clamp(pos.y + Math.sin(ang) * radius, minY, maxY),
                };
                guard++;
            }
            // 螺旋没解开时，用固定网格找最近的空位，避免卡片叠在一起
            if (placed.some(p => hit(p, pos))) {
                let best = null;
                let bestDist = Infinity;
                for (const gx of [16, 50, 84]) {
                    for (const gy of [22, 40, 58, 76]) {
                        const cx = clamp(gx, minX, maxX);
                        const cy = clamp(gy, minY, maxY);
                        const cand = { x: cx, y: cy, ...size };
                        if (placed.some(p => hit(p, cand))) continue;
                        const dist = Math.hypot(cx - pos.x, cy - pos.y);
                        if (dist < bestDist) { best = cand; bestDist = dist; }
                    }
                }
                if (best) pos = best;
            }
            placed.push(pos);
            positions.set(item.name, pos);
            const onClick = () => {
                if (item.level === 'region') {
                    state.level = 'region'; state.region = item.name; state.city = ''; state.site = '';
                } else if (item.level === 'city') {
                    state.level = 'city'; state.city = item.name; state.site = '';
                } else {
                    state.level = 'site'; state.site = item.name;
                }
                render();
            };
            nodes.appendChild(makeNode(item.name, item.p, pos.x, pos.y, item.level, onClick));
        });

        if (level === 'city' || level === 'site') {
            const seen = new Set();
            for (const [name, site] of Object.entries(data.sites || {})) {
                if (site.city !== state.city) continue;
                const from = positions.get(name);
                if (!from) continue;
                for (const exit of site.exits || []) {
                    const to = positions.get(exit);
                    if (!to) continue;
                    const key = [name, exit].sort().join('|');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', from.x);
                    line.setAttribute('y1', from.y);
                    line.setAttribute('x2', to.x);
                    line.setAttribute('y2', to.y);
                    links.appendChild(line);
                }
            }
        }

        const detail = renderDetail();
        content.appendChild(detail);
    };

    const renderPeople = () => {
        content.textContent = '';
        const board = document.createElement('div');
        board.className = 'nt-map-people-board';
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'nt-map-search';
        search.placeholder = '搜索角色名或地点…';
        search.value = peopleQuery;
        const hint = document.createElement('div');
        hint.className = 'nt-map-note';
        hint.textContent = '点角色跳到他的位置；「我在哪」回到你的当前位置。';
        const list = document.createElement('div');
        list.className = 'nt-map-people-list';
        board.appendChild(search);
        board.appendChild(hint);
        board.appendChild(list);
        content.appendChild(board);

        const draw = () => {
            list.textContent = '';
            if (!roster.length) {
                list.appendChild(note('角色索引里还没有角色。'));
                return;
            }

            const q = peopleQuery.trim().toLowerCase();
            if (q) {
                const hits = roster.filter(c =>
                    String(c.name || '').toLowerCase().includes(q)
                    || String(c.location || '').toLowerCase().includes(q)
                );
                list.appendChild(section(`搜索结果（${hits.length}）`));
                if (!hits.length) {
                    list.appendChild(note('没有找到。试试角色名或地点名。'));
                    return;
                }
                const wrap = document.createElement('div');
                wrap.className = 'nt-map-people-grid';
                for (const c of hits) wrap.appendChild(personChip(c, c.location || ''));
                list.appendChild(wrap);
                return;
            }

            const byLoc = new Map();
            for (const c of roster) {
                const loc = charPlace(data, c) || String(c.location || '').trim();
                if (!byLoc.has(loc)) byLoc.set(loc, []);
                byLoc.get(loc).push(c);
            }

            const exits = (data.sites[cur.site] && data.sites[cur.site].exits) || [];
            const currentChars = byLoc.get(cur.site) || [];
            const nearby = [];
            const others = [];
            const unknown = byLoc.get('') || [];
            for (const [loc, chars] of byLoc.entries()) {
                if (!loc) continue;
                if (loc === cur.site) continue;
                if (exits.includes(loc)) nearby.push({ loc, chars });
                else others.push({ loc, chars });
            }
            others.sort((a, b) => a.loc.localeCompare(b.loc, 'zh'));

            const addGroup = (title, place, chars) => {
                list.appendChild(section(title));
                if (place) {
                    const link = document.createElement('button');
                    link.type = 'button';
                    link.className = 'nt-map-place-link';
                    link.textContent = `定位：${place}`;
                    link.addEventListener('click', () => jumpTo(place));
                    list.appendChild(link);
                }
                if (!chars.length) {
                    list.appendChild(note('暂无。'));
                    return;
                }
                const wrap = document.createElement('div');
                wrap.className = 'nt-map-people-grid';
                for (const c of chars) wrap.appendChild(personChip(c, place || c.location || ''));
                list.appendChild(wrap);
            };

            addGroup(`我的位置 · ${cur.site || '未知地点'}（${currentChars.length}）`, cur.site, currentChars);
            for (const group of nearby) addGroup(`周边 · ${group.loc}（${group.chars.length}）`, group.loc, group.chars);
            for (const group of others) addGroup(`后台 · ${group.loc}（${group.chars.length}）`, group.loc, group.chars);
            if (unknown.length) addGroup(`位置未知（${unknown.length}）`, '', unknown);
        };

        search.addEventListener('input', () => {
            peopleQuery = search.value;
            draw();
        });        draw();
    };

    const render = () => {
        renderHUD();
        if (mode === 'people') renderPeople();
        else renderMap();
    };

    render();
}

async function showQuestsModal() {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const main = await readMain(book);
    const quests = await readQuests(book);
    const questHistory = await readQuestHistory(book);

    const body = document.createElement('div');
    body.className = 'nt-quests nt-quests-readonly';

    const card = document.createElement('div');
    card.className = 'nt-quest-main';
    const title = document.createElement('div');
    title.className = 'nt-quest-title';
    title.textContent = '主线';
    card.appendChild(title);

    const mainFields = [
        ['标题', main['标题']],
        ['目标', main['目标']],
        ['阶段', main['阶段']],
        ['进度', `${clampProgress(main['进度'])}%`],
        ['失败代价', main['失败代价']],
        ['下一步', main['下一步']],
    ];
    for (const [label, value] of mainFields) {
        if (!value) continue;
        const row = document.createElement('div');
        row.className = 'nt-quest-read-row';
        const l = document.createElement('span');
        l.className = 'nt-quest-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'nt-quest-read-value';
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        card.appendChild(row);
    }

    const bar = document.createElement('div');
    bar.className = 'nt-quest-bar';
    const fill = document.createElement('div');
    fill.className = 'nt-quest-bar-fill';
    fill.style.width = `${clampProgress(main['进度'])}%`;
    bar.appendChild(fill);
    card.appendChild(bar);
    body.appendChild(card);

    const head = document.createElement('div');
    head.className = 'nt-quest-section';
    head.textContent = `支线（${Object.keys(quests).length}）`;
    body.appendChild(head);

    if (!Object.keys(quests).length) {
        const empty = document.createElement('div');
        empty.className = 'nt-quick-note';
        empty.textContent = '暂无支线。';
        body.appendChild(empty);
    }

    const sideLabels = ['类型', '目标', '状态', '期限', '失败条件', '钩子', '地点', '下一步'];
    for (const [name, value] of Object.entries(quests)) {
        const item = document.createElement('div');
        item.className = 'nt-quest-read-item';
        const n = document.createElement('div');
        n.className = 'nt-quest-read-name';
        n.textContent = name;
        item.appendChild(n);
        const parts = String(value || '').split(/[｜|]/).map(s => s.trim()).filter(Boolean);
        if (parts.length > 1) {
            const detail = document.createElement('div');
            detail.className = 'nt-quest-read-detail';
            parts.forEach((part, index) => {
                const line = document.createElement('div');
                line.textContent = `${sideLabels[index] || ''}${sideLabels[index] ? '：' : ''}${part}`;
                detail.appendChild(line);
            });
            item.appendChild(detail);
        } else {
            const detail = document.createElement('div');
            detail.className = 'nt-quest-read-detail';
            detail.textContent = value;
            item.appendChild(detail);
        }
        body.appendChild(item);
    }

    // AI 更新的「可办事项」：不是程序汇总，是模型每轮生成/替换的附近新鲜事
    const todoHead = document.createElement('div');
    todoHead.className = 'nt-quest-section';
    todoHead.textContent = '可办事项';
    body.appendChild(todoHead);
    let todoLines = [];
    try {
        const bookData = await stBridge.loadWorldInfoAsync(book, true);
        const todoEntry = Object.values(bookData?.entries || {}).find(e => e && e.comment === '可办事项');
        todoLines = String(todoEntry?.content || '').split('\n')
            .map(l => l.trim())
            .filter(l => /^[-·]\s*/.test(l))
            .map(l => l.replace(/^[-·]\s*/, ''));
    } catch (_) {}
    if (!todoLines.length) {
        const empty = document.createElement('div');
        empty.className = 'nt-quick-note';
        empty.textContent = '暂无。等世界更新后，这里会出现附近可以做的有趣事。';
        body.appendChild(empty);
    } else {
        for (const line of todoLines.slice(0, 6)) {
            const parts = line.split(/[｜|]/).map(s => s.trim()).filter(Boolean);
            const item = document.createElement('div');
            item.className = 'nt-quest-read-item';
            const n = document.createElement('div');
            n.className = 'nt-quest-read-name';
            n.textContent = parts[0] || '可做';
            const d = document.createElement('div');
            d.className = 'nt-quest-read-detail';
            d.textContent = parts.slice(1).join('　');
            item.appendChild(n);
            if (d.textContent) item.appendChild(d);
            body.appendChild(item);
        }
    }

    if (questHistory.length) {
        const historyHead = document.createElement('div');
        historyHead.className = 'nt-quest-section';
        historyHead.textContent = '支线历史（最近失败 / 过期）';
        body.appendChild(historyHead);
        const historyBox = document.createElement('div');
        historyBox.className = 'nt-quest-history';
        for (const line of questHistory.slice(-8).reverse()) {
            const row = document.createElement('div');
            row.className = 'nt-quest-history-row';
            row.textContent = line;
            historyBox.appendChild(row);
        }
        body.appendChild(historyBox);
    }

    openModal({
        title: '可办事项',
        body,
        wide: true,
        footer: [
            { label: '手动修改', onClick: () => { closeModal(); showEditModal().catch(err => toast(`打开手动修改失败：${err && err.message ? err.message : err}`, 'error')); } },
            { label: '关闭', primary: true },
        ],
    });
}

const mainCompleteShown = new Set();

async function showMainCompleteModal(bookName) {
    if (!bookName || mainCompleteShown.has(bookName)) return;
    mainCompleteShown.add(bookName);
    const main = await readMain(bookName);

    const body = document.createElement('div');
    body.className = 'nt-quests';
    const card = document.createElement('div');
    card.className = 'nt-quest-main';
    const title = document.createElement('div');
    title.className = 'nt-quest-title';
    title.textContent = `主线完成：${main['标题'] || '未命名主线'}`;
    card.appendChild(title);
    const note = document.createElement('div');
    note.className = 'nt-quest-empty';
    note.textContent = '主线进度到 100%。你想怎么收尾？';
    card.appendChild(note);
    body.appendChild(card);

    const choose = (patch, msg) => async () => {
        const ok = await saveMain(bookName, { ...main, ...patch });
        if (!ok) {
            toast('世界书不存在或写入失败，已停止保存', 'error');
            return false;
        }
        toast(msg, 'success');
        return true;
    };

    openModal({
        title: '主线完成',
        body,
        footer: [
            { label: '进入结局', primary: true, onClick: choose({ 阶段: '结局', 进度: 100, 下一步: '故事结束' }, '已进入结局') },
            { label: '后日谈', onClick: choose({ 阶段: '后日谈', 进度: 0, 下一步: '日常收尾' }, '已转为后日谈') },
            { label: '新主线', onClick: async () => {
                mainCompleteShown.delete(bookName);
                const ok = await saveMain(bookName, { 标题: '新主线（待编辑）', 目标: '待定', 阶段: '新主线', 进度: 0, 失败代价: '', 下一步: '在可办事项里编辑' });
                if (!ok) {
                    toast('世界书不存在或写入失败，已停止保存', 'error');
                    return false;
                }
                toast('已重置为新主线，可在可办事项里改', 'success');
                return true;
            } },
            { label: '自己决定' },
        ],
    });
}

async function backupBeforeWrite() {
    try {
        await exportCurrent();
        toast('已自动备份当前档', 'success');
        return true;
    } catch (e) {
        toast(e && e.message ? `自动备份失败，已停止写入：${e.message}` : '自动备份失败，已停止写入', 'error');
        return false;
    }
}

function normalizeRefreshApiUrl(raw, type = 'openai') {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    let u;
    try { u = new URL(s); } catch { throw new Error('URL 格式不对，要写完整地址'); }
    if (u.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) u.protocol = 'https:';
    let path = u.pathname.replace(/\/+$/, '');
    if (type === 'anthropic') {
        if (!path || path === '/') path = '/v1/messages';
        else if (/\/v1$/i.test(path)) path += '/messages';
        else if (!/\/messages$/i.test(path)) path += '/v1/messages';
    } else if (type === 'gemini') {
        if (!path || path === '/') path = '/v1beta';
    } else {
        if (!path || path === '/') path = '/v1/chat/completions';
        else if (/\/v\d+$/i.test(path)) path += '/chat/completions';
        else if (!/\/chat\/completions$/i.test(path) && !/\/v\d+\//i.test(path)) path += '/v1/chat/completions';
    }
    u.pathname = path;
    u.search = '';
    u.hash = '';
    return u.toString();
}

function refreshApiModelsUrl(url, type = 'openai') {
    const u = new URL(normalizeRefreshApiUrl(url, type));
    if (type === 'anthropic') {
        u.pathname = `${u.pathname.replace(/\/messages$/i, '')}/models`;
    } else {
        u.pathname = `${u.pathname.replace(/\/chat\/completions$/i, '')}/models`;
    }
    u.search = '';
    return u.toString();
}

async function fetchRefreshModels(cfg) {
    let url;
    try {
        url = refreshApiModelsUrl(cfg.url, cfg.type || 'openai');
    } catch (e) {
        throw new Error('URL 格式不对，要写完整地址（含 https://）');
    }
    const headers = {};
    if (cfg.type === 'anthropic') {
        headers['x-api-key'] = cfg.key || '';
        headers['anthropic-version'] = '2023-06-01';
    } else if (cfg.key) {
        headers.Authorization = `Bearer ${cfg.key}`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res;
    try {
        res = await fetch(url, { headers, signal: ctrl.signal });
    } catch (e) {
        throw new Error(`连接失败（CORS/网络/超时）：${e && e.message ? e.message : e}`);
    } finally {
        clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('返回的不是 JSON'); }
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []);
    return list.map(x => typeof x === 'string' ? x : (x?.id || x?.name)).filter(Boolean);
}

async function buildRefreshGaps(book) {
    const gaps = [];
    try {
        const map = await readMap(book);
        const sites = Object.values(map.sites || {}).flatMap(x => Object.keys(x || {}));
        const clock = getSlotClock(book) || {};
        const place = String(clock.place || '').trim();
        if (place && sites.length && !sites.some(s => place.includes(s) || s.includes(place))) {
            gaps.push(`当前地点「${place}」不在地图，补地点或修正位置`);
        }
        for (const cities of Object.values(map.cities || {})) {
            for (const city of Object.keys(cities || {})) {
                if (!Object.keys((map.sites || {})[city] || {}).length) gaps.push(`城市「${city}」还没有小地点`);
            }
        }
        const roster = await readRoster(book);
        for (const c of roster.slice(0, 12)) {
            const name = String(c && c.name || '').trim();
            if (!name) continue;
            const entry = await readCharacterEntry(book, name);
            if (!entry) gaps.push(`索引角色「${name}」没有角色条目，补最小档案`);
        }
        const bookData = await stBridge.loadWorldInfoAsync(book, true);
        const news = bookData && Object.values(bookData.entries || {}).find(e => e && e.comment === '新闻日报');
        const newsCount = String(news && news.content || '').split('\n').filter(l => /^-\s*/.test(l.trim())).length;
        if (newsCount < 6) gaps.push(`新闻日报只有 ${newsCount} 条，未满 6 条可补新新闻`);
    } catch (_) {}
    return [...new Set(gaps)].slice(0, 8);
}

async function buildAutoRefreshPrompt(book) {
    const bookData = await stBridge.loadWorldInfoAsync(book);
    const get = (title) => {
        const entry = bookData && bookData.entries
            ? Object.values(bookData.entries).find(e => e && e.comment === title)
            : null;
        return entry ? String(entry.content || '').slice(0, 6000) : '';
    };
    const roster = (await readRoster(book)).filter(c => String(c.tier || '').toUpperCase() !== 'T4');
    const charNames = roster.map(c => c.name);
    const userCharName = stBridge.getUserName() || '用户';
    const recordUserChar = settings.get('worldsim').recordUserCharacter === true;
    const chatNow = stBridge.getContext().chat || [];
    const aiCount = chatNow.filter(m => m && !m.is_user && (
        !m.is_system || m.extra?.nekotool_hidden_by_plugin || m.extra?.nekotool_user_hidden
    )).length;
    const wsCfg = settings.get('worldsim') || {};
    const bigLimit = Number(wsCfg.bigSummaryLimit) || 0;
    const wantBigSummary = wsCfg.enableBigSummary === true
        && bigLimit > 0 && aiCount > 0 && aiCount % bigLimit === 0;
    const wantSmallSummary = wsCfg.enableSummary === true && !wantBigSummary;
    const blocks = [];
    const recentChat = (stBridge.getContext().chat || [])
        .slice(-6)
        .map(m => `${m.is_user ? '用户' : (m.name || '角色')}：${String(m.mes || '').slice(0, 800)}`)
        .join('\n');
    if (recentChat) blocks.push(`【最近对话】\n${recentChat.slice(0, 5000)}`);
    if (charNames.length) {
        blocks.push(`【索引】\n${get('索引') || '（空）'}`);
    } else {
        const cur = stBridge.getCurrentCharacter?.();
        const card = cur ? [cur.name, cur.description, cur.personality, cur.scenario].filter(Boolean).join('\n') : '';
        if (card) blocks.push(`【角色卡】\n${card.slice(0, 3000)}`);
        const all = bookData && bookData.entries
            ? Object.values(bookData.entries).filter(e => e && e.comment).map(e => `【${e.comment}】\n${String(e.content || '').slice(0, 800)}`).join('\n')
            : '';
        if (all) blocks.push(`【当前追踪书】\n${all.slice(0, 5000)}`);
    }
    blocks.push(`【世界·国家】\n${get('世界·国家') || '（空）'}`);
    blocks.push(`【世界·势力】\n${get('世界·势力') || '（空）'}`);
    blocks.push(`【新闻日报】\n${get('新闻日报') || '（空）'}`);
    blocks.push(`【地图】\n${get('地图') || '（空）'}`);
    blocks.push(`【主线】\n${get('主线') || '（空）'}`);
    blocks.push(`【支线】\n${get('支线') || '（空）'}`);
    blocks.push(`【道具】\n${get('道具') || '（空）'}`);
    blocks.push(`【伏笔】\n${get('伏笔') || '（空）'}`);
    blocks.push(`【计划】\n${get('计划') || '（空）'}`);
    if (wantBigSummary) {
        blocks.push(`【大总结】\n${get('大总结') || '（空）'}`);
        blocks.push(`【小总结】\n${get('小总结') || '（空）'}`);
        const cursor = Number(getSlotMeta(book).bigSummaryLayer) || 0;
        const since = chatNow.slice(cursor)
            .map(m => `${m.is_user ? '用户' : (m.name || '角色')}：${String(m.mes || '').slice(0, 800)}`)
            .join('\n');
        if (since) blocks.push(`【大总结之后新增对话】\n${since.slice(0, 8000)}`);
    } else if (wantSmallSummary) {
        blocks.push(`【小总结】\n${get('小总结') || '（空）'}`);
    }
    if (wsCfg.enablePlayerPanel) blocks.push(`【玩家档案】\n${get('玩家档案') || '（空）'}`);
    if (wsCfg.enableReputation) blocks.push(`【声望】\n${get('声望') || '（空）'}`);
    const gaps = await buildRefreshGaps(book);
    if (gaps.length) blocks.push(`【程序检查到的缺口】\n${gaps.map(g => `- ${g}`).join('\n')}\n本轮优先补这些结构缺口；没有合理内容也不要硬编。`);
    const schema = [];
    if (wsCfg.enableChars !== false) {
        schema.push(`"chars": {"角色名": {"性别":"...","外貌":"...","位置":"地图小地点名","人际关系":{"${userCharName}":"亲近：原因"},"状态":"...","后台运行":"A→B→C","长期目标":"...","近期打算":"...","关键记忆":["..."],"特殊变化":"...","关键词":["昵称","姓氏","名字","Mr. Smith","王先生"]}}`);
    }
    if (wsCfg.enableWorld !== false) schema.push('"world": {"国家":{"名称":"方位｜类型｜政体｜领袖｜经济｜军事｜外交关系｜文化｜当前动向"},"势力":{"名称":"类型｜目标｜资源｜与主角关系｜当前动作"},"新闻日报":{"标题":"事件｜影响｜来源"}}');
    if (wsCfg.enableMap !== false) schema.push('"map": {"regions":{"名称":"方位｜类型｜一句话"},"cities":{"区域名":{"城市名":"方位｜类型｜一句话"}},"sites":{"城市名":{"地点名":"方位｜类型｜出口：A、B｜路程：A=1天、B=10分钟｜可交互：...｜常驻：..."}}}');
    if (wsCfg.enableQuests !== false) {
        schema.push('"main": {"标题":"...","目标":"...","阶段":"...","进度":0-100,"失败代价":"...","下一步":"..."}');
        schema.push('"quests": {"add": {"支线名":"类型｜目标｜状态｜期限(YYYY年MM月DD日/无)｜失败条件｜钩子｜地点｜下一步"}, "del":["支线名"]}');
    }
    if (wsCfg.enableItems !== false) schema.push('"items": {"add": {"道具名": {"描述":"[类别] 描述","关键词":["具体词1","具体词2"]}}, "del":["道具名"]}');
    if (wsCfg.enableForeshadow !== false) schema.push('"foreshadow": {"add": {"伏笔名": {"描述":"[线索 | 指向] 描述","关键词":["具体词1","具体词2"]}}, "del":["伏笔名"]}');
    if (wsCfg.enablePlot !== false) schema.push('"plot": {"add": {"计划名": {"描述":"[谁 | 做什么 | 状态] 描述","关键词":["具体词1","具体词2"]}}, "del":["计划名"]}');
    if (wantSmallSummary) schema.push('"summary": "100字内，具体事件/承诺/道具/关系变化"');
    if (wantBigSummary) schema.push('"bigSummary": "约2000 token，按时间顺序总结至此剧情，保留关键事件/关系变化/伏笔"');
    if (wsCfg.enablePlayerPanel) schema.push('"player": {"名字":"","身份":"","钱":0,"道具":[{"名称","数量","位置","状态","备注"}],"删除道具":["名"],"资产":[{"名称","状态","产出","备注"}],"关系":[{"对象","标签","原因"}],"承诺":[{"谁","什么","期限","状态"}],"状态":[""],"移除状态":[""]}');
    if (wsCfg.enableReputation) schema.push('"rep": {"成就":[["名称","原因","备注","谁知道"]],"名声":[["地区/势力","等级","原因"]]}');

    const contract = buildRefreshContract({
        chars: wsCfg.enableChars !== false,
        items: wsCfg.enableItems !== false,
        plot: wsCfg.enablePlot !== false,
        world: wsCfg.enableWorld !== false,
        foreshadow: wsCfg.enableForeshadow !== false,
        map: wsCfg.enableMap !== false,
        quests: wsCfg.enableQuests !== false,
        summary: wantSmallSummary,
        bigSummary: wantBigSummary,
        player: wsCfg.enablePlayerPanel === true,
        reputation: wsCfg.enableReputation === true,
        statecheck: wsCfg.enableStateCheck === true,
        cognition: wsCfg.enableCognition === true,
        userName: userCharName,
        recordUserChar,
    });
    const charLine = wsCfg.enableChars === false
        ? '本轮不更新角色档案。'
        : (charNames.length
            ? `本轮更新这些角色（T1/T2/T3，T4 跳过）：${charNames.join('、')}；不要输出其他人，不要输出 T4。`
            : '角色索引为空：请根据角色卡和当前追踪书初始化主要角色（包括必要 NPC），T4 路人不要写。');
    const userLine = recordUserChar
        ? `用户角色「${userCharName}」也可以作为一条角色档案更新。`
        : `不要更新用户角色「${userCharName}」的角色档案。`;
    return `你是 NEKOTOOL 的后台世界更新器。只输出一个 JSON 对象，不要正文、不要 markdown 代码块、不要解释。
方式：补全当前状态（把缺的细节补全，不主动推进时间）。
${charLine}
${userLine}
当前数据：
${blocks.join('\n\n')}

请全量更新以下类别，只写本轮需要变化/新增的内容：
${schema.join('\n')}

【默认契约】
${contract}
要求：人物位置用地图小地点名；没有变化就留空对象；不要编造与当前数据冲突的内容。`;
}

let autoRefreshRunning = false;
let autoRefreshPending = false;
let autoRefreshStopRequested = false;
let autoRefreshAbort = null;
let autoRefreshEventAt = 0;
let autoRefreshSig = '';
let autoRefreshSigAt = 0;
let autoFullMissingWarned = false;

/** 统一入口：worldsim 和酒馆消息事件都可能触发，800ms 内只跑一次；延迟让本轮世界书写盘先完成 */
function triggerAutoRefresh(sig = '') {
    const now = Date.now();
    if (now - autoRefreshEventAt < 800) return;
    autoRefreshEventAt = now;
    if (sig && sig === autoRefreshSig && now - autoRefreshSigAt < 30000) return;
    autoRefreshSig = sig;
    autoRefreshSigAt = now;
    setTimeout(() => {
        runAutoFullRefresh().catch(err => console.warn('[nekotools] 自动全量更新异常', err));
    }, 600);
}

function showAutoUpdateBanner(text = '正在全量更新，建议更新结束后再继续下一轮', withStop = true) {
    let el = document.getElementById('nt-auto-updating');
    if (!el) {
        el = document.createElement('div');
        el.id = 'nt-auto-updating';
        document.body.appendChild(el);
    }
    el.replaceChildren();
    const label = document.createElement('span');
    label.className = 'nt-auto-updating-text';
    label.textContent = text;
    const stop = document.createElement('button');
    stop.type = 'button';
    stop.className = 'nt-auto-updating-stop';
    stop.textContent = '停止';
    stop.title = '停止自动全量更新和自动重试';
    stop.addEventListener('click', stopAutoFullRefresh);
    el.appendChild(label);
    if (withStop) el.appendChild(stop);
    el.style.display = 'flex';
}

function stopAutoFullRefresh() {
    if (!autoRefreshRunning && !autoRefreshPending) return;
    autoRefreshStopRequested = true;
    autoRefreshPending = false;
    try { autoRefreshAbort?.abort(); } catch (_) {}
    const label = document.querySelector('#nt-auto-updating .nt-auto-updating-text');
    if (label) label.textContent = '正在停止自动全量更新…';
    toast('已请求停止自动全量更新', 'info');
}

function hideAutoUpdateBanner() {
    const el = document.getElementById('nt-auto-updating');
    if (el) el.remove();
}

async function runAutoFullRefresh() {
    const api = settings.get('worldsim').refreshApi || {};
    if (!api.autoFull) return;
    if ((!String(api.url || '').trim() && !String(api.source || '').trim())) {
        if (!autoFullMissingWarned) {
            autoFullMissingWarned = true;
            console.warn('[nekotools] 自动全量更新已开启，但没有配置副 API；请先在设置里保存副 API 配置');
        }
        return;
    }
    autoFullMissingWarned = false;
    if (autoRefreshRunning) {
        autoRefreshPending = true;
        return;
    }
    if (window.__nt_quiet) return;
    const book = stBridge.currentTrackerName();
    if (!book) return;
    autoRefreshRunning = true;
    autoRefreshStopRequested = false;
    autoRefreshAbort = new AbortController();
    showAutoUpdateBanner('正在自动全量更新（副 API）…');
    const configuredRetry = Number(api.retryCount);
    const retryCount = Number.isFinite(configuredRetry) ? Math.max(0, Math.min(10, Math.trunc(configuredRetry))) : 3;
    const maxAttempts = retryCount + 1;
    try {
        do {
            autoRefreshPending = false;
            if (autoRefreshStopRequested) break;
            const prompt = await buildAutoRefreshPrompt(book);
            let raw = '';
            let data = null;
            let lastError = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    if (attempt > 1) {
                        showAutoUpdateBanner(`正在自动全量更新（副 API，第 ${attempt}/${maxAttempts} 次尝试）…`);
                    }
                    raw = await generateRefreshApi(prompt, api, autoRefreshAbort.signal);
                    const text = String(raw || '');
                    const a = text.indexOf('{');
                    const b = text.lastIndexOf('}');
                    if (a < 0 || b <= a) throw new Error('模型没有返回 JSON');
                    data = JSON.parse(text.slice(a, b + 1));
                    break;
                } catch (e) {
                    if (autoRefreshStopRequested || e?.name === 'AbortError') break;
                    lastError = e;
                    console.warn(`[nekotools] 自动全量更新第 ${attempt}/${maxAttempts} 次失败`, e);
                    if (attempt < maxAttempts && !autoRefreshStopRequested) {
                        for (let i = 0; i < 30 && !autoRefreshStopRequested; i++) {
                            await new Promise(r => setTimeout(r, 100));
                        }
                    }
                }
            }
            if (autoRefreshStopRequested) break;
            if (!data) throw lastError || new Error('自动全量更新失败');
            const summary = await applyRefreshData(book, data, currentLayerNo());
            if (summary.summary || summary.bigSummary) {
                await stBridge.hideSummarizedMessages(Number(settings.get('worldsim').hideKeepCount) || 0, book);
            }
            const bits = [
                summary.chars ? `角色 ${summary.chars}` : '',
                summary.world ? `世界 ${summary.world}` : '',
                summary.map ? `地图 ${summary.map}` : '',
                summary.main ? '主线' : '',
                summary.quests ? `支线 ${summary.quests}` : '',
                summary.items ? `道具 ${summary.items}` : '',
                summary.foreshadow ? `伏笔 ${summary.foreshadow}` : '',
                summary.plot ? `计划 ${summary.plot}` : '',
                summary.summary ? '小总结' : '',
                summary.bigSummary ? '大总结' : '',
                summary.player ? '用户信息' : '',
                summary.rep ? '声望' : '',
            ].filter(Boolean);
            console.log('[nekotools] 自动全量更新完成', bits.join(' / ') || '无变化');
            if (bits.length) toast(`自动全量更新完成：${bits.join(' / ')}`, 'success');
            else toast('自动全量更新完成（没有变化）', 'info');
            const remaining = await buildRefreshGaps(book);
            if (remaining.length) {
                console.warn('[nekotools] 全量更新后仍有结构缺口', remaining);
                toast(`仍有缺口：${remaining.slice(0, 3).join('；')}`, 'warning');
            }
        } while (autoRefreshPending);
    } catch (e) {
        console.warn('[nekotools] 自动全量更新失败', e);
        toast(`自动全量更新失败：${e && e.message ? e.message : e}`, 'error');
    } finally {
        const stopped = autoRefreshStopRequested;
        autoRefreshRunning = false;
        autoRefreshPending = false;
        autoRefreshAbort = null;
        autoRefreshStopRequested = false;
        hideAutoUpdateBanner();
        if (stopped) toast('已停止自动全量更新', 'info');
    }
}

async function generateViaStRelay(prompt, cfg, signal) {
    const type = cfg.type || 'openai';
    const source = cfg.source || (type === 'anthropic' ? 'claude' : (type === 'gemini' ? 'makersuite' : 'openai'));
    const modelMap = {
        openai: 'model_openai_select', claude: 'model_claude_select', makersuite: 'model_google_select',
        custom: 'custom_model_textgenerationwebui', openrouter: 'model_openrouter_select',
        deepseek: 'model_deepseek_select', groq: 'model_groq_select', mistralai: 'model_mistralai_select',
        xai: 'model_xai_select', cohere: 'model_cohere_select',
    };
    const model = cfg.model
        || String(document.getElementById(modelMap[source] || `model_${source}_select`)?.value || '').trim();
    let secret = cfg.key || '';
    if (!secret && cfg.profileId) {
        try { secret = await getSecret(cfg.profileId); } catch (_) {}
    }
    let url = '';
    if (cfg.url) {
        url = normalizeRefreshApiUrl(cfg.url, type);
        if (type === 'openai') url = url.replace(/\/chat\/completions$/i, '');
    }
    const token = await (await fetch('/csrf-token')).json();
    const payload = {
        chat_completion_source: source,
        model: model || undefined,
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: '开始更新。' },
        ],
        max_tokens: 4096,
        temperature: 0.7,
        stream: false,
    };
    if (url) payload.reverse_proxy = url;
    if (secret) payload.proxy_password = secret;
    if (source === 'custom') {
        payload.custom_url = cfg.url || document.querySelector('#custom_api_url_text')?.value || '';
    }
    if (source === 'vertexai') {
        payload.vertexai_auth_mode = cfg.vertexAuth || 'express';
        payload.vertexai_express_project_id = cfg.vertexProject || undefined;
        payload.vertexai_region = cfg.vertexRegion || 'us-central1';
    }
    const ctrl = new AbortController();
    const onAbort = () => { try { ctrl.abort(); } catch (_) {} };
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), 180000);
    try {
        const res = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            // X-Nekotool-Quiet 只让 fetch 钩子跳过这一条后台请求；不设全局静默，
            // 否则用户在更新期间正常发消息会不被注入/不结算。
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token.token, 'X-Nekotool-Quiet': '1' },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`酒馆转发 API ${res.status}: ${text.slice(0, 300)}`);
        let data = null;
        try { data = JSON.parse(text); } catch {
            const line = text.split('\n').reverse().find(l => l.startsWith('data: ') && !l.includes('[DONE]'));
            if (line) {
                try { data = JSON.parse(line.slice(6)); } catch {}
            }
        }
        if (!data) throw new Error('酒馆转发返回的不是 JSON');
        if (data.error) {
            const err = data.error;
            const msg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
            throw new Error(`副 API 报错：${String(msg).slice(0, 300)}`);
        }
        const content = data?.choices?.[0]?.message?.content
            ?? data?.choices?.[0]?.text
            ?? data?.content?.[0]?.text
            ?? data?.content
            ?? data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('')
            ?? '';
        if (!String(content).trim()) throw new Error('副 API 返回了空内容');
        return content;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
    }
}

async function generateRefreshApi(prompt, cfg, signal) {
    if (!cfg.key && cfg.profileId) {
        try {
            const storedKey = await getSecret(cfg.profileId);
            if (storedKey) cfg = { ...cfg, key: storedKey };
        } catch (_) {}
    }
    if ((cfg.transport || 'relay') === 'relay') {
        return await generateViaStRelay(prompt, cfg, signal);
    }
    const rawUrl = String(cfg.url || '').trim();
    if (!rawUrl) return null;
    const type = cfg.type || 'openai';
    const url = normalizeRefreshApiUrl(rawUrl, type);
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (type === 'anthropic') {
        headers['x-api-key'] = cfg.key || '';
        headers['anthropic-version'] = '2023-06-01';
        body = {
            model: cfg.model || undefined,
            max_tokens: 4096,
            temperature: 0.7,
            system: prompt,
            messages: [{ role: 'user', content: '开始更新。' }],
        };
    } else if (type === 'gemini') {
        const base = new URL(url);
        if (cfg.key) headers['x-goog-api-key'] = cfg.key;
        base.pathname = `${base.pathname.replace(/\/+$/, '')}/models/${encodeURIComponent(cfg.model || 'gemini-1.5-flash')}:generateContent`;
        base.search = '';
        return await (async () => {
            const res = await fetch(base.toString(), {
                method: 'POST',
                headers,
                signal,
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: prompt }] },
                    contents: [{ role: 'user', parts: [{ text: '开始更新。' }] }],
                    generationConfig: { temperature: 0.7 },
                }),
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`);
            const data = JSON.parse(text);
            return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        })();
    } else {
        if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
        body = {
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: '开始更新。' },
            ],
            temperature: 0.7,
            stream: false,
        };
        if (cfg.model) body.model = cfg.model;
    }
    let res;
    try {
        res = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
    } catch (e) {
        throw new Error(`外接 API 请求失败（可能是 CORS 或网络）：${e && e.message ? e.message : e}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`外接 API ${res.status}: ${text.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('外接 API 返回的不是 JSON'); }
    return data?.choices?.[0]?.message?.content
        ?? data?.choices?.[0]?.text
        ?? data?.content?.[0]?.text
        ?? data?.content
        ?? data?.response
        ?? '';
}

async function showRefreshModal(preselectName = '') {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }

    const body = document.createElement('div');
    body.className = 'nt-refresh';
    const intro = document.createElement('div');
    intro.className = 'nt-refresh-note';
    intro.textContent = '会额外发一次静默请求（不进聊天记录），只更新勾选的类别/角色。内容由模型生成，保存前请自己看一眼。';
    body.appendChild(intro);
    const lastRefresh = settings.get('worldsim').lastRefresh;
    if (lastRefresh && lastRefresh.bits) {
        const lastNote = document.createElement('div');
        lastNote.className = 'nt-refresh-note';
        const d = lastRefresh.at ? new Date(lastRefresh.at) : null;
        lastNote.textContent = `上次更新：${d ? d.toLocaleString('zh-CN') : ''} · ${lastRefresh.bits}`;
        body.appendChild(lastNote);
    }
    const roster = await readRoster(book);
    const userCharName = stBridge.getUserName() || '';
    const charList = [...roster];
    if (settings.get('worldsim').recordUserCharacter === true && userCharName && !charList.some(c => c.name === userCharName)) {
        charList.push({ name: userCharName, tier: '用户', location: '当前' });
    }

    const cats = [
        ['chars', '角色状态'],
        ['world', '世界局势 / 新闻日报'],
        ['map', '地图'],
        ['quests', '主线 / 支线'],
        ['items', '道具'],
        ['foreshadow', '伏笔'],
        ['plot', '计划'],
        ['summary', '小总结'],
        ['bigSummary', '大总结'],
    ];
    const wsNow = settings.get('worldsim') || {};
    if (wsNow.enablePlayerPanel === true) cats.push(['player', '用户信息']);
    if (wsNow.enableReputation === true) cats.push(['rep', '声望 / 成就']);
    const checks = {};
    const catBox = document.createElement('div');
    catBox.className = 'nt-refresh-cats';
    for (const [key, label] of cats) {
        const lab = document.createElement('label');
        lab.className = 'nt-refresh-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.key = key;
        checks[key] = cb;
        const span = document.createElement('span');
        span.textContent = label;
        lab.appendChild(cb);
        lab.appendChild(span);
        catBox.appendChild(lab);
    }
    body.appendChild(catBox);

    const charWrap = document.createElement('div');
    charWrap.className = 'nt-refresh-chars';
    const charHead = document.createElement('div');
    charHead.className = 'nt-refresh-section';
    charHead.textContent = '角色（可单独勾选要更新的）';
    charWrap.appendChild(charHead);
    const charChecks = {};
    if (!charList.length) {
        const empty = document.createElement('div');
        empty.className = 'nt-refresh-note';
        empty.textContent = '角色索引为空，暂时没有可单独勾选的角色。';
        charWrap.appendChild(empty);
    } else {
        for (const c of charList) {
            const row = document.createElement('label');
            row.className = 'nt-refresh-char';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            charChecks[c.name] = cb;
            const name = document.createElement('span');
            name.className = 'nt-refresh-char-name';
            name.textContent = c.name;
            const meta = document.createElement('span');
            meta.className = 'nt-refresh-char-meta';
            meta.textContent = [c.tier, c.location].filter(Boolean).join(' · ');
            row.appendChild(cb);
            row.appendChild(name);
            row.appendChild(meta);
            charWrap.appendChild(row);
        }
    }
    const charDetails = document.createElement('details');
    charDetails.className = 'nt-refresh-details';
    const charSummary = document.createElement('summary');
    charSummary.textContent = `角色选择（${charList.length}）`;
    charDetails.appendChild(charSummary);
    charDetails.appendChild(charWrap);
    body.appendChild(charDetails);

    if (preselectName) {
        Object.values(checks).forEach(cb => { cb.checked = false; });
        Object.values(charChecks).forEach(cb => { cb.checked = false; });
        checks.chars.checked = true;
        if (charChecks[preselectName]) charChecks[preselectName].checked = true;
    }

    const quick = document.createElement('div');
    quick.className = 'nt-refresh-quick';
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'nt-quest-add';
    allBtn.textContent = '全选';
    allBtn.addEventListener('click', () => {
        Object.values(checks).forEach(cb => { cb.checked = true; });
        Object.values(charChecks).forEach(cb => { cb.checked = true; });
    });
    const noneBtn = document.createElement('button');
    noneBtn.type = 'button';
    noneBtn.className = 'nt-quest-add';
    noneBtn.textContent = '清空';
    noneBtn.addEventListener('click', () => {
        Object.values(checks).forEach(cb => { cb.checked = false; });
        Object.values(charChecks).forEach(cb => { cb.checked = false; });
    });
    quick.appendChild(allBtn);
    quick.appendChild(noneBtn);
    body.appendChild(quick);

    const modeRow = document.createElement('label');
    modeRow.className = 'nt-refresh-item';
    const modeLabel = document.createElement('span');
    modeLabel.textContent = '方式';
    const mode = document.createElement('select');
    mode.className = 'nt-edit-select';
    for (const [value, text] of [['fill', '补全当前状态'], ['advance', '推进到下一阶段']]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        mode.appendChild(opt);
    }
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(mode);
    body.appendChild(modeRow);

    const savedApi = settings.get('worldsim').refreshApi || {};
    let apiChoiceValue = savedApi.manualChoice === 'secondary' && (savedApi.url || savedApi.source) ? 'secondary' : 'main';
    const apiChoiceRow = document.createElement('div');
    apiChoiceRow.className = 'nt-refresh-item';
    const apiChoiceLabel = document.createElement('span');
    apiChoiceLabel.textContent = '本次更新使用';
    const apiButtons = document.createElement('div');
    apiButtons.className = 'nt-refresh-api-buttons';
    const apiBtnMap = {};
    const renderApiButtons = () => {
        for (const [value, btn] of Object.entries(apiBtnMap)) {
            btn.classList.toggle('primary', value === apiChoiceValue);
            btn.setAttribute('aria-pressed', value === apiChoiceValue ? 'true' : 'false');
        }
    };
    const chooseApi = (value) => {
        apiChoiceValue = value;
        settings.set('worldsim', {
            refreshApi: { ...(settings.get('worldsim').refreshApi || savedApi), manualChoice: value },
        });
        renderApiButtons();
    };
    for (const [value, text] of [['main', '主 API'], ['secondary', '副 API']]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nt-quick-btn-text';
        btn.textContent = text;
        btn.title = value === 'secondary' && !(savedApi.url || savedApi.source)
            ? '副 API 还没在设置里配置'
            : '';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            chooseApi(value);
        });
        apiBtnMap[value] = btn;
        apiButtons.appendChild(btn);
    }
    renderApiButtons();
    apiChoiceRow.appendChild(apiChoiceLabel);
    apiChoiceRow.appendChild(apiButtons);
    body.appendChild(apiChoiceRow);

    const autoRow = document.createElement('label');
    autoRow.className = 'nt-refresh-item';
    const autoCb = document.createElement('input');
    autoCb.type = 'checkbox';
    const hasRefreshApi = Boolean(String(savedApi.url || '').trim() || String(savedApi.source || '').trim());
    autoCb.checked = hasRefreshApi && savedApi.autoFull === true;
    autoCb.disabled = !hasRefreshApi;
    autoCb.title = hasRefreshApi ? '' : '先在设置里保存一套副 API 配置，自动全量更新才可用';
    const autoText = document.createElement('span');
    autoText.textContent = hasRefreshApi ? '每轮自动全量更新（副 API）' : '每轮自动全量更新（需先配置副 API）';
    autoRow.appendChild(autoCb);
    autoRow.appendChild(autoText);
    body.appendChild(autoRow);

    const retryRow = document.createElement('label');
    retryRow.className = 'nt-refresh-item';
    const retryLabel = document.createElement('span');
    retryLabel.textContent = '失败重试次数';
    const retryInput = document.createElement('input');
    retryInput.type = 'number';
    retryInput.min = '0';
    retryInput.max = '10';
    retryInput.step = '1';
    retryInput.inputMode = 'numeric';
    retryInput.className = 'nt-edit-select';
    retryInput.disabled = !hasRefreshApi;
    const savedRetry = Number(savedApi.retryCount);
    retryInput.value = String(Number.isFinite(savedRetry) ? Math.max(0, Math.min(10, Math.trunc(savedRetry))) : 3);
    retryRow.appendChild(retryLabel);
    retryRow.appendChild(retryInput);
    body.appendChild(retryRow);
    const saveRetry = () => {
        let n = Number(retryInput.value);
        if (!Number.isFinite(n)) n = 3;
        n = Math.max(0, Math.min(10, Math.trunc(n)));
        retryInput.value = String(n);
        settings.set('worldsim', {
            refreshApi: {
                ...(settings.get('worldsim').refreshApi || {}),
                retryCount: n,
            },
        });
    };
    retryInput.addEventListener('change', saveRetry);
    retryInput.addEventListener('blur', saveRetry);

    autoCb.addEventListener('change', () => {
        if (autoCb.checked && !hasRefreshApi) {
            autoCb.checked = false;
            toast('自动全量更新需要先在设置里保存副 API 配置', 'warning');
            return;
        }
        settings.set('worldsim', { refreshApi: { ...(settings.get('worldsim').refreshApi || {}), autoFull: autoCb.checked } });
    });

    const doSave = async () => {
        const selected = Object.entries(checks).filter(([, cb]) => cb.checked).map(([k]) => k);
        if (!selected.length) {
            toast('至少勾选一个类别', 'warning');
            return false;
        }
        const selectedChars = Object.keys(charChecks).filter(name => charChecks[name].checked);
        const doChars = selected.includes('chars');
        const effectiveChars = selectedChars.length ? selectedChars : charList.map(c => c.name);
        if (!(await backupBeforeWrite())) return false;
        const bookData = await stBridge.loadWorldInfoAsync(book);
        const get = (title) => {
            const entry = bookData && bookData.entries
                ? Object.values(bookData.entries).find(e => e && e.comment === title)
                : null;
            return entry ? String(entry.content || '').slice(0, 6000) : '';
        };
        const blocks = [];
        if (doChars) {
            if (effectiveChars.length) {
                blocks.push(`【索引】\n${get('索引') || '（空）'}`);
            } else {
                // 初始更新：索引为空时把角色卡和当前追踪书喂给模型，让它自己建初始角色
                const cur = stBridge.getCurrentCharacter?.();
                const card = cur
                    ? [cur.name, cur.description, cur.personality, cur.scenario].filter(Boolean).join('\n')
                    : '';
                if (card) blocks.push(`【角色卡】\n${card.slice(0, 3000)}`);
                const all = bookData && bookData.entries
                    ? Object.values(bookData.entries).filter(e => e && e.comment).map(e => `【${e.comment}】\n${String(e.content || '').slice(0, 800)}`).join('\n')
                    : '';
                if (all) blocks.push(`【当前追踪书】\n${all.slice(0, 5000)}`);
            }
        }
        if (selected.includes('world')) {
            blocks.push(`【世界·国家】\n${get('世界·国家') || '（空）'}`);
            blocks.push(`【世界·势力】\n${get('世界·势力') || '（空）'}`);
            blocks.push(`【新闻日报】\n${get('新闻日报') || '（空）'}`);
        }
        if (selected.includes('map')) blocks.push(`【地图】\n${get('地图') || '（空）'}`);
        if (selected.includes('quests')) {
            blocks.push(`【主线】\n${get('主线') || '（空）'}`);
            blocks.push(`【支线】\n${get('支线') || '（空）'}`);
        }
        if (selected.includes('items')) blocks.push(`【道具】\n${get('道具') || '（空）'}`);
        if (selected.includes('foreshadow')) blocks.push(`【伏笔】\n${get('伏笔') || '（空）'}`);
        if (selected.includes('plot')) blocks.push(`【计划】\n${get('计划') || '（空）'}`);
        if (selected.includes('summary')) blocks.push(`【小总结】\n${get('小总结') || '（空）'}`);
        if (selected.includes('bigSummary')) {
            blocks.push(`【大总结】\n${get('大总结') || '（空）'}`);
            blocks.push(`【小总结】\n${get('小总结') || '（空）'}`);
        }
        if (selected.includes('player')) blocks.push(`【玩家档案】\n${get('玩家档案') || '（空）'}`);
        if (selected.includes('rep')) blocks.push(`【声望】\n${get('声望') || '（空）'}`);
        if (selected.includes('summary') || selected.includes('bigSummary')) {
            const recentChat = (stBridge.getContext().chat || [])
                .slice(-6)
                .map(m => `${m.is_user ? '用户' : (m.name || '角色')}：${String(m.mes || '').slice(0, 1200)}`)
                .join('\n');
            if (recentChat) blocks.push(`【最近对话】\n${recentChat.slice(0, 6000)}`);
        }

        const gaps = await buildRefreshGaps(book);
        if (gaps.length) blocks.push(`【程序检查到的缺口】\n${gaps.map(g => `- ${g}`).join('\n')}\n本轮优先补这些结构缺口；没有合理内容也不要硬编。`);
        const schema = [];
        const userName = stBridge.getUserName() || '用户';
        const recordUserChar = settings.get('worldsim').recordUserCharacter === true;
        if (doChars) schema.push(`"chars": {"角色名": {"性别":"...","外貌":"...","人际关系":{"${userName}":"亲近：原因"},"状态":"...","后台运行":"A→B→C","长期目标":"...","近期打算":"...","关键记忆":["..."],"特殊变化":"...","关键词":["昵称","姓氏","名字","Mr. Smith","王先生"]}}`);
        if (selected.includes('world')) schema.push('"world": {"国家":{"名称":"方位｜类型｜政体｜领袖｜经济｜军事｜外交关系｜文化｜当前动向"},"势力":{"名称":"类型｜目标｜资源｜与主角关系｜当前动作"},"新闻日报":{"标题":"事件｜影响｜来源"}}');
        if (selected.includes('map')) schema.push('"map": {"regions":{"名称":"方位｜类型｜一句话"},"cities":{"区域名":{"城市名":"方位｜类型｜一句话"}},"sites":{"城市名":{"地点名":"方位｜类型｜出口：A、B｜路程：A=1天、B=10分钟｜可交互：...｜常驻：..."}}}');
        if (selected.includes('quests')) {
            schema.push('"main": {"标题":"...","目标":"...","阶段":"...","进度":0-100,"失败代价":"...","下一步":"..."}');
            schema.push('"quests": {"add": {"支线名":"类型｜目标｜状态｜期限(YYYY年MM月DD日/无)｜失败条件｜钩子｜地点｜下一步"}, "del":["支线名"]}');
        }
        if (selected.includes('items')) schema.push('"items": {"add": {"道具名": {"描述":"[类别] 描述","关键词":["具体词1","具体词2"]}}, "del":["道具名"]}');
        if (selected.includes('foreshadow')) schema.push('"foreshadow": {"add": {"伏笔名": {"描述":"[线索 | 指向] 描述","关键词":["具体词1","具体词2"]}}, "del":["伏笔名"]}');
        if (selected.includes('plot')) schema.push('"plot": {"add": {"计划名": {"描述":"[谁 | 做什么 | 状态] 描述","关键词":["具体词1","具体词2"]}}, "del":["计划名"]}');
        if (selected.includes('summary')) schema.push('"summary": "100字内，具体事件/承诺/道具/关系变化"');
        if (selected.includes('bigSummary')) schema.push('"bigSummary": "约2000 token，按时间顺序总结至此剧情，保留关键事件/关系变化/伏笔"');
        if (selected.includes('player')) schema.push('"player": {"名字":"","身份":"","钱":0,"道具":[{"名称","数量","位置","状态","备注"}],"删除道具":["名"],"资产":[{"名称","状态","产出","备注"}],"关系":[{"对象","标签","原因"}],"承诺":[{"谁","什么","期限","状态"}],"状态":[""],"移除状态":[""]}');
        if (selected.includes('rep')) schema.push('"rep": {"成就":[["名称","原因","备注","谁知道"]],"名声":[["地区/势力","等级","原因"]]}');

        const contract = buildRefreshContract({
            chars: doChars,
            items: selected.includes('items'),
            plot: selected.includes('plot'),
            world: selected.includes('world'),
            foreshadow: selected.includes('foreshadow'),
            map: selected.includes('map'),
            quests: selected.includes('quests'),
            summary: selected.includes('summary'),
            bigSummary: selected.includes('bigSummary'),
            player: selected.includes('player'),
            reputation: selected.includes('rep'),
            statecheck: settings.get('worldsim').enableStateCheck === true,
            cognition: settings.get('worldsim').enableCognition === true,
            userName,
            recordUserChar,
        });

        const charLine = doChars
            ? (effectiveChars.length
                ? `本轮只更新这些角色：${effectiveChars.join('、')}；不要输出其他人。`
                : '角色索引为空：请根据角色卡和当前追踪书初始化主要角色（包括必要 NPC），不要留空。')
            : '';
        const userLine = recordUserChar
            ? `用户角色「${userName}」也可以作为一条角色档案更新。`
            : `不要更新用户角色「${userName}」的角色档案。`;
        const prompt = `你是 NEKOTOOL 的后台世界更新器。只输出一个 JSON 对象，不要正文、不要 markdown 代码块、不要解释。
方式：${mode.value === 'advance' ? '推进到下一阶段（让时间/事件往前走，可新增支线与人物变化）' : '补全当前状态（把缺的细节补全，不主动推进时间）'}。
${charLine}
${userLine}
当前数据：
${blocks.join('\n\n')}

请只更新这些类别，只写本轮需要变化/新增的内容：
${schema.join('\n')}

【默认契约】
${contract}
要求：人物位置用地图小地点名；没有变化就留空对象；不要编造与当前数据冲突的内容。
计划/伏笔/道具必须使用对象格式，并带 2–3 个「关键词」：2–6 字，必须是正文会原样出现的具体人名/地名/物件/动作；不要写“XX疑云、XX寻踪”这种标题式抽象词，也不要写句子碎片。`;

        try {
            toast('正在生成更新…', 'info');
            const apiCfg = { ...(settings.get('worldsim').refreshApi || savedApi), manualChoice: apiChoiceValue, autoFull: autoCb.checked };
            settings.set('worldsim', { refreshApi: apiCfg });
            const useSub = apiChoiceValue === 'secondary' && Boolean(apiCfg.url || apiCfg.source);
            let raw;
            if (useSub) {
                raw = await generateRefreshApi(prompt, apiCfg);
            } else {
                // 主 API 的静默生成走 ST 内部全局静默（无法按请求打标记），
                // 期间用户发消息会被跳过：用横幅明确提示。
                showAutoUpdateBanner('正在后台更新（主 API），建议更新结束再继续下一轮', false);
                try {
                    raw = await generateQuiet(prompt);
                } finally {
                    hideAutoUpdateBanner();
                }
            }
            const text = String(raw || '');
            const a = text.indexOf('{');
            const b = text.lastIndexOf('}');
            if (a < 0 || b <= a) throw new Error('模型没有返回 JSON');
            const data = JSON.parse(text.slice(a, b + 1));
            if (data.chars && typeof data.chars === 'object' && !Array.isArray(data.chars)) {
                const filtered = {};
                for (const name of effectiveChars) {
                    if (data.chars[name]) filtered[name] = data.chars[name];
                }
                data.chars = !doChars ? {} : (effectiveChars.length ? filtered : data.chars);
            }
            const summary = await applyRefreshData(book, data, currentLayerNo());
            if (summary.summary || summary.bigSummary) {
                await stBridge.hideSummarizedMessages(Number(settings.get('worldsim').hideKeepCount) || 0, book);
            }
            const bits = [
                summary.chars ? `角色 ${summary.chars}` : '',
                summary.world ? `世界 ${summary.world}` : '',
                summary.map ? `地图 ${summary.map}` : '',
                summary.main ? '主线' : '',
                summary.quests ? `支线 ${summary.quests}` : '',
                summary.items ? `道具 ${summary.items}` : '',
                summary.foreshadow ? `伏笔 ${summary.foreshadow}` : '',
                summary.plot ? `计划 ${summary.plot}` : '',
            ].filter(Boolean);
            const bitsText = bits.length ? bits.join(' / ') : '没有变化';
            settings.set('worldsim', { lastRefresh: { at: Date.now(), bits: bitsText } });
            toast(bits.length ? `更新完成：${bitsText}` : '更新完成（没有变化）', 'success');
            return true;
        } catch (e) {
            console.warn('[nekotools] 请求更新失败', e);
            toast(e && e.message ? `更新失败：${e.message}` : '更新失败', 'error');
            return false;
        }
    };

    let updating = false;
    const save = async () => {
        if (updating) return false;
        updating = true;
        try {
            return await doSave();
        } finally {
            updating = false;
        }
    };

    openModal({
        title: '请求更新',
        body,
        footer: [
            { label: '开始更新', primary: true, onClick: save },
            { label: '取消' },
        ],
    });
}

async function showEditModal() {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const bookData = await stBridge.loadWorldInfoAsync(book);
    if (!bookData || !bookData.entries) {
        toast('追踪书不存在', 'error');
        return;
    }

    const titles = ['主线', '支线', '可办事项', '世界·国家', '世界·势力', '新闻日报', '地图', '索引', '道具', '伏笔', '计划', '小总结', '大总结', '剧情推演'];
    const body = document.createElement('div');
    body.className = 'nt-edit';
    const select = document.createElement('select');
    select.className = 'nt-edit-select';
    for (const title of titles) {
        const opt = document.createElement('option');
        opt.value = title;
        opt.textContent = title;
        select.appendChild(opt);
    }
    const area = document.createElement('textarea');
    area.className = 'nt-edit-area';
    area.rows = 18;
    body.appendChild(select);
    body.appendChild(area);

    const find = (title) => Object.values(bookData.entries).find(e => e && e.comment === title) || null;
    const load = () => {
        const entry = find(select.value);
        area.value = entry ? String(entry.content || '') : '';
    };
    select.addEventListener('change', load);
    load();

    const defaults = {
        '主线': { order: 810, pos: 0, constant: true },
        '支线': { order: 812, pos: 0, constant: true },
        '世界·国家': { order: 999, pos: 0, constant: false },
        '世界·势力': { order: 999, pos: 0, constant: false },
        '新闻日报': { order: 999, pos: 0, constant: false },
        '地图': { order: 830, pos: 0, constant: true },
        '索引': { order: 850, pos: 0, constant: true },
        '道具': { order: 900, pos: 0, constant: false },
        '伏笔': { order: 920, pos: 0, constant: false },
        '计划': { order: 910, pos: 0, constant: true },
        '小总结': { order: 999, pos: 4, constant: true },
        '大总结': { order: 9999, pos: 4, constant: true },
        '剧情推演': { order: 999, pos: 0, constant: true },
        '可办事项': { order: 815, pos: 0, constant: true },
    };

    const save = async () => {
        const title = select.value;
        const text = area.value;
        let problem = '';
        if (title === '主线' && !/标题[：:]/.test(text) && !/目标[：:]/.test(text)) {
            problem = '主线至少要有「标题：」或「目标：」';
        } else if (title === '支线' && !/【以下为支线】/.test(text) && !/^-\s*\S+/m.test(text)) {
            problem = '支线需要「【以下为支线】」或至少一行「- 名称｜…」';
        } else if (title === '地图' && !/【大地图】/.test(text)) {
            problem = '地图需要【大地图】段';
        } else if (title === '索引' && !/【角色】/.test(text)) {
            problem = '索引需要【角色】段';
        }
        if (problem) {
            toast(`${problem}，已停止保存`, 'error');
            return false;
        }
        const fresh = await stBridge.loadWorldInfoAsync(book, true);
        if (!fresh || !fresh.entries || !(await stBridge.bookExists(book))) {
            toast('追踪书不存在或已被删除，已停止保存', 'error');
            return false;
        }
        if (!(await backupBeforeWrite())) return false;
        const entry = Object.values(fresh.entries).find(e => e && e.comment === title) || null;
        const fallback = defaults[title] || { order: 999, pos: 0, constant: true };
        const extra = {
            position: entry ? entry.position : fallback.pos,
            depth: entry ? entry.depth : 0,
            order: entry ? entry.order : fallback.order,
        };
        stBridge.upsertEntryInBook(fresh, title, area.value, {
            isConstant: entry ? Boolean(entry.constant) : fallback.constant,
            keywords: entry && Array.isArray(entry.key) ? entry.key : [],
            extra,
        });
        await stBridge.persistLorebook(book, fresh);
        toast(`已保存「${title}」`, 'success');
        return true;
    };

    openModal({
        title: '手动修改',
        body,
        wide: true,
        footer: [
            { label: '保存', primary: true, onClick: save },
            { label: '关闭' },
        ],
    });
}

// ========== 玩家信息 / 声望 ==========

function playerPanelOn() {
    const cfg = settings.get('worldsim') || {};
    return cfg.enablePlayerPanel === true;
}

function reputationOn() {
    const cfg = settings.get('worldsim') || {};
    return cfg.enableReputation === true;
}

/** 菜单项显隐只在打开菜单时刷新（用户信息里合并了声望，任一开关开就显示） */
function applyPlayerMenuFlags(pop) {
    if (!pop) return;
    const show = playerPanelOn() || reputationOn();
    for (const row of pop.querySelectorAll('.nt-quick-item')) {
        if (row.dataset.key === 'player') row.style.display = show ? '' : 'none';
    }
}

function playerLine(parts) {
    const list = parts.map(v => String(v ?? '').trim());
    while (list.length && !list[list.length - 1]) list.pop();
    return list.join('｜');
}

function playerSplit(line) {
    return String(line ?? '').split(/[｜|]/).map(s => s.trim());
}

function playerLines(text) {
    return String(text ?? '').split('\n').map(s => s.trim()).filter(Boolean);
}

function playerTags(value) {
    if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean);
    if (typeof value === 'string') return value.split(/[，,、;；\n]/).map(s => s.trim()).filter(Boolean);
    return [];
}

function playerAmount(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function playerCount(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function playerSection(titleText) {
    const sec = document.createElement('div');
    sec.className = 'nt-player-section';
    if (titleText) {
        const title = document.createElement('div');
        title.className = 'nt-player-section-title';
        title.textContent = titleText;
        sec.appendChild(title);
    }
    return sec;
}

function playerField(labelText, control, hintText) {
    const field = document.createElement('label');
    field.className = 'nt-player-field';
    const label = document.createElement('span');
    label.className = 'nt-player-label';
    label.textContent = labelText;
    field.appendChild(label);
    field.appendChild(control);
    if (hintText) {
        const hint = document.createElement('span');
        hint.className = 'nt-player-hint';
        hint.textContent = hintText;
        field.appendChild(hint);
    }
    return field;
}

function playerInput(value, type = 'text') {
    const input = document.createElement('input');
    input.type = type;
    input.className = 'nt-player-input';
    input.value = value === undefined || value === null ? '' : String(value);
    if (type === 'number') {
        input.min = '0';
        input.step = '1';
    }
    return input;
}

function playerArea(value, rows = 4, placeholder = '') {
    const area = document.createElement('textarea');
    area.className = 'nt-player-area';
    area.rows = rows;
    area.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) area.placeholder = placeholder;
    return area;
}

function playerBriefRow(labelText, value) {
    const row = document.createElement('div');
    row.className = 'nt-player-brief-row';
    const label = document.createElement('span');
    label.className = 'nt-player-brief-label';
    label.textContent = labelText;
    const val = document.createElement('span');
    val.className = 'nt-player-brief-value';
    if (value instanceof Node) val.appendChild(value);
    else val.textContent = String(value ?? '');
    row.appendChild(label);
    row.appendChild(val);
    return row;
}

function playerTagsEl(tags) {
    if (!tags.length) {
        const none = document.createElement('span');
        none.className = 'nt-player-hint';
        none.textContent = '无';
        return none;
    }
    const wrap = document.createElement('span');
    wrap.className = 'nt-player-tags';
    for (const tag of tags) {
        const el = document.createElement('span');
        el.className = 'nt-player-tag';
        el.textContent = tag;
        wrap.appendChild(el);
    }
    return wrap;
}

function parsePlayerItems(text) {
    return playerLines(text).map(line => {
        const p = playerSplit(line);
        if (!p[0]) return null;
        return { name: p[0], count: playerCount(p[1]), place: p[2] || '', state: p[3] || '', note: p[4] || '' };
    }).filter(Boolean);
}

function parsePlayerAssets(text) {
    return playerLines(text).map(line => {
        const p = playerSplit(line);
        if (!p[0]) return null;
        return { name: p[0], state: p[1] || '', income: p[2] || '', note: p[3] || '' };
    }).filter(Boolean);
}

function parsePlayerRelations(text) {
    return playerLines(text).map(line => {
        const p = playerSplit(line);
        if (!p[0]) return null;
        return { name: p[0], tag: p[1] || '', reason: p[2] || '' };
    }).filter(Boolean);
}

function parsePlayerPromises(text) {
    return playerLines(text).map(line => {
        const p = playerSplit(line);
        if (!p[0]) return null;
        return { who: p[0], what: p[1] || '', due: p[2] || '', status: p[3] || '' };
    }).filter(Boolean);
}

/** debt（欠人情）不在编辑格子里露出来，但保存时不能丢 */
function keepRelationDebt(rows, previous) {
    const old = Array.isArray(previous) ? previous : [];
    return rows.map(row => {
        const prev = old.find(x => x && String(x.name || '').trim() === row.name);
        return prev && prev.debt ? { ...row, debt: prev.debt } : row;
    });
}

function playerReadClock(book) {
    let clock = null;
    try { clock = readClock(); } catch (_) {}
    if (!clock || (!clock.time && !clock.place)) {
        try {
            const meta = getSlotMeta(book);
            if (meta && meta.clock) clock = meta.clock;
        } catch (_) {}
    }
    return clock;
}

function buildPlayerBrief(book, profile) {
    const sec = playerSection('概况');
    sec.classList.add('nt-player-brief');
    const name = String(profile.name ?? '').trim();
    const identity = String(profile.identity ?? '').trim();
    sec.appendChild(playerBriefRow('名字', name || '未填写'));
    sec.appendChild(playerBriefRow('身份', identity || '未填写'));

    const clock = playerReadClock(book);
    sec.appendChild(playerBriefRow('当前时间', clock && clock.time ? clock.time : '未知'));
    sec.appendChild(playerBriefRow('当前地点', clock && clock.place ? clock.place : '未知'));
    sec.appendChild(playerBriefRow('状态标签', playerTagsEl(playerTags(profile.status))));

    let summary = '';
    try { summary = String(formatPlayerSummary(profile) || '').trim(); } catch (_) {}
    if (summary) {
        const hint = document.createElement('div');
        hint.className = 'nt-player-hint';
        hint.textContent = summary;
        sec.appendChild(hint);
    }
    return sec;
}

function buildReputationSection(rep, titleText, emptyText = '还没有记录') {
    const sec = playerSection(titleText);
    sec.classList.add('nt-rep');
    const achievements = rep && Array.isArray(rep.achievements) ? rep.achievements : [];
    const reputations = rep && Array.isArray(rep.reputations) ? rep.reputations : [];

    if (!achievements.length && !reputations.length) {
        const empty = document.createElement('div');
        empty.className = 'nt-rep-empty';
        empty.textContent = emptyText;
        sec.appendChild(empty);
        return sec;
    }

    if (achievements.length) {
        const sub = document.createElement('div');
        sub.className = 'nt-rep-section-title';
        sub.textContent = '成就';
        sec.appendChild(sub);
        for (const ach of achievements) {
            const card = document.createElement('div');
            card.className = 'nt-rep-card';
            const head = document.createElement('div');
            head.className = 'nt-rep-card-head';
            const icon = document.createElement('span');
            icon.className = 'nt-rep-card-icon';
            icon.textContent = '✦';
            const name = document.createElement('div');
            name.className = 'nt-rep-card-name';
            name.textContent = String(ach.name || '未命名成就');
            head.appendChild(icon);
            head.appendChild(name);
            card.appendChild(head);
            for (const [cls, label, value] of [
                ['nt-rep-card-reason', '原因：', ach.reason],
                ['nt-rep-card-note', '备注：', ach.note],
                ['nt-rep-card-known', '谁知道：', ach.known],
            ]) {
                if (!value) continue;
                const el = document.createElement('div');
                el.className = cls;
                el.textContent = label + String(value);
                card.appendChild(el);
            }
            sec.appendChild(card);
        }
    }

    if (reputations.length) {
        const sub = document.createElement('div');
        sub.className = 'nt-rep-section-title';
        sub.textContent = '名声';
        sec.appendChild(sub);
        const list = document.createElement('div');
        list.className = 'nt-rep-list';
        for (const row of reputations) {
            const item = document.createElement('div');
            item.className = 'nt-rep-row';
            const who = document.createElement('span');
            who.className = 'nt-rep-who';
            who.textContent = `${String(row.target || '')}：`;
            const view = document.createElement('span');
            view.className = 'nt-rep-view' + (row.level ? ' nt-rep-view-level' : '');
            view.textContent = row.level
                ? `${row.level}${row.reason ? `｜${row.reason}` : ''}`
                : String(row.view || '');
            item.appendChild(who);
            item.appendChild(view);
            list.appendChild(item);
        }
        sec.appendChild(list);
    }
    return sec;
}

function buildSubTabs(items, activeKey, onSelect) {
    const bar = document.createElement('div');
    bar.className = 'nt-subtabs';
    for (const item of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nt-subtab' + (item.key === activeKey ? ' active' : '');
        b.textContent = item.label;
        b.addEventListener('click', () => onSelect(item.key));
        bar.appendChild(b);
    }
    return bar;
}

async function showUserInfoModal(activeTab = 'basic') {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const body = document.createElement('div');
    body.className = 'nt-user-info';
    body.appendChild(buildSubTabs([
        { key: 'basic', label: '基础信息' },
        { key: 'economy', label: '经营资产' },
        { key: 'faction', label: '组织势力' },
        { key: 'culture', label: '文娱创作' },
    ], activeTab, (key) => { closeModal(); setTimeout(() => showUserInfoModal(key).catch(e => toast(String(e?.message || e), 'error')), 0); }));

    if (activeTab === 'basic') {
        const loaded = await stBridge.loadPlayerProfile(book);
        const profile = normalizePlayerProfile(loaded || {});
        body.appendChild(buildPlayerBrief(book, profile));
        const hint = document.createElement('div');
        hint.className = 'nt-player-hint';
        hint.textContent = '这里只展示玩家基础信息；完整的道具、资产、关系、承诺和声望在「完整基础信息」里。';
        body.appendChild(hint);
        const bar = document.createElement('div');
        bar.className = 'nt-quick-char-actions';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'nt-quick-btn-text primary';
        open.textContent = '完整基础信息';
        open.addEventListener('click', () => { closeModal(); setTimeout(() => showPlayerInfoModal().catch(e => toast(String(e?.message || e), 'error')), 0); });
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'nt-quick-btn-text';
        edit.textContent = '手动编辑';
        edit.addEventListener('click', () => { closeModal(); setTimeout(() => showPlayerInfoModal(true).catch(e => toast(String(e?.message || e), 'error')), 0); });
        bar.appendChild(open);
        bar.appendChild(edit);
        body.appendChild(bar);
    } else if (activeTab === 'economy') {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = '经营资产面板骨架已接入。账户、股票、店铺、产业功能在后续版本实现。';
        body.appendChild(note);
    } else if (activeTab === 'faction') {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = '组织势力面板骨架已接入。玩家势力、人员名单、据点信息在后续版本实现。';
        body.appendChild(note);
    } else {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = '文娱创作未激活。还没有作品；想写小说、画画、演戏、作曲，直接在剧情里开始。';
        body.appendChild(note);
    }

    openModal({
        title: '用户信息',
        body,
        wide: true,
        footer: [{ label: '关闭', primary: true }],
    });
}

async function showPlotInfoModal(activeTab = 'preview') {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const body = document.createElement('div');
    body.className = 'nt-plot-info';
    body.appendChild(buildSubTabs([
        { key: 'preview', label: '剧情推演' },
        { key: 'quests', label: '可办事项' },
        { key: 'settings', label: '剧情设置' },
    ], activeTab, (key) => { closeModal(); setTimeout(() => showPlotInfoModal(key).catch(e => toast(String(e?.message || e), 'error')), 0); }));

    if (activeTab === 'preview') {
        let text = '';
        try {
            const bookData = await stBridge.loadWorldInfoAsync(book, true);
            const entry = Object.values(bookData?.entries || {}).find(e => e && e.comment === '剧情推演');
            text = String(entry?.content || '').trim();
        } catch (_) {}
        const box = document.createElement('pre');
        box.className = 'nt-plot-preview';
        box.textContent = text || '暂无剧情推演。等世界更新或手动修改后，这里会显示行动推演。';
        body.appendChild(box);
    } else if (activeTab === 'quests') {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = '可办事项包含主线、支线和 AI 更新的附近新鲜事。';
        body.appendChild(note);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nt-quick-btn-text primary';
        btn.textContent = '打开可办事项';
        btn.addEventListener('click', () => { closeModal(); setTimeout(() => showQuestsModal().catch(e => toast(String(e?.message || e), 'error')), 0); });
        body.appendChild(btn);
    } else {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = '剧情设置后续扩展：难度分级、剧情风格、规则开关。当前先保留入口。';
        body.appendChild(note);
    }

    openModal({
        title: '剧情信息',
        body,
        wide: true,
        footer: [{ label: '关闭', primary: true }],
    });
}

async function showDisasterModal() {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }
    const body = document.createElement('div');
    body.className = 'nt-disaster-info';
    let text = '';
    try {
        const bookData = await stBridge.loadWorldInfoAsync(book, true);
        const entry = Object.values(bookData?.entries || {}).find(e => e && (e.comment === '世界灾变' || e.comment === '天灾'));
        text = String(entry?.content || '').trim();
    } catch (_) {}
    const note = document.createElement('div');
    note.className = 'nt-quick-note';
    note.textContent = text ? '' : '当前没有世界灾变。灾变只能通过剧情触发，插件不在面板里快速创建。';
    if (text) {
        const box = document.createElement('pre');
        box.className = 'nt-plot-preview';
        box.textContent = text;
        body.appendChild(box);
    } else {
        body.appendChild(note);
    }
    openModal({
        title: '世界灾变',
        body,
        wide: true,
        footer: [{ label: '关闭', primary: true }],
    });
}

async function showPlayerInfoModal(edit = false) {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }

    const loaded = await stBridge.loadPlayerProfile(book);
    const profile = normalizePlayerProfile(loaded || {});

    const body = document.createElement('div');
    body.className = 'nt-player';
    body.appendChild(buildPlayerBrief(book, profile));

    const itemRows = Array.isArray(profile.items) ? profile.items : [];
    const assetRows = Array.isArray(profile.assets) ? profile.assets : [];
    const relationRows = Array.isArray(profile.relations) ? profile.relations : [];
    const promiseRows = Array.isArray(profile.promises) ? profile.promises : [];

    if (!edit) {
        // 只读页：所有信息按行展示，底部只有一个「手动编辑」
        const addSection = (titleText, rows) => {
            const sec = playerSection(titleText);
            if (!rows.length) {
                const none = document.createElement('div');
                none.className = 'nt-player-hint';
                none.textContent = '（无）';
                sec.appendChild(none);
            } else {
                for (const [label, value] of rows) sec.appendChild(playerBriefRow(label, value));
            }
            body.appendChild(sec);
        };
        addSection('道具', itemRows.map(it => [
            it.name,
            [
                it.count ? `×${it.count}` : '',
                it.place ? `位置：${it.place}` : '',
                it.state ? `状态：${it.state}` : '',
                it.note || '',
            ].filter(Boolean).join('｜') || '—',
        ]));
        addSection('资产', assetRows.map(it => [
            it.name,
            [it.state ? `状态：${it.state}` : '', it.income ? `产出：${it.income}` : '', it.note || ''].filter(Boolean).join('｜') || '—',
        ]));
        addSection('人际关系', relationRows.map(it => [
            it.name,
            [it.tag || '', it.reason || '', it.debt ? `欠：${it.debt}` : ''].filter(Boolean).join('｜') || '—',
        ]));
        addSection('承诺', promiseRows.map(it => [
            it.who,
            [it.what || '', it.due ? `期限：${it.due}` : '', it.status || ''].filter(Boolean).join('｜') || '—',
        ]));

        if (reputationOn()) {
            let rep = null;
            try {
                rep = await stBridge.readReputation(book);
            } catch (e) {
                console.warn('[nekotools] 声望读取失败', e);
            }
            body.appendChild(buildReputationSection(rep, '声望与成就'));
        }

        const hint = document.createElement('div');
        hint.className = 'nt-player-hint';
        hint.textContent = '只读；需要改就点下面的「手动编辑」。';
        body.appendChild(hint);

        const reopen = (nextEdit) => {
            closeModal();
            setTimeout(() => { showPlayerInfoModal(nextEdit).catch(e => toast(String(e?.message || e), 'error')); }, 0);
        };
        openModal({
            title: '用户信息',
            body,
            wide: true,
            footer: [
                { label: '手动编辑', primary: true, onClick: () => { reopen(true); return false; } },
                { label: '关闭' },
            ],
        });
        return;
    }

    // 手动编辑页：只在点「手动编辑」后出现
    const basic = playerSection('身份与金钱');
    const nameInput = playerInput(profile.name);
    const identityInput = playerInput(profile.identity);
    const moneyInput = playerInput(profile.money, 'number');
    basic.appendChild(playerField('名字', nameInput));
    basic.appendChild(playerField('身份', identityInput));
    basic.appendChild(playerField('钱', moneyInput, '只填数字，留空按 0 算'));
    body.appendChild(basic);

    const itemsSec = playerSection('道具');
    const itemsArea = playerArea(itemRows.map(it => playerLine([
        it.name, it.count, it.place, it.state, it.note,
    ])).join('\n'), 5, '名称｜数量｜位置｜状态｜备注');
    itemsSec.appendChild(playerField('道具清单', itemsArea, '每行：名称｜数量｜位置｜状态｜备注'));
    body.appendChild(itemsSec);

    const assetsSec = playerSection('资产');
    const assetsArea = playerArea(assetRows.map(it => playerLine([
        it.name, it.state, it.income, it.note,
    ])).join('\n'), 4, '名称｜状态｜产出｜备注');
    assetsSec.appendChild(playerField('资产清单', assetsArea, '每行：名称｜状态｜产出｜备注'));
    body.appendChild(assetsSec);

    const relationsSec = playerSection('人际关系');
    const relationsArea = playerArea(relationRows.map(it => playerLine([
        it.name, it.tag, it.reason,
    ])).join('\n'), 4, '对象｜标签｜原因');
    relationsSec.appendChild(playerField('关系清单', relationsArea, '每行：对象｜标签｜原因'));
    body.appendChild(relationsSec);

    const promisesSec = playerSection('承诺');
    const promisesArea = playerArea(promiseRows.map(it => playerLine([
        it.who, it.what, it.due, it.status,
    ])).join('\n'), 4, '谁｜什么｜期限｜状态');
    promisesSec.appendChild(playerField('承诺清单', promisesArea, '每行：谁｜什么｜期限｜状态'));
    body.appendChild(promisesSec);

    const statusSec = playerSection('状态');
    const statusArea = playerArea(playerTags(profile.status).join('，'), 2, '受伤，疲惫');
    statusSec.appendChild(playerField('状态标签', statusArea, '逗号分隔，例如：受伤，疲惫'));
    body.appendChild(statusSec);

    const reopen = (nextEdit) => {
        closeModal();
        setTimeout(() => { showPlayerInfoModal(nextEdit).catch(e => toast(String(e?.message || e), 'error')); }, 0);
    };

    const save = async () => {
        const next = normalizePlayerProfile(profile);
        next.name = nameInput.value.trim();
        next.identity = identityInput.value.trim();
        next.money = playerAmount(moneyInput.value, 0);
        next.items = parsePlayerItems(itemsArea.value);
        next.assets = parsePlayerAssets(assetsArea.value);
        next.relations = keepRelationDebt(parsePlayerRelations(relationsArea.value), profile.relations);
        next.promises = parsePlayerPromises(promisesArea.value);
        next.status = playerTags(statusArea.value);
        const ok = await stBridge.savePlayerProfile(book, next);
        if (ok === false) {
            toast('保存失败：追踪书不存在或写入被拒绝', 'error');
            return false;
        }
        // 让索引顶部的玩家摘要立刻更新（下一轮注入看到的是新数据）
        try { await refreshIndexHeader(book); } catch (_) {}
        toast('已保存', 'success');
        reopen(false);
        return false;
    };

    openModal({
        title: '用户信息 · 手动编辑',
        body,
        wide: true,
        footer: [
            { label: '保存', primary: true, onClick: save },
            { label: '取消', onClick: () => { reopen(false); return false; } },
        ],
    });
}

function buildPop() {
    if ($(POP_ID)) return;

    const pop = document.createElement('div');
    pop.id = POP_ID;
    pop.className = 'nt-quick-pop';
    pop.hidden = true;

    const head = document.createElement('div');
    head.className = 'nt-quick-pop-head';
    head.innerHTML = '<span class="nt-quick-dot"></span><div class="nt-quick-pop-titles"><span class="nt-quick-pop-title">NEKOTOOL</span><span class="nt-quick-pop-sub">WORLD SIMULATION / QUICK ACCESS</span></div><span class="nt-quick-pop-tag">QUICK</span>';

    const status = document.createElement('div');
    status.className = 'nt-quick-status';
    status.innerHTML = '<span class="nt-quick-status-tag nt-quick-status-tracking"><span class="nt-quick-status-square"></span>TRACKING</span><span class="nt-quick-status-tag nt-quick-status-book">0 ACTIVE BOOK</span><button type="button" class="nt-quick-status-collapse">收起</button>';
    status.querySelector('.nt-quick-status-collapse').addEventListener('click', (e) => {
        e.stopPropagation();
        closePop();
    });

    const banner = document.createElement('div');
    banner.id = 'nt-quick-jump';
    banner.className = 'nt-quick-jump';
    banner.hidden = true;
    const bannerText = document.createElement('span');
    bannerText.className = 'nt-quick-jump-text';
    const bannerX = document.createElement('button');
    bannerX.type = 'button';
    bannerX.className = 'nt-quick-jump-x';
    bannerX.textContent = '×';
    bannerX.title = '知道了，先不提示';
    bannerX.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissJump();
    });
    banner.appendChild(bannerText);
    banner.appendChild(bannerX);

    const list = document.createElement('div');
    list.className = 'nt-quick-pop-list';

    const menuGroups = [
        {
            key: 'user', label: '用户信息', hint: '基础 / 经营 / 组织 / 文娱',
            children: [
                { key: 'player', label: '基础信息', hint: '档案 / 声望 / 状态' },
                { key: 'economy', label: '经营资产', hint: '账户 / 股票 / 店铺 / 产业' },
                { key: 'faction', label: '组织势力', hint: '玩家势力 / 人员 / 据点' },
                { key: 'culture', label: '文娱创作', hint: '作品 / 评论 / 榜单 / 奖项' },
            ],
        },
        {
            key: 'world', label: '世界信息', hint: '时钟 / 地图 / 新闻 / 日志 / 灾变',
            children: [
                { key: 'clock', label: '世界时钟', hint: '时间 / 地点 / 天气' },
                { key: 'map', label: '地图', hint: '区域 / 城市 / 小地点' },
                { key: 'news', label: '新闻日报', hint: '每游戏日更新 / 最多6条' },
                { key: 'log', label: '世界日志', hint: '最近的角色 / 世界 / 支线变化' },
                { key: 'disaster', label: '世界灾变', hint: '当前天灾 / 阶段 / 日志' },
            ],
        },
        {
            key: 'plot', label: '剧情信息', hint: '剧情推演 / 可办事项 / 剧情设置',
            children: [
                { key: 'preview', label: '剧情推演', hint: '行动推演 / 难度风险' },
                { key: 'quests', label: '可办事项', hint: '主线 / 支线 / 附近新鲜事' },
                { key: 'plotSettings', label: '剧情设置', hint: '难度 / 剧情规则（后续扩展）' },
            ],
        },
        { key: 'roster', label: '角色管理', hint: '档案 / 当下 / 幕后 / 认知 / 关系', action: 'roster' },
        {
            key: 'settings', label: '设置', hint: '快捷行动 / 更新 / 存档 / 手修',
            children: [
                { key: 'action', label: '快捷行动', hint: '找谁 / 做什么 / 去哪' },
                { key: 'refresh', label: '请求更新', hint: '按角色/类别静默更新' },
                { key: 'slots', label: '存档', hint: '新建 / 切换 / 存读档' },
                { key: 'edit', label: '手动修改', hint: '直接编辑追踪书条目' },
            ],
        },
    ];

    const runMenuKey = (key, label) => {
        closePop();
        if (key === 'player') showUserInfoModal('basic').catch(err => toast(`打开用户信息失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'economy') showUserInfoModal('economy').catch(err => toast(`打开经营资产失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'faction') showUserInfoModal('faction').catch(err => toast(`打开组织势力失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'culture') showUserInfoModal('culture').catch(err => toast(`打开文娱创作失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'clock') showClockModal();
        else if (key === 'news') showNewsModal();
        else if (key === 'log') showWorldLogModal();
        else if (key === 'disaster') showDisasterModal().catch(err => toast(`打开世界灾变失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'preview') showPlotInfoModal('preview').catch(err => toast(`打开剧情推演失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'quests') showQuestsModal().catch(err => toast(`打开可办事项失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'plotSettings') showPlotInfoModal('settings').catch(err => toast(`打开剧情设置失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'roster') showRosterModal().catch(err => toast(`打开角色管理失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'action') showActionModal().catch(err => toast(`打开快捷行动失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'map') showMapModal().catch(err => toast(`打开地图失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'refresh') showRefreshModal().catch(err => toast(`打开请求更新失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'edit') showEditModal().catch(err => toast(`打开手动修改失败：${err && err.message ? err.message : err}`, 'error'));
        else if (key === 'slots') showSlotsModal();
        else showSoon(label || '该功能');
    };

    const makeMenuRow = (item, onClick) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nt-quick-item';
        row.dataset.key = item.key || '';
        const label = document.createElement('span');
        label.className = 'nt-quick-item-label';
        label.textContent = item.label;
        const hint = document.createElement('span');
        hint.className = 'nt-quick-item-hint';
        hint.textContent = item.hint || '';
        row.appendChild(label);
        row.appendChild(hint);
        row.addEventListener('click', onClick);
        return row;
    };

    const renderMenuRoot = () => {
        list.textContent = '';
        menuGroups.forEach((group, index) => {
            const head = document.createElement('div');
            head.className = 'nt-quick-group';
            head.textContent = `${String(index + 1).padStart(2, '0')} / ${group.label}`;
            list.appendChild(head);
            const row = makeMenuRow(group, () => {
                if (group.action) runMenuKey(group.action, group.label);
                else renderMenuGroup(group);
            });
            list.appendChild(row);
        });
        applyPlayerMenuFlags(list);
    };

    const renderMenuGroup = (group) => {
        list.textContent = '';
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'nt-quick-item nt-quick-back';
        back.textContent = `← 返回 / ${group.label}`;
        back.addEventListener('click', renderMenuRoot);
        list.appendChild(back);
        for (const child of group.children || []) {
            const row = makeMenuRow(child, () => runMenuKey(child.key, child.label));
            list.appendChild(row);
        }
        applyPlayerMenuFlags(list);
    };

    renderMenuRoot();

    pop.appendChild(head);
    pop.appendChild(status);
    pop.appendChild(banner);
    pop.appendChild(list);
    const foot = document.createElement('div');
    foot.className = 'nt-quick-pop-foot';
    foot.innerHTML = '<span class="nt-quick-foot-line"></span><span>NEKOTOOL // WORLD SIM</span><span class="nt-quick-foot-dots"></span>';
    pop.appendChild(foot);
    document.body.appendChild(pop);
    updateQuickStatus();

    document.addEventListener('click', (e) => {
        const popEl = $(POP_ID);
        const btn = $(BTN_ID);
        const floatBtn = $(FLOAT_ID);
        if (!popEl || popEl.hidden) return;
        if (popEl.contains(e.target) || (btn && btn.contains(e.target)) || (floatBtn && floatBtn.contains(e.target))) return;
        closePop();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closePop();
            closeModal();
        }
    });
    window.addEventListener('resize', () => {
        const popEl = $(POP_ID);
        if (popEl && !popEl.hidden) placePop();
    });
    window.addEventListener('nekotool:clock-jump', () => updateJumpUi());
    window.addEventListener('nekotool:clock-changed', () => updateClockUi());
    updateClockUi();
}

// ========== 挂载 ==========

function quickMenuEnabled() {
    return settings.get('worldsim').enableQuickMenu !== false;
}

function refreshQuickMenuVisibility() {
    const enabled = quickMenuEnabled();
    const btn = $(BTN_ID);
    if (btn) btn.style.display = enabled ? '' : 'none';
    if (!enabled) {
        closePop();
        const floatBtn = $(FLOAT_ID);
        if (floatBtn) floatBtn.remove();
        return;
    }
    if (!btn) {
        if (ensureButton()) buildPop();
        return;
    }
    if (!$(POP_ID)) buildPop();
    updateJumpUi();
    ensureFloatButton();
}

function ensureButton() {
    if (!quickMenuEnabled()) return false;
    if ($(BTN_ID)) return true;
    const host = document.getElementById('leftSendForm');
    if (!host) return false;

    const btn = document.createElement('div');
    btn.id = BTN_ID;
    btn.className = 'nt-quick-btn';
    btn.title = 'NEKOTOOL 快捷菜单';
    btn.textContent = 'TOOL';
    let lastActivate = 0;
    const activate = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        const now = Date.now();
        if (now - lastActivate < 350) return;
        lastActivate = now;
        togglePop();
    };
    btn.addEventListener('click', (e) => {
        if (Date.now() - lastActivate < 350) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        activate(e);
    });
    btn.addEventListener('touchend', activate, { passive: false });
    btn.addEventListener('touchstart', activate, { passive: false });
    btn.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch') activate(e);
    });
    host.appendChild(btn);
    updateJumpUi();
    return true;
}

/** 挂载输入栏按钮；等酒馆 DOM 就绪，失败重试 */
export function mountQuickMenu() {
    let tries = 0;
    const tick = () => {
        if (ensureButton()) {
            buildPop();
            ensureFloatButton();
            return;
        }
        if (tries++ < 30) setTimeout(tick, 500);
    };
    tick();

    // 酒馆偶尔会重建输入栏；定期补挂，一次 getElementById 很便宜
    if (!mounted) {
        mounted = true;
        window.addEventListener('nekotool:main-complete', (e) => {
            const book = e && e.detail ? e.detail.bookName : '';
            showMainCompleteModal(book).catch(err => console.warn('[nekotools] 主线完成弹窗失败', err));
        });
        window.addEventListener('nekotool:quickmenu-toggle', () => refreshQuickMenuVisibility());
        window.addEventListener('nekotool:auto-refresh', (e) => {
            const sig = e && e.detail ? String(e.detail.sig || '') : '';
            triggerAutoRefresh(sig);
        });
        // 有的用户主 API 是直连外部地址，hooks 不会拦到响应，worldsim 也不会派发 auto-refresh；
        // 再监听酒馆自己的消息事件作为兜底，direct API 也能触发自动全量。
        const bindStMessageAutoRefresh = () => {
            const es = getEventSource();
            const et = getEventTypes();
            if (!es || !et || !et.MESSAGE_RECEIVED) return false;
            if (es.__ntAutoRefreshBound) return true;
            es.__ntAutoRefreshBound = true;
            es.on(et.MESSAGE_RECEIVED, () => triggerAutoRefresh(''));
            return true;
        };
        if (!bindStMessageAutoRefresh()) setTimeout(bindStMessageAutoRefresh, 1500);
        setInterval(() => {
            if (!ensureButton()) return;
            if (!$(POP_ID)) buildPop();
            ensureFloatButton();
            updateJumpUi();
        }, 3000);
    }
}
