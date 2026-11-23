import { stBridge } from '../core/st_bridge.js';

const TITLE = '经营资产';

function candle(price, volume = 1000) {
    return { o: price, h: price, l: price, c: price, v: volume };
}

function defaultState() {
    return {
        cash: 1000,
        debt: 0,
        assets: [
            { id: 'bh01', name: '白灰面包店', type: '股票', qty: 0, cost: 0, price: 10, prevClose: 10, trend: 0.8, short: 0, candles: [candle(10)] },
            { id: 'gc01', name: '灰潮能源', type: '股票', qty: 0, cost: 0, price: 18, prevClose: 18, trend: -0.3, short: 0, candles: [candle(18)] },
            { id: 'food', name: '北境粮券', type: '商品', qty: 0, cost: 0, price: 6, prevClose: 6, trend: 0.2, short: 0, candles: [candle(6)] },
        ],
        businesses: [
            { name: '白灰阁杂货铺', status: '营业', profit: 20 },
        ],
        lastDay: '',
        lastMonth: '',
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
    const out = state || defaultState();
    for (const a of out.assets) {
        if (!Array.isArray(a.candles) || !a.candles.length) a.candles = [candle(Number(a.price) || 1)];
    }
    return out;
}

async function save(book, state) {
    await stBridge.updateEntry(book, TITLE, JSON.stringify(state, null, 2), true, [], {
        position: 0, depth: 0, order: 872,
    });
}

function clampPrice(n) {
    return Math.max(0.1, Math.min(9999, Math.round(n * 100) / 100));
}

function disasterActive(bookData) {
    const entry = Object.values(bookData?.entries || {}).find(e => e && e.comment === '世界灾变');
    return Boolean(entry && !/状态：已结束/.test(String(entry.content || '')));
}

async function settle(book, state, dateText) {
    const today = String(dateText || '').match(/\d{4}年\d{1,2}月\d{1,2}日/)?.[0] || '';
    if (!today || today === state.lastDay) return state;
    const day = Number(today.replace(/[^\d]/g, '')) || 1;
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const disaster = disasterActive(data);
    for (const a of state.assets) {
        const wave = Math.sin((day + a.id.length) * 1.7) * 0.02;
        let change = (Number(a.trend) || 0) * 0.01 + wave;
        if (disaster && /粮|药|food/i.test(a.name)) change += 0.03;
        const o = a.price;
        const c = clampPrice(o * (1 + change));
        const h = clampPrice(Math.max(o, c) * (1 + Math.abs(wave)));
        const l = clampPrice(Math.min(o, c) * (1 - Math.abs(wave)));
        a.prevClose = o;
        a.price = c;
        a.candles = [...(a.candles || []), { o, h, l, c, v: Math.round(800 + Math.abs(change) * 20000) }].slice(-40);
    }
    const month = today.replace(/\d{1,2}日$/, '');
    if (month !== state.lastMonth) {
        const profit = (state.businesses || []).reduce((s, b) => s + (Number(b.profit) || 0), 0);
        state.cash += profit;
        state.lastMonth = month;
        state.log = [...(state.log || []), `- ${month} 店铺结算：+${profit}`].slice(-30);
    }
    state.lastDay = today;
    state.log = [...(state.log || []), `- ${today} 行情更新${disaster ? '（天灾影响）' : ''}`].slice(-30);
    return state;
}

function total(state) {
    const holdings = state.assets.reduce((s, a) => s + Number(a.price) * Number(a.qty || 0), 0);
    return Number(state.cash || 0) + holdings - Number(state.debt || 0);
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

function drawKline(canvas, candles) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !candles?.length) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const vals = candles.flatMap(c => [c.h, c.l]);
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const span = max - min || 1;
    const step = w / candles.length;
    candles.forEach((c, i) => {
        const x = i * step + step / 2;
        const yh = h - ((c.h - min) / span) * h;
        const yl = h - ((c.l - min) / span) * h;
        const yo = h - ((c.o - min) / span) * h;
        const yc = h - ((c.c - min) / span) * h;
        ctx.strokeStyle = c.c >= c.o ? '#6fd6a8' : '#e47a86';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(x, yh);
        ctx.lineTo(x, yl);
        ctx.stroke();
        const top = Math.min(yo, yc);
        const height = Math.max(1, Math.abs(yo - yc));
        ctx.fillRect(x - Math.max(1, step * 0.25), top, Math.max(2, step * 0.5), height);
    });
}

