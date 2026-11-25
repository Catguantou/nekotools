import { stBridge } from '../core/st_bridge.js';

function fields(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/^([^：:]{1,12})[：:]\s*(.*)$/);
        if (m) out[m[1].trim()] = m[2].trim();
    }
    return out;
}

function section(text, name) {
    const lines = String(text || '').split('\n');
    const start = lines.findIndex(l => l.trim() === `【${name}】` || l.trim() === `${name}：`);
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
        if (/^【[^】]+】$/.test(lines[i].trim())) break;
        if (lines[i].trim()) out.push(lines[i].trim());
    }
    return out.join('\n');
}

function row(label, value) {
    if (!value) return null;
    const div = document.createElement('div');
    div.className = 'nt-quest-read-row';
    const a = document.createElement('span');
    a.className = 'nt-quest-label';
    a.textContent = label;
    const b = document.createElement('span');
    b.className = 'nt-quest-read-value';
    b.textContent = value;
    div.appendChild(a);
    div.appendChild(b);
    return div;
}

export async function buildFactionPanel(book) {
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const get = (title) => {
        const entry = Object.values(data?.entries || {}).find(e => e && e.comment === title);
        return String(entry?.content || '').trim();
    };
    const org = get('玩家势力');
    const base = get('据点');
    const body = document.createElement('div');
    body.className = 'nt-faction-panel';

    if (!org && !base) {
        const note = document.createElement('div');
        note.className = 'nt-quick-note';
        note.textContent = '尚未建立或加入玩家势力。';
        body.appendChild(note);
        return body;
    }

    if (org) {
        const f = fields(org);
        const card = document.createElement('div');
        card.className = 'nt-quest-main';
        const title = document.createElement('div');
        title.className = 'nt-quest-title';
        title.textContent = f['名称'] || '玩家势力';
        card.appendChild(title);
        for (const key of ['目的', '人数', '凝聚力', '领袖', '对外形象', '名望', '影响力', '活动范围']) {
            const line = row(key, f[key]);
            if (line) card.appendChild(line);
        }
        body.appendChild(card);

        const people = section(org, '人员名单');
        const head = document.createElement('div');
        head.className = 'nt-quest-section';
        head.textContent = '人员名单';
        body.appendChild(head);
        if (people) {
            for (const line of people.split('\n').slice(0, 30)) {
                const item = document.createElement('div');
                item.className = 'nt-quest-read-detail';
                item.textContent = line.replace(/^[-·]\s*/, '');
                body.appendChild(item);
            }
        } else {
            const note = document.createElement('div');
            note.className = 'nt-quick-note';
            note.textContent = '暂无人员名单。';
            body.appendChild(note);
        }
    }

    if (base) {
        const f = fields(base);
        const head = document.createElement('div');
        head.className = 'nt-quest-section';
        head.textContent = '据点';
        body.appendChild(head);
        const card = document.createElement('div');
        card.className = 'nt-quest-read-item';
        const name = document.createElement('div');
        name.className = 'nt-quest-read-name';
        name.textContent = f['名称'] || '当前据点';
        card.appendChild(name);
        for (const key of ['位置', '归属', '人口', '设施', '防御', '物资', '隐蔽度']) {
            const line = row(key, f[key]);
            if (line) card.appendChild(line);
        }
        body.appendChild(card);
    }
    return body;
}
