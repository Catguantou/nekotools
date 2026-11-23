import { stBridge } from '../core/st_bridge.js';

const TITLE = '文娱作品';

function parse(text) {
    try {
        const data = JSON.parse(String(text || ''));
        if (data && Array.isArray(data.works)) return data;
    } catch (_) {}
    return null;
}

function line(label, value) {
    const row = document.createElement('div');
    row.className = 'nt-quest-read-row';
    const a = document.createElement('span');
    a.className = 'nt-quest-label';
    a.textContent = label;
    const b = document.createElement('span');
    b.className = 'nt-quest-read-value';
    b.textContent = value;
    row.appendChild(a);
    row.appendChild(b);
    return row;
}

export async function buildCulturePanel(book) {
    const body = document.createElement('div');
    body.className = 'nt-culture-panel';
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const entry = Object.values(data?.entries || {}).find(e => e && e.comment === TITLE);
    const text = String(entry?.content || '').trim();
    const state = parse(text);

    if (!state) {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = text || '文娱创作未激活。还没有作品；想写小说、画画、演戏、作曲，直接在剧情里开始。';
        body.appendChild(note);
        return body;
    }

    const head = document.createElement('div');
    head.className = 'nt-quest-section';
    head.textContent = `作品（${state.works.length}）`;
    body.appendChild(head);

    for (const work of state.works) {
        const item = document.createElement('div');
        item.className = 'nt-quest-read-item';
        const name = document.createElement('div');
        name.className = 'nt-quest-read-name';
        name.textContent = `${work.title || '未命名'} · ${work.type || '作品'}`;
        item.appendChild(name);
        item.appendChild(line('状态', work.status || '创作中'));
        item.appendChild(line('质量', work.quality || '一般'));
        item.appendChild(line('热度', work.heat || '冷清'));
        item.appendChild(line('传播', work.spread || '本地'));
        item.appendChild(line('口碑', work.reputation || '一般'));
        if (Array.isArray(work.comments) && work.comments.length) {
            const c = document.createElement('div');
            c.className = 'nt-quest-read-detail';
            c.textContent = '评论：' + work.comments.slice(0, 3).join(' / ');
            item.appendChild(c);
        }
        if (Array.isArray(work.awards) && work.awards.length) {
            const a = document.createElement('div');
            a.className = 'nt-quest-read-detail';
            a.textContent = '奖项：' + work.awards.join(' / ');
            item.appendChild(a);
        }
        body.appendChild(item);
    }

    const rank = document.createElement('div');
    rank.className = 'nt-quest-section';
    rank.textContent = '榜单';
    body.appendChild(rank);
    const sorted = [...state.works].sort((a, b) => (Number(b.heatScore) || 0) - (Number(a.heatScore) || 0));
    sorted.slice(0, 5).forEach((w, i) => {
        const item = document.createElement('div');
        item.className = 'nt-quest-read-detail';
        item.textContent = `${i + 1}. ${w.title || '未命名'}｜${w.heat || '冷清'}`;
        body.appendChild(item);
    });
    return body;
}