export async function buildEconomyPanel(book, dateText = '') {
    const body = document.createElement('div');
    body.className = 'nt-economy-panel';
    const state = await settle(book, await load(book), dateText);
    await save(book, state);

    const summary = document.createElement('div');
    summary.className = 'nt-quest-main';
    const title = document.createElement('div');
    title.className = 'nt-quest-title';
    title.textContent = '经营资产';
    summary.appendChild(title);
    summary.appendChild(row('现金', String(state.cash)));
    summary.appendChild(row('融资负债', String(state.debt || 0)));
    summary.appendChild(row('总资产', String(Math.round(total(state) * 100) / 100)));
    summary.appendChild(row('最后行情', state.lastDay || '未结算'));
    body.appendChild(summary);

    const head = document.createElement('div');
    head.className = 'nt-quest-section';
    head.textContent = '市场 / 持仓';
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
        detail.textContent = `持有 ${asset.qty || 0}｜成本 ${asset.cost || 0}｜融券 ${asset.short || 0}｜${asset.type}`;
        item.appendChild(name);
        item.appendChild(detail);

        const canvas = document.createElement('canvas');
        canvas.width = 260;
        canvas.height = 56;
        canvas.className = 'nt-economy-kline';
        item.appendChild(canvas);
        requestAnimationFrame(() => drawKline(canvas, asset.candles));

        const bookLines = document.createElement('div');
        bookLines.className = 'nt-quest-read-detail';
        bookLines.textContent = `买一 ${(asset.price * 0.999).toFixed(2)}  卖一 ${(asset.price * 1.001).toFixed(2)}  成交量 ${asset.candles?.at(-1)?.v || 0}`;
        item.appendChild(bookLines);

        const actions = document.createElement('div');
        actions.className = 'nt-quick-char-actions';
        const mk = (label, fn, cls = '') => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'nt-quick-btn-text ' + cls;
            b.textContent = label;
            b.addEventListener('click', async () => {
                try { await fn(); } catch (e) { window.alert(String(e?.message || e)); }
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            return b;
        };
        actions.appendChild(mk('买入', async () => {
            const n = Math.max(1, parseInt(window.prompt('买入数量') || '0', 10) || 0);
            const cost = n * asset.price;
            if (!n || cost > state.cash) throw new Error('现金不足');
            state.cash -= cost;
            asset.qty += n;
            asset.cost = Math.round(((asset.cost * (asset.qty - n) + cost) / asset.qty) * 100) / 100;
            await save(book, state);
        }));
        actions.appendChild(mk('卖出', async () => {
            const n = Math.max(1, parseInt(window.prompt('卖出数量') || '0', 10) || 0);
            if (!n || n > (asset.qty || 0)) throw new Error('持仓不足');
            state.cash += n * asset.price;
            asset.qty -= n;
            await save(book, state);
        }));
        actions.appendChild(mk('融资买入', async () => {
            const n = Math.max(1, parseInt(window.prompt('融资买入数量') || '0', 10) || 0);
            const cost = n * asset.price;
            if (!n || cost > state.cash * 2) throw new Error('超过两倍杠杆上限');
            if (cost > state.cash) { state.debt += cost - state.cash; state.cash = 0; }
            else state.cash -= cost;
            asset.qty += n;
            await save(book, state);
        }));
        actions.appendChild(mk('融券卖出', async () => {
            const n = Math.max(1, parseInt(window.prompt('融券卖出数量') || '0', 10) || 0);
            if (!n) throw new Error('数量无效');
            state.cash += n * asset.price;
            asset.short = (asset.short || 0) + n;
            await save(book, state);
        }));
        actions.appendChild(mk('买券还券', async () => {
            const n = Math.max(1, parseInt(window.prompt('买券还券数量') || '0', 10) || 0);
            if (!n || n > (asset.short || 0)) throw new Error('融券不足');
            const cost = n * asset.price;
            if (cost > state.cash) throw new Error('现金不足');
            state.cash -= cost;
            asset.short -= n;
            await save(book, state);
        }));
        item.appendChild(actions);
        body.appendChild(item);
    }

    const head2 = document.createElement('div');
    head2.className = 'nt-quest-section';
    head2.textContent = '店铺 / 产业';
    body.appendChild(head2);
    for (const b of state.businesses || []) {
        const item = document.createElement('div');
        item.className = 'nt-quest-read-item';
        const n = document.createElement('div');
        n.className = 'nt-quest-read-name';
        n.textContent = b.name;
        const d = document.createElement('div');
        d.className = 'nt-quest-read-detail';
        d.textContent = `${b.status || '营业'}｜月利润 ${b.profit || 0}`;
        item.appendChild(n);
        item.appendChild(d);
        body.appendChild(item);
    }
    return body;
}
