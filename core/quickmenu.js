// 聊天输入栏的快捷入口：按钮 + 菜单 + 弹窗基建 + 存档面板。
// 只做 DOM 与交互；世界书读写都在 core/slots.js。

import {
    listSlots,
    createSlot,
    switchSlot,
    deleteSlot,
    exportCurrent,
    importCurrent,
} from './slots.js';
import { slotLabel } from './worldfmt.js';
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
export function openModal({ title = '', body = null, footer = null, onClose = null } = {}) {
    closeModal();

    const mask = document.createElement('div');
    mask.id = MODAL_ID;
    mask.className = 'nt-quick-modal-mask';
    mask.addEventListener('click', (e) => {
        if (e.target === mask) closeModal();
    });

    const panel = document.createElement('div');
    panel.className = 'nt-quick-modal';

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
            if (item.key === 'slots') showSlotsModal();
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
