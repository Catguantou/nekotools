// nekotools 统一弹窗：把 window.prompt / confirm / alert 全换成插件同款玻璃卡
// 用法：
//   const name = await ntAsk('新世界书名称', { value: '默认名' });   // 取消返回 null
//   const f = await ntForm('这场子叫什么？', [{ key: 'name', label: '名称' }, { key: 'edge', label: '抽水', value: '0.05' }]); // 取消返回 null
//   if (!await ntConfirm('确定删除？', { danger: true })) return;
//   await ntAlert('他拿不出这么多钱');

const STYLE_ID = 'nt-dlg-style';

const CSS = `
.nt-dlg-mask{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);font-family:"Helvetica Neue","Microsoft YaHei","PingFang SC",sans-serif}
.nt-dlg-card{width:100%;max-width:420px;max-height:82vh;overflow:auto;padding:16px 18px 14px;border:1px solid rgba(255,255,255,.14);border-left:2px solid #6f8cff;background:rgba(11,13,18,.97);box-shadow:0 18px 48px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.05);color:#e3e7ef}
.nt-dlg-title{font-size:12px;letter-spacing:1.4px;text-transform:uppercase;color:#e3e7ef;display:flex;align-items:center;gap:8px;margin-bottom:10px}
.nt-dlg-title::before{content:"";width:6px;height:6px;background:#6f8cff;box-shadow:0 0 8px #6f8cff}
.nt-dlg-text{font-size:12px;line-height:1.7;color:#c9cfdb;white-space:pre-wrap;word-break:break-word}
.nt-dlg-field{margin-top:9px}
.nt-dlg-label{font-size:10px;letter-spacing:.6px;color:#858c99;margin-bottom:4px}
.nt-dlg-input{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid rgba(110,140,225,.28);border-radius:6px;background:rgba(0,0,0,.28);color:#e3e7ef;font:inherit;font-size:12px}
.nt-dlg-input:focus{border-color:#6f8cff;box-shadow:0 0 0 1px rgba(111,140,255,.35)}
.nt-dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap}
.nt-dlg-btn{padding:6px 15px;border-radius:6px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#c9cfdb;font:inherit;font-size:11px;cursor:pointer}
.nt-dlg-btn:hover{filter:brightness(1.15)}
.nt-dlg-btn.primary{border-color:#6fd6a8;background:linear-gradient(180deg,#8ff0c6,#4bbd90);color:#0d1220;font-weight:600}
.nt-dlg-btn.danger{border-color:#e47a86;background:linear-gradient(180deg,#ffb3bb,#d9636f);color:#1a0d10;font-weight:600}
`;

function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function shell(title) {
    ensureStyle();
    document.querySelectorAll('.nt-dlg-mask').forEach(n => n.remove());
    const mask = el('div', 'nt-dlg-mask');
    const card = el('div', 'nt-dlg-card');
    const head = el('div', 'nt-dlg-title', title || '');
    const body = el('div', 'nt-dlg-body');
    const actions = el('div', 'nt-dlg-actions');
    card.append(head, body, actions);
    mask.appendChild(card);
    document.body.appendChild(mask);
    return { mask, card, body, actions };
}

function closer(mask, done) {
    const finish = (v) => {
        document.removeEventListener('keydown', onKey, true);
        mask.remove();
        done(v);
    };
    const onKey = (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); finish(null); }
    };
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('click', (ev) => { if (ev.target === mask) finish(null); });
    return finish;
}

function button(text, cls, onClick) {
    const b = el('button', 'nt-dlg-btn' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
}

/** 单行输入；取消返回 null */
export function ntAsk(title, { label = '', value = '', placeholder = '', ok = '确定', cancel = '取消' } = {}) {
    return new Promise((resolve) => {
        const { mask, body, actions } = shell(title);
        const finish = closer(mask, resolve);
        const field = el('div', 'nt-dlg-field');
        if (label) field.appendChild(el('div', 'nt-dlg-label', label));
        const input = el('input', 'nt-dlg-input');
        input.value = value || '';
        if (placeholder) input.placeholder = placeholder;
        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); finish(String(input.value ?? '')); }
        });
        field.appendChild(input);
        body.appendChild(field);
        actions.append(
            button(cancel, '', () => finish(null)),
            button(ok, 'primary', () => finish(String(input.value ?? ''))),
        );
        setTimeout(() => { input.focus(); input.select(); }, 20);
    });
}

/** 一次问多个字段；返回 {key: 值}；取消返回 null */
export function ntForm(title, fields = [], { ok = '确定', cancel = '取消', note = '' } = {}) {
    return new Promise((resolve) => {
        const { mask, body, actions } = shell(title);
        const finish = closer(mask, resolve);
        if (note) body.appendChild(el('div', 'nt-dlg-text', note));
        const inputs = {};
        let first = null;
        for (const f of fields) {
            const field = el('div', 'nt-dlg-field');
            field.appendChild(el('div', 'nt-dlg-label', f.label || f.key));
            const input = el('input', 'nt-dlg-input');
            input.value = f.value == null ? '' : String(f.value);
            if (f.placeholder) input.placeholder = f.placeholder;
            input.type = f.type === 'number' ? 'number' : 'text';
            input.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
            });
            field.appendChild(input);
            body.appendChild(field);
            inputs[f.key] = input;
            if (!first) first = input;
        }
        const submit = () => {
            const out = {};
            for (const [k, inp] of Object.entries(inputs)) out[k] = String(inp.value ?? '');
            finish(out);
        };
        actions.append(button(cancel, '', () => finish(null)), button(ok, 'primary', submit));
        setTimeout(() => first && first.focus(), 20);
    });
}

/** 是/否；返回 true / false */
export function ntConfirm(text, { title = '确认', ok = '确定', cancel = '取消', danger = false } = {}) {
    return new Promise((resolve) => {
        const { mask, body, actions } = shell(title);
        const finish = closer(mask, (v) => resolve(v === true));
        body.appendChild(el('div', 'nt-dlg-text', text));
        actions.append(
            button(cancel, '', () => finish(false)),
            button(ok, danger ? 'danger' : 'primary', () => finish(true)),
        );
    });
}

/** 只是告知；返回 undefined */
export function ntAlert(text, { title = '提示', ok = '知道了' } = {}) {
    return new Promise((resolve) => {
        const { mask, body, actions } = shell(title);
        const finish = closer(mask, () => resolve());
        body.appendChild(el('div', 'nt-dlg-text', text));
        actions.appendChild(button(ok, 'primary', () => finish()));
    });
}

/** 轻提示，不打断操作 */
export function ntToast(text, ms = 1800) {
    ensureStyle();
    const tip = el('div', 'nt-dlg-mask');
    tip.style.background = 'transparent';
    tip.style.backdropFilter = 'none';
    tip.style.alignItems = 'flex-end';
    tip.style.zIndex = '10049';
    const card = el('div', 'nt-dlg-card', text);
    card.style.maxWidth = '360px';
    card.style.textAlign = 'center';
    tip.appendChild(card);
    document.body.appendChild(tip);
    setTimeout(() => tip.remove(), ms);
}
