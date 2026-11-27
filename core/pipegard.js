import { registry } from './registry.js';
import { stBridge } from './st_bridge.js';
import { settings as coreSettings } from './settings.js';

/**
 * 竖线护栏：正文里的分段被写成了「 | 」，就还原成空行分段。
 *
 * 起因：状态栏的字段提示用了 `时间: X | 地点: X | 天气: X` 这种写法，
 * 模型会照着在自己的正文里也用竖线连句子，结果整篇挤成一行。
 * 所以两头一起堵：提示词不再用竖线示范（modules/worldsim.js 的 buildStatusPrompt），
 * 已经写坏的消息在这里就地修好（连 swipe / display_text 一起改，否则重渲染又回旧文本）。
 */

const pgSettings = { enabled: true, autoRepair: true };

/** 只处理正文区间：优先 <content>…</content>，没有就取到第一个后台标签之前 */
function bodySpans(text) {
    const spans = [];
    const re = /<content>([\s\S]*?)<\/content>/gi;
    let m;
    while ((m = re.exec(text))) spans.push([m.index + 9, m.index + 9 + m[1].length]);
    if (spans.length) return spans;
    const cut = text.search(/\[\[NT_STATUS\]\]|<[A-Za-z_]+[:\s>]/);
    const end = cut === -1 ? text.length : cut;
    if (end > 0 && text.slice(0, end).trim()) spans.push([0, end]);
    return spans;
}

/**
 * 修漏出来的状态标签：模型把 <ws_status> 写进正文、又忘了闭合时，
 * 屏幕上就会明晃晃地显示一行标签。这里把它换成状态栏能认的机器标记，
 * 字段之间统一用竖线，交给 textmanager 升级成样式条。
 */
export function repairStatusTag(text) {
  let s = String(text ?? '');
  if (!s || s.indexOf('<ws_status>') === -1) return s;
  const re = /<ws_status>([\s\S]*?)(?:<\/ws_status>|$)/i;
  const m = s.match(re);
  if (!m) return s;
  const fields = m[1]
    .replace(/<\/?content>/gi, ' ')
    .split(/[|｜\n]/)
    .map(x => x.trim())
    .filter(Boolean);
  const marker = fields.length ? `\n\n[[NT_STATUS]]${fields.join(' | ')}\n` : '';
  s = s.replace(re, marker);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** content 只是模型自己的包裹标记，酒馆不显示也不认，留着就会在正文里露出「 | </content>」 */
export function stripBrokenContentTags(text) {
  const s = String(text ?? '');
  if (!/<\/?content>/i.test(s)) return s;
  return s
    .replace(/[ \t]*\|?[ \t]*<\/?content>[ \t]*\|?[ \t]*/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '');
}

/** 把正文里的「 | 」还原成空行；表格、日程这类本来就该有竖线的不动 */
export function fixPipes(text) {
    let s = String(text ?? '');
    if (!s) return s;
    s = repairStatusTag(stripBrokenContentTags(s));
    const spans = bodySpans(s);
    if (!spans.length) return s;

    let out = '';
    let last = 0;
    let touched = 0;

    for (const [a, b] of spans) {
        out += s.slice(last, a);
        let seg = s.slice(a, b);
        const pipes = seg.match(/[|｜]/g) || [];
        const newlines = (seg.match(/\n/g) || []).length;
        const tableRows = seg.match(/(?:^|\n)[ \t]*[|｜][^\n]*[|｜]/g) || [];
        // 至少三处竖线，且不是 markdown 表格：整段没有任何换行，或者表格行不到两行，就认定是「分段塌成一行」
        if (pipes.length >= 3 && (newlines === 0 || tableRows.length < 2)) {
            const before = seg;
            seg = seg
                .replace(/[ \t]*[|｜][ \t]*/g, '\n\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/^[\s\n]+/, '')
                .replace(/\s+$/, '');
            if (seg !== before) touched++;
        }
        out += seg;
        last = b;
    }
    out += s.slice(last);
    return touched ? out : s;
}

function refreshDom(index, msg) {
    try {
        const ctx = stBridge.getContext();
        if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, msg);
    } catch (e) {
        console.warn('[nekotools] 竖线护栏刷新消息失败', e);
    }
}

let repairing = false;

/** 扫一遍聊天记录，把塌成一行的正文修回分段 */
export function repairChatPipes({ all = false, max = 40 } = {}) {
    if (!pgSettings.autoRepair || repairing) return 0;
    const ctx = stBridge.getContext();
    const chat = ctx?.chat || [];
    if (!chat.length) return 0;
    repairing = true;
    const start = all ? 0 : Math.max(0, chat.length - max);
    let fixedCount = 0;
    try {
        for (let i = start; i < chat.length; i++) {
            const msg = chat[i];
            if (!msg || msg.is_system || !msg.mes) continue;
            const fixed = fixPipes(msg.mes);
            if (fixed === msg.mes) continue;

            const swipeId = msg.swipe_id;
            const oldSwipe = (Array.isArray(msg.swipes) && Number.isInteger(swipeId)
                && typeof msg.swipes[swipeId] === 'string') ? msg.swipes[swipeId] : null;
            const oldDisplay = (msg.extra && typeof msg.extra.display_text === 'string')
                ? msg.extra.display_text : null;

            if (oldSwipe !== null) msg.swipes[swipeId] = fixPipes(oldSwipe);
            if (oldDisplay !== null) msg.extra.display_text = fixPipes(oldDisplay);
            msg.mes = fixed;
            refreshDom(i, msg);
            fixedCount++;
        }
        if (fixedCount) {
            console.log(`[nekotools] 竖线护栏：修好 ${fixedCount} 条被压成一行的正文`);
            Promise.resolve(ctx.saveChat?.()).catch(() => {});
        }
    } finally {
        repairing = false;
    }
    return fixedCount;
}

registry.register({
    id: 'pipegard',
    name: '竖线护栏',
    enabled: true,
    order: 85,
    settings: pgSettings,

    loadSettings() { Object.assign(pgSettings, coreSettings.get('pipegard')); },
    saveSettings() { coreSettings.set('pipegard', pgSettings); },

    init() {
        this.loadSettings();
        const ctx = stBridge.getContext();
        const ev = ctx?.eventTypes || {};
        const names = [ev.MESSAGE_RECEIVED, ev.GENERATION_ENDED, ev.GENERATION_STOPPED, ev.CHAT_CHANGED]
            .filter(Boolean);
        for (const name of names) {
            ctx.eventSource?.on(name, () => setTimeout(() => {
                try { repairChatPipes({ max: 6 }); } catch (e) { console.warn('[nekotools] 竖线护栏', e); }
            }, 120));
        }
        // 初次加载：把已经写成这样的旧楼层补修一遍
        setTimeout(() => {
            try { repairChatPipes({ max: 40 }); } catch (e) { console.warn('[nekotools] 竖线护栏', e); }
        }, 1200);
    }
});
