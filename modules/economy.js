import { stBridge } from '../core/st_bridge.js';

const TITLE = '经营资产';

function defaultState() {
    return {
        cash: 100,
        assets: [
            { id: 'bh01', name: '白灰面包店', type: '股票', qty: 0, cost: 0, price: 10, prevClose: 10, trend: 0.8, history: [10] },
            { id: 'gc01', name: '灰潮能源', type: '股票', qty: 0, cost: 0, price: 18, prevClose: 18, trend: -0.3, history: [18] },
            { id: 'food', name: '北境粮券', type: '商品', qty: 0, cost: 0, price: 6, prevClose: 6, trend: 0.2, history: [6] },
        ],
        lastDay: '',
        log: [],
    };
}

function parseState(text) {
    try {
        const data = JSON.parse(String(text || ''));
        if (!data || !Array.isArray(data.assets)) return null;
        return { ...defaultState(), ...data };
    } catch (_) {
        return null;
    }
}

async function load(book) {
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const entry = Object.values(data?.entries || {}).find(e => e && e.comment === TITLE);
    const state = entry ? parseState(entry.content) : null;
    return state || defaultState();
}

async function save(book, state) {
    await stBridge.updateEntry(book, TITLE, JSON.stringify(state, null, 2), true, [], {
        position: 0, depth: 0, order: 872,
    });
}

function clampPrice(n) {
    return Math.max(0.1, Math.min(9999, Math.round(n * 100) / 100));
}

function settle(state, dateText) {
    const today = String(dateText || '').match(/\d{4}年\d{1,2}月\d{1,2}日/)?.[0] || '';
    if (!today || today === state.lastDay) return state;
    const day = Number(today.replace(/[^\d]/g, '')) || 1;
    for (const a of state.assets) {
        const wave = Math.sin((day + a.id.length) * 1.7) * 0.02;
        const change = (Number(a.trend) || 0) * 0.01 + wave;
        a.prevClose = a.price;
        a.price = clampPrice(a.price * (1 + change));
        a.history = [...(a.history || []), a.price].slice(-40);
    }
    state.lastDay = today;
    state.log = [...(state.log || []), `- ${today} 行情更新`].slice(-30);
    return state;
}

function total(state) {
    return Number(state.cash || 0) + state.assets.reduce((s, a) => s + Number(a.price) * Number(a.qty), 0);
}

function row(text, value) {
    const div = document.createElement('div');
    div.className = 'nt-quest-read-row';
    const a = document.createElement('span');
    a.className = 'nt-quest-label';
    a.textContent = text;
    const b = document.createElement('span');
    b.className = 'nt-quest-read-value';
    b.textContent = value;
    div.appendChild(a);
    div.appendChild(b);
    return div;
}

export async function buildEconomyPanel(book, dateText = '') {
    const body = document.createElement('div');
    body.className = 'nt-economy-panel';
    const state = settle(await load(book), dateText);
    await save(book, state);

    const summary = document.createElement('div');
    summary.className = 'nt-quest-main';
    const title = document.createElement('div');
    title.className = 'nt-quest-title';
    title.textContent = '经营资产';
    summary.appendChild(title);
    summary.appendChild(row('现金', String(state.cash)));
    summary.appendChild(row('总资产', String(Math.round(total(state) * 100) / 100)));
    summary.appendChild(row('最后行情', state.lastDay || '未结算'));
    body.appendChild(summary);

    const head = document.createElement('div');
    head.className = 'nt-quest-section';
    head.textContent = '市场';
    body.appendChild(head);

    for (const asset of state.assets) {
        const item = document.createElement('div');
        item.className = 'nt-quest-read-item';
        const name = document.createElement('div');
        name.className = 'nt-quest-read-name';
        const change = asset.prevClose ? ((asset.price - asset.prevClose) / asset.prevClose) * 100 : 0;
        name.textContent = `${asset.name}  ${asset.price}  ${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
        const detail = document.createElement('div');
        detail.className = 'nt-quest-read-detail';
        detail.textContent = `持有 ${asset.qty}｜成本 ${asset.cost}｜${asset.type}`;
        item.appendChild(name);
        item.appendChild(detail);
        const actions = document.createElement('div');
        actions.className = 'nt-quick-char-actions';
        const buy = document.createElement('button');
        buy.type = 'button';
        buy.className = 'nt-quick-btn-text';
        buy.textContent = '买入';
        buy.addEventListener('click', async () => {
            const n = Math.max(1, parseInt(window.prompt('买入数量') || '0', 10) || 0);
            const cost = n * asset.price;
            if (!n || cost > state.cash) { window.alert('现金不足'); return; }
            state.cash -= cost;
            asset.qty += n;
            asset.cost = Math.round(((asset.cost * (asset.qty - n) + cost) / asset.qty) * 100) / 100;
            await save(book, state);
            body.replaceWith(await buildEconomyPanel(book));
        });
        const sell = document.createElement('button');
        sell.type = 'button';
        sell.className = 'nt-quick-btn-text';
        sell.textContent = '卖出';
        sell.addEventListener('click', async () => {
            const n = Math.max(1, parseInt(window.prompt('卖出数量') || '0', 10) || 0);
            if (!n || n > asset.qty) { window.alert('持仓不足'); return; }
            state.cash += n * asset.price;
            asset.qty -= n;
            await save(book, state);
            body.replaceWith(await buildEconomyPanel(book));
        });
        actions.appendChild(buy);
        actions.appendChild(sell);
        item.appendChild(actions);
        body.appendChild(item);
    }
    return body;
}
