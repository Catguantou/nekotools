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

const CHAR_FIELD_ORDER = ['姓名', '性别', '外貌', '身份', '状态', '后台运行', '长期目标', '近期打算', '关键记忆', '特殊变化', '人际关系'];

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
    body.className = 'nt-quick-chars';
    const left = document.createElement('div');
    left.className = 'nt-quick-chars-left';
    const right = document.createElement('div');
    right.className = 'nt-quick-chars-right';
    body.appendChild(left);
    body.appendChild(right);

    let list = [];
    let cfg = { pinned: [], blocked: [] };
    let selected = '';
    let editing = false;
    let renderSeq = 0;

    openModal({ title: '角色管理', body, wide: true, footer: [{ label: '关闭', primary: true }] });

    const refresh = async () => {
        cfg = await loadConfig(book, { force: true });
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

        // 新钉住但索引里没有：补一行
        if (pinned.includes(name) && !list.some(x => x.name === name)) {
            await addRosterName(book, name, `T1｜第 ${currentLayerNo()} 层`);
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
            meta.textContent = [item.tier, item.location, charAge(item)].filter(Boolean).join(' · ');
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
            item.location ? `位置：${item.location}` : '',
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

function buildPop() {
    if ($(POP_ID)) return;

    const pop = document.createElement('div');
    pop.id = POP_ID;
    pop.className = 'nt-quick-pop';
    pop.hidden = true;

    const head = document.createElement('div');
    head.className = 'nt-quick-pop-head';
    head.innerHTML = '<span class="nt-quick-dot"></span><span class="nt-quick-pop-title">NEKOTOOL</span><span class="nt-quick-pop-tag">QUICK</span>';

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
        { key: 'clock', label: '世界时钟', hint: '读状态栏', enabled: true },
        { key: 'roster', label: '角色管理', hint: '详情 / 钉住 / 拉黑', enabled: true },
        { key: 'action', label: '快捷行动', hint: '找谁 / 做什么 / 去哪 / 跳时间', enabled: true },
        { key: 'slots', label: '存档', hint: '新建 / 切换 / 存读档', enabled: true },
        { key: 'refresh', label: '请求更新', hint: '角色 / 世界 / 地图', enabled: false },
        { key: 'map', label: '地图', hint: '周边可交互节点', enabled: false },
        { key: 'edit', label: '手动修改', hint: '主线 / 白名单 / 黑名单', enabled: false },
    ];

    for (const item of items) {
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
            else if (item.key === 'slots') showSlotsModal();
            else showSoon(item.label);
        });
        list.appendChild(row);
    }

    pop.appendChild(head);
    pop.appendChild(banner);
    pop.appendChild(list);
    document.body.appendChild(pop);

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

function ensureButton() {
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
        setInterval(() => {
            if (!ensureButton()) return;
            if (!$(POP_ID)) buildPop();
            updateJumpUi();
        }, 3000);
    }
}
