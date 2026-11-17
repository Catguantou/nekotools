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
    readRoster,
    readCharacterEntry,
    saveCharacterEntry,
    removeRosterName,
    removeCharacterEntry,
    addRosterName,
} from './slots.js';
import { slotLabel, parseStatusFields, parseCharacterYaml } from './worldfmt.js';
import { loadConfig, saveConfig } from './worldcfg.js';
import { readMap, findPath } from './worldmap.js';
import { refreshChar } from './worldindex.js';
import { readMain, readQuests, clampProgress, saveMain, saveQuests } from './worldquest.js';
import { generateQuiet } from './st_api.js';
import { applyRefreshData } from '../modules/worldsim.js';
import { settings } from './settings.js';
import { stBridge } from './st_bridge.js';

const BTN_ID = 'nt-quick-btn';
const POP_ID = 'nt-quick-pop';
const MODAL_ID = 'nt-quick-modal';

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
    }
}

/**
 * 打开一个轻量弹窗。
 * body 传 Node 或字符串；footer 传 [{ label, primary, onClick }]。
 * onClick 返回 false 时保持弹窗打开（适合异步操作后原地刷新）。
 */
export function openModal({ title = '', body = null, footer = null, wide = false, onClose = null } = {}) {
    closeModal();

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

function closePop() {
    const pop = $(POP_ID);
    if (pop) pop.hidden = true;
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
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth || 230;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    pop.style.left = left + 'px';
    pop.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + 'px';
}

function openPop() {
    const pop = $(POP_ID);
    if (!pop) return;
    updateJumpUi();
    updateClockUi();
    updateQuickStatus();
    pop.hidden = false;
    placePop();
}

function togglePop() {
    const pop = $(POP_ID);
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
    return Object.entries(parsed).map(([key, value]) => {
        let text;
        if (Array.isArray(value)) text = value.join('\n');
        else if (value && typeof value === 'object') {
            text = Object.entries(value).map(([k, v]) => `${k}: ${v}`).join('\n');
        } else text = String(value ?? '');
        return { key, value: text };
    });
}

async function showRosterModal() {
    const book = stBridge.currentTrackerName();
    if (!book) {
        toast('请先选择一个角色卡', 'warning');
        return;
    }

    const body = document.createElement('div');
    body.className = 'nt-quick-chars-wrap';

    const headerEl = document.createElement('div');
    headerEl.className = 'nt-quick-roster-head';
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
    let renderSeq = 0;
    let clockNow = readClock();
    let mapData = await readMap(book);

    const updateHeader = () => {
        const place = clockNow && clockNow.place ? clockNow.place : '未知地点';
        const time = clockNow && clockNow.time ? clockNow.time : '未知时间';
        headerEl.textContent = `第 ${currentLayerNo()} 层 · ${place} · ${time}`;
    };
    updateHeader();

    openModal({ title: '角色管理', body, wide: true, footer: [{ label: '关闭', primary: true }] });

    const refresh = async () => {
        cfg = await loadConfig(book, { force: true });
        clockNow = readClock();
        mapData = await readMap(book);
        updateHeader();
        list = await readRoster(book);
        if (!selected || !list.some(x => x.name === selected)) selected = list[0] ? list[0].name : '';
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
        const head = document.createElement('div');
        head.className = 'nt-quick-chars-head';
        head.textContent = `角色 ${list.length}`;
        left.appendChild(head);

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

        for (const item of list) {
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
        actions.appendChild(pin);
        actions.appendChild(block);
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
        if (!fields.length) {
            const note = document.createElement('div');
            note.className = 'nt-quick-note';
            note.textContent = '这个角色还没有档案。等模型在 ws_update 里写 chars，或者点下面的「编辑档案」自己填。';
            right.appendChild(note);
        } else {
            const ordered = [...fields].sort((a, b) => {
                const ia = CHAR_FIELD_ORDER.indexOf(a.key);
                const ib = CHAR_FIELD_ORDER.indexOf(b.key);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
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

    await refresh();
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
        actions.appendChild(makeBtn('📍 我在哪', () => {
            setStateFromPath(cur);
            mode = 'map';
            render();
        }, mode === 'map' && state.site && state.site === cur.site));
        actions.appendChild(makeBtn('🔍 找角色', () => {
            mode = 'people';
            render();
        }, mode === 'people'));

        const place = (clockNow && clockNow.place) || cur.site || cur.city || '未知地点';
        const time = (clockNow && clockNow.time) || '';
        info.textContent = `🧭 第 ${currentLayerNo()} 层 · ${place}${time ? ' · ' + time : ''}`;
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
            addFact('方位', normalizeDirection(site.direction) || mapInferDirection(site));
            detail.appendChild(facts);

            detail.appendChild(section('出口 / 周边'));
            const exits = document.createElement('div');
            exits.className = 'nt-map-exits';
            for (const exit of site.exits || []) {
                const target = data.sites[exit];
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'nt-map-exit';
                b.textContent = `➜ ${exit}`;
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
        content.appendChild(canvas);

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

    const body = document.createElement('div');
    body.className = 'nt-quests';

    const card = document.createElement('div');
    card.className = 'nt-quest-main';
    const title = document.createElement('div');
    title.className = 'nt-quest-title';
    title.textContent = '主线';
    card.appendChild(title);

    const fields = {};
    const addField = (key, placeholder = '') => {
        const row = document.createElement('label');
        row.className = 'nt-quest-edit-row';
        const l = document.createElement('span');
        l.className = 'nt-quest-label';
        l.textContent = key;
        const input = document.createElement('input');
        input.className = 'nt-quest-input';
        input.placeholder = placeholder;
        input.value = key === '进度' ? String(clampProgress(main[key])) : (main[key] || '');
        fields[key] = input;
        row.appendChild(l);
        row.appendChild(input);
        card.appendChild(row);
    };
    addField('标题');
    addField('目标');
    addField('阶段');
    addField('进度', '0–100');
    fields['进度'].type = 'number';
    fields['进度'].min = '0';
    fields['进度'].max = '100';
    addField('失败代价');
    addField('下一步');

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

    const rows = document.createElement('div');
    rows.className = 'nt-quest-edit-list';
    body.appendChild(rows);

    const addQuestRow = (name = '', value = '') => {
        const row = document.createElement('div');
        row.className = 'nt-quest-edit-row nt-quest-edit-side';
        const nameEl = document.createElement('input');
        nameEl.className = 'nt-quest-input nt-quest-name';
        nameEl.placeholder = '支线名';
        nameEl.value = name;
        if (name) nameEl.readOnly = true;
        const valueEl = document.createElement('input');
        valueEl.className = 'nt-quest-input';
        valueEl.placeholder = '类型｜目标｜状态｜期限(YYYY年MM月DD日/无)｜失败条件｜钩子';
        valueEl.value = value;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'nt-quest-del';
        del.textContent = '删除';
        del.addEventListener('click', () => row.remove());
        row.appendChild(nameEl);
        row.appendChild(valueEl);
        row.appendChild(del);
        rows.appendChild(row);
    };
    for (const [name, value] of Object.entries(quests)) addQuestRow(name, value);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'nt-quest-add';
    addBtn.textContent = '＋ 新增支线';
    addBtn.addEventListener('click', () => addQuestRow());
    body.appendChild(addBtn);

    const save = async () => {
        const nextMain = {};
        for (const [key, input] of Object.entries(fields)) nextMain[key] = input.value.trim();
        await saveMain(book, nextMain);
        try {
            const all = settings.get('worldsim') || {};
            const slotMeta = { ...(all.slotMeta || {}) };
            slotMeta[book] = { ...(slotMeta[book] || {}), mainProgress: clampProgress(nextMain['进度']) };
            settings.set('worldsim', { slotMeta });
        } catch (_) {}

        const nextQuests = {};
        rows.querySelectorAll('.nt-quest-edit-side').forEach(row => {
            const nameEl = row.querySelector('.nt-quest-name');
            const valueEl = row.querySelectorAll('.nt-quest-input')[1];
            const name = String(nameEl?.value || '').trim();
            const value = String(valueEl?.value || '').trim();
            if (name && value) nextQuests[name] = value;
        });
        await saveQuests(book, nextQuests);
        toast('可办事项已保存', 'success');
        return true;
    };

    openModal({
        title: '可办事项',
        body,
        wide: true,
        footer: [
            { label: '保存', primary: true, onClick: save },
            { label: '关闭' },
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
        await saveMain(bookName, { ...main, ...patch });
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
                await saveMain(bookName, { 标题: '新主线（待编辑）', 目标: '待定', 阶段: '新主线', 进度: 0, 失败代价: '', 下一步: '在可办事项里编辑' });
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

async function showRefreshModal() {
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
    if (settings.recordUserCharacter === true && userCharName && !charList.some(c => c.name === userCharName)) {
        charList.push({ name: userCharName, tier: '用户', location: '当前' });
    }

    const cats = [
        ['chars', '角色状态'],
        ['world', '世界局势'],
        ['map', '地图'],
        ['quests', '主线 / 支线'],
        ['items', '道具'],
        ['foreshadow', '伏笔'],
        ['plot', '计划'],
    ];
    const checks = {};
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
        body.appendChild(lab);
    }

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
    body.appendChild(charWrap);

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

    const save = async () => {
        const selected = Object.entries(checks).filter(([, cb]) => cb.checked).map(([k]) => k);
        if (!selected.length) {
            toast('至少勾选一个类别', 'warning');
            return false;
        }
        const selectedChars = Object.keys(charChecks).filter(name => charChecks[name].checked);
        if (selected.includes('chars')) {
            if (!charList.length) {
                toast('角色索引为空，不能单独更新角色', 'warning');
                return false;
            }
            if (!selectedChars.length) {
                toast('至少勾选一个要更新的角色', 'warning');
                return false;
            }
        }
        if (!(await backupBeforeWrite())) return false;
        const bookData = await stBridge.loadWorldInfoAsync(book);
        const get = (title) => {
            const entry = bookData && bookData.entries
                ? Object.values(bookData.entries).find(e => e && e.comment === title)
                : null;
            return entry ? String(entry.content || '').slice(0, 6000) : '';
        };
        const blocks = [];
        if (selected.includes('chars')) blocks.push(`【索引】\n${get('索引') || '（空）'}`);
        if (selected.includes('world')) blocks.push(`【世界局势】\n${get('世界局势') || '（空）'}`);
        if (selected.includes('map')) blocks.push(`【地图】\n${get('地图') || '（空）'}`);
        if (selected.includes('quests')) {
            blocks.push(`【主线】\n${get('主线') || '（空）'}`);
            blocks.push(`【支线】\n${get('支线') || '（空）'}`);
        }
        if (selected.includes('items')) blocks.push(`【道具】\n${get('道具') || '（空）'}`);
        if (selected.includes('foreshadow')) blocks.push(`【伏笔】\n${get('伏笔') || '（空）'}`);
        if (selected.includes('plot')) blocks.push(`【计划】\n${get('计划') || '（空）'}`);

        const schema = [];
        const userName = stBridge.getUserName() || '用户';
        const recordUserChar = settings.recordUserCharacter === true;
        if (selected.includes('chars')) schema.push(`"chars": {"角色名": {"性别":"...","外貌":"...","人际关系":{"${userName}":"好感 X｜信任 Y｜标签：..."},"状态":"...","后台运行":"A→B→C","长期目标":"...","近期打算":"...","关键记忆":["..."],"特殊变化":"..."}}`);
        if (selected.includes('world')) schema.push('"world": {"国家":{"名称":"方位｜类型｜政体｜领袖｜经济｜军事｜外交关系｜文化｜当前动向"},"势力":{"名称":"类型｜目标｜资源｜与主角关系｜当前动作"},"社会新闻":{"标题":"事件｜影响｜来源"}}');
        if (selected.includes('map')) schema.push('"map": {"regions":{"名称":"方位｜类型｜一句话"},"cities":{"区域名":{"城市名":"方位｜类型｜一句话"}},"sites":{"城市名":{"地点名":"方位｜类型｜出口：A、B｜可交互：...｜常驻：..."}}}');
        if (selected.includes('quests')) {
            schema.push('"main": {"标题":"...","目标":"...","阶段":"...","进度":0-100,"失败代价":"...","下一步":"..."}');
            schema.push('"quests": {"add": {"支线名":"类型｜目标｜状态｜期限(YYYY年MM月DD日/无)｜失败条件｜钩子"}, "del":["支线名"]}');
        }
        if (selected.includes('items')) schema.push('"items": {"add": {"道具名":"[类别] 描述"}, "del":["道具名"]}');
        if (selected.includes('foreshadow')) schema.push('"foreshadow": {"add": {"伏笔名":"[线索 | 指向] 描述"}, "del":["伏笔名"]}');
        if (selected.includes('plot')) schema.push('"plot": {"add": {"计划名":"[谁 | 做什么 | 状态] 描述"}, "del":["计划名"]}');

        const charLine = selected.includes('chars')
            ? `本轮只更新这些角色：${selectedChars.join('、')}；不要输出其他人。`
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
要求：人物位置用地图小地点名；没有变化就留空对象；不要编造与当前数据冲突的内容。`;

        try {
            toast('正在生成更新…', 'info');
            const raw = await generateQuiet(prompt);
            const text = String(raw || '');
            const a = text.indexOf('{');
            const b = text.lastIndexOf('}');
            if (a < 0 || b <= a) throw new Error('模型没有返回 JSON');
            const data = JSON.parse(text.slice(a, b + 1));
            if (data.chars && typeof data.chars === 'object' && !Array.isArray(data.chars)) {
                const filtered = {};
                for (const name of selectedChars) {
                    if (data.chars[name]) filtered[name] = data.chars[name];
                }
                data.chars = filtered;
            }
            const summary = await applyRefreshData(book, data, currentLayerNo());
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

    const titles = ['主线', '支线', '世界局势', '地图', '索引', '道具', '伏笔', '计划', '小总结', '剧情推演'];
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
        '世界局势': { order: 800, pos: 0, constant: true },
        '地图': { order: 830, pos: 0, constant: true },
        '索引': { order: 850, pos: 0, constant: true },
        '道具': { order: 900, pos: 0, constant: false },
        '伏笔': { order: 920, pos: 0, constant: false },
        '计划': { order: 910, pos: 0, constant: true },
        '小总结': { order: 999, pos: 4, constant: true },
        '剧情推演': { order: 999, pos: 0, constant: true },
    };

    const save = async () => {
        const title = select.value;
        const text = area.value;
        let problem = '';
        if (title === '主线' && !/标题[：:]/.test(text) && !/目标[：:]/.test(text)) {
            problem = '主线至少要有「标题：」或「目标：」';
        } else if (title === '支线' && !/【以下为支线】/.test(text) && !/^-\s*\S+/m.test(text)) {
            problem = '支线需要「【以下为支线】」或至少一行「- 名称｜…」';
        } else if (title === '世界局势' && !/【国家】|【势力】|【社会新闻】/.test(text)) {
            problem = '世界局势需要【国家】/【势力】/【社会新闻】段';
        } else if (title === '地图' && !/【大地图】/.test(text)) {
            problem = '地图需要【大地图】段';
        } else if (title === '索引' && !/【角色】/.test(text)) {
            problem = '索引需要【角色】段';
        }
        if (problem) {
            toast(`${problem}，已停止保存`, 'error');
            return false;
        }
        if (!(await backupBeforeWrite())) return false;
        const entry = find(title);
        const fallback = defaults[title] || { order: 999, pos: 0, constant: true };
        const extra = {
            position: entry ? entry.position : fallback.pos,
            depth: entry ? entry.depth : 0,
            order: entry ? entry.order : fallback.order,
        };
        stBridge.upsertEntryInBook(bookData, title, area.value, {
            isConstant: entry ? Boolean(entry.constant) : fallback.constant,
            keywords: entry && Array.isArray(entry.key) ? entry.key : [],
            extra,
        });
        await stBridge.persistLorebook(book, bookData);
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

    const items = [
        { group: '世界', icon: '🕰', key: 'clock', label: '世界时钟', hint: '时间 / 地点 / 天气', enabled: true },
        { group: '世界', icon: '🗺', key: 'map', label: '地图', hint: '区域 / 城市 / 小地点', enabled: true },
        { group: '角色', icon: '👥', key: 'roster', label: '角色管理', hint: '详情 / 钉住 / 拉黑', enabled: true },
        { group: '角色', icon: '📋', key: 'quests', label: '可办事项', hint: '主线 / 支线，可编辑', enabled: true },
        { group: '行动', icon: '🎯', key: 'action', label: '快捷行动', hint: '找谁 / 做什么 / 去哪', enabled: true },
        { group: '行动', icon: '🔄', key: 'refresh', label: '请求更新', hint: '按角色/类别静默更新', enabled: true },
        { group: '系统', icon: '💾', key: 'slots', label: '存档', hint: '新建 / 切换 / 存读档', enabled: true },
        { group: '系统', icon: '✏️', key: 'edit', label: '手动修改', hint: '直接编辑追踪书条目', enabled: true },
    ];

    let lastGroup = '';
    let groupNo = 0;
    for (const item of items) {
        if (item.group !== lastGroup) {
            lastGroup = item.group;
            groupNo++;
            const groupEl = document.createElement('div');
            groupEl.className = 'nt-quick-group';
            groupEl.textContent = `${String(groupNo).padStart(2, '0')} / ${item.group}`;
            list.appendChild(groupEl);
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'nt-quick-item' + (item.enabled ? '' : ' disabled');
        row.dataset.key = item.key;

        const label = document.createElement('span');
        label.className = 'nt-quick-item-label';
        label.textContent = item.label;

        const hint = document.createElement('span');
        hint.className = 'nt-quick-item-hint';
        hint.textContent = item.enabled ? item.hint : '后续版本';

        row.appendChild(label);
        row.appendChild(hint);

        row.addEventListener('click', () => {
            closePop();
            if (item.key === 'clock') showClockModal();
            else if (item.key === 'roster') showRosterModal();
            else if (item.key === 'action') showActionModal();
            else if (item.key === 'map') showMapModal();
            else if (item.key === 'quests') showQuestsModal();
            else if (item.key === 'refresh') showRefreshModal();
            else if (item.key === 'edit') showEditModal();
            else if (item.key === 'slots') showSlotsModal();
            else showSoon(item.label);
        });
        list.appendChild(row);
    }

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
        if (!popEl || popEl.hidden) return;
        if (popEl.contains(e.target) || (btn && btn.contains(e.target))) return;
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
        return;
    }
    if (!btn) {
        if (ensureButton()) buildPop();
        return;
    }
    if (!$(POP_ID)) buildPop();
    updateJumpUi();
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
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePop();
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
        setInterval(() => {
            if (!ensureButton()) return;
            if (!$(POP_ID)) buildPop();
            updateJumpUi();
        }, 3000);
    }
}
