import { stBridge } from '../core/st_bridge.js';

const TITLE = '经营资产';
let expandedKey = '';
const MODES = [
    { key: 'trader', label: '纯投资' },
    { key: 'maker', label: '做市商' },
    { key: 'exchange', label: '交易所' },
];

function candle(price, volume = 1000) {
    return { o: price, h: price, l: price, c: price, v: volume };
}

function defaultState() {
    return {
        cash: 0,
        debt: 0,
        assets: [],
        businesses: [],
        lastDay: '',
        lastMonth: '',
        log: [],
        mode: 'trader',
        feeRate: 0.003,
        limitRate: 0.1,
        impact: 0.02,
        houseEdge: 0.05,
        members: [],
        exposure: 0,
        platform: null,
        rules: '',
        parties: [],
        flows: [],
        orders: [],
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

/** 空字符串 / 我 / 玩家 都算玩家自己；其余名字是别人 */
function isPlayer(owner) {
    const o = String(owner || '').trim();
    return !o || o === '我' || o === '玩家' || o === '主角';
}

function normAsset(a) {
    const price = Number(a.price) || 1;
    if (!Array.isArray(a.candles) || !a.candles.length) a.candles = [candle(price)];
    a.owner = String(a.owner || '');
    a.qty = Number(a.qty) || 0;
    a.short = Number(a.short) || 0;
    a.cost = Number(a.cost) || 0;
    a.trend = Number(a.trend) || 0;
    a.supply = Number(a.supply) || 0;
    a.inflow = Number(a.inflow) || 0;
    if (!Array.isArray(a.dayFlows)) a.dayFlows = [];
    return a;
}

async function load(book) {
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const entry = Object.values(data?.entries || {}).find(e => e && e.comment === TITLE);
    const state = entry ? parseState(entry.content) : null;
    const out = state || defaultState();
    out.assets = (out.assets || []).map(normAsset);
    out.mode = MODES.some(m => m.key === out.mode) ? out.mode : 'trader';
    out.feeRate = Number(out.feeRate) > 0 ? Number(out.feeRate) : 0.003;
    out.limitRate = Number(out.limitRate) > 0 ? Math.min(0.5, Number(out.limitRate)) : 0.1;
    out.impact = Number(out.impact) > 0 ? Math.min(0.5, Number(out.impact)) : 0.02;
    out.houseEdge = Number(out.houseEdge) > 0 ? Math.min(0.5, Number(out.houseEdge)) : 0.05;
    out.exposure = Number(out.exposure) || 0;
    out.members = Array.isArray(out.members) ? out.members : [];
    out.members = out.members.map(m => ({
        name: String(m.name || ''),
        deposit: Number(m.deposit) || 0,
        balance: Number(m.balance) || 0,
        joined: m.joined || '',
        proof: String(m.proof || (m.mugshot ? '正面照' : '')),
        suspect: Number(m.suspect) || 0,
    }));
    const base = out.platform && typeof out.platform === 'object' ? out.platform : {};
    out.rules = String(out.rules || '');
    out.flows = Array.isArray(out.flows) ? out.flows.slice(-500) : [];
    out.orders = Array.isArray(out.orders) ? out.orders.map(o => ({
        who: String(o.who || ''),
        side: String(o.side || 'buy'),
        qty: Math.max(0, Math.round(Number(o.qty) || 0)),
        memo: String(o.memo || ''),
        day: String(o.day || ''),
    })).filter(o => o.who && o.qty > 0) : [];
    out.parties = Array.isArray(out.parties) ? out.parties.map(x => ({
        name: String(x.name || ''),
        cash: Number(x.cash) || 0,
        debt: Number(x.debt) || 0,
        note: String(x.note || ''),
        insolvent: x.insolvent === true,
    })).filter(x => x.name) : [];
    out.platform = {
        name: String(base.name || ''),
        kind: String(base.kind || 'casino'),
        gate: String(base.gate || base.gateText || ''),
        open: base.open !== false,
        edge: Number(base.edge) > 0 ? Number(base.edge) : (Number(out.houseEdge) || 0.05),
        exposure: Number(base.exposure) || Number(out.exposure) || 0,
    };
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

/** 同名的多条持仓共享一根行情：按名字算一次价，回写给所有持有人 */
function findOwnerAsset(state, who, name) {
    const key = String(name || '').trim();
    let a = state.assets.find(x => String(x.owner || '').trim() === who && String(x.name || '').trim() === key);
    if (a) return a;
    const price = (state.assets.find(x => String(x.name || '').trim() === key) || {}).price || 10;
    a = {
        id: `${who}-${key}`.slice(0, 24),
        owner: who,
        name: key,
        type: '股票',
        qty: 0,
        cost: 0,
        price,
        prevClose: price,
        trend: 0,
        short: 0,
        supply: 0,
        inflow: 0,
        dayFlows: [],
        candles: [],
    };
    state.assets.push(normAsset(a));
    return a;
}

/** 把 AI 写的订单一张张吃掉：谁、买还是卖、多少股；价格、滑点、手续费、现金与持仓的夹紧都在这儿算 */
function fillOrders(state, dayText) {
    const filled = [];
    if (!Array.isArray(state.orders) || !state.orders.length) return filled;
    for (const o of state.orders) {
        const who = String(o.who || '').trim();
        const side = o.side === 'sell' ? 'sell' : 'buy';
        const name = String(o.memo || '').trim();
        if (!who || !name) continue;
        const target = findOwnerAsset(state, who, name);
        const price = Number(target.price) || 10;
        const isMe = isPlayer(who);
        const holder = isMe ? state : null;
        let qty = Math.max(0, Math.round(Number(o.qty) || 0));
        // 夹紧：卖不能超过持仓，买不能超过现金
        if (side === 'sell') qty = Math.min(qty, Math.max(0, Number(target.qty) || 0));
        else {
            const cash = isMe ? Number(state.cash) || 0 : (Number(state.parties.find(p2 => p2.name === who)?.cash) || 0);
            const afford = price > 0 ? Math.floor(cash / price) : 0;
            qty = Math.min(qty, Math.max(0, afford));
        }
        if (!qty) continue;
        const move = impactOn(state, target, qty, side);
        const band = limitBand(state, target.prevClose || price);
        const fillPrice = Math.min(band.up, Math.max(band.down, clampPrice(price * (1 + move))));
        const amount = qty * fillPrice;
        const feeRate = state.mode === 'exchange' ? (Number(state.feeRate) || 0) : 0;
        const fee = amount * feeRate;
        if (side === 'buy') {
            target.qty += qty;
            target.cost = Math.round(((target.cost * (target.qty - qty) + amount) / target.qty) * 100) / 100;
            target.inflow = (Number(target.inflow) || 0) + amount;
            if (isMe) state.cash -= amount + fee;
            else {
                const p2 = state.parties.find(x => x.name === who);
                if (p2) p2.cash = (Number(p2.cash) || 0) - amount - fee;
            }
        } else {
            target.qty -= qty;
            target.inflow = (Number(target.inflow) || 0) - amount;
            if (isMe) state.cash += amount - fee;
            else {
                const p2 = state.parties.find(x => x.name === who);
                if (p2) p2.cash = (Number(p2.cash) || 0) + amount - fee;
            }
        }
        if (feeRate > 0) {
            if (state.mode === 'exchange') state.cash += fee;
            logFlow(state, dayText, isMe ? '我(交易所)' : '市场', '手续费', fee, `${name} ×${qty}`);
        }
        target.price = fillPrice;
        target.dayVolume = (Number(target.dayVolume) || 0) + qty;
        logFlow(state, dayText, who, side === 'buy' ? '买入' : '卖出', side === 'buy' ? -amount : amount, `${name} ×${qty} @${fillPrice}`);
        filled.push(`${who} ${side === 'buy' ? '买' : '卖'} ${name}×${qty} @${fillPrice}`);
    }
    if (filled.length) state.log = [...(state.log || []), ...filled.map(x => `- 成交：${x}`)].slice(-30);
    state.orders = [];
    return filled;
}

async function settle(book, state, dateText) {
    const today = String(dateText || '').match(/\d{4}年\d{1,2}月\d{1,2}日/)?.[0] || '';
    if (!today || today === state.lastDay) return state;
    const day = Number(today.replace(/[^\d]/g, '')) || 1;
    const data = await stBridge.loadWorldInfoAsync(book, true);
    const disaster = disasterActive(data);

    fillOrders(state, today);

    const groups = new Map();
    for (const a of state.assets) {
        const key = String(a.name || a.id || '').trim();
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(a);
    }
    for (const [, list] of groups) {
        const lead = list[0];
        const wave = Math.sin((day + String(lead.id || '').length) * 1.7) * 0.02;
        let change = (Number(lead.trend) || 0) * 0.01 + wave;
        if (disaster && /粮|药|food/i.test(lead.name)) change += 0.03;
        const o = Number(lead.price) || 1;
        const band = limitBand(state, o);
        let c = clampPrice(o * (1 + change));
        c = Math.min(band.up, Math.max(band.down, c));
        const h = Math.min(band.up, clampPrice(Math.max(o, c) * (1 + Math.abs(wave))));
        const l = Math.max(band.down, clampPrice(Math.min(o, c) * (1 - Math.abs(wave))));
        const traded = Number(lead.dayVolume) || 0;
        const bar = { o, h, l, c, v: Math.round(traded > 0 ? traded : 200 + Math.abs(change) * 6000) };
        for (const a of list) {
            a.prevClose = o;
            a.price = c;
            a.candles = [...(a.candles || []), bar].slice(-40);
        }
    }

    for (const a of state.assets) a.dayVolume = 0;
    const month = today.replace(/\d{1,2}日$/, '');
    if (month !== state.lastMonth) {
        const profit = (state.businesses || []).reduce((s, b) => s + (Number(b.profit) || 0), 0);
        state.cash += profit;
        state.lastMonth = month;
        const dividend = state.assets
            .filter(a => isPlayer(a.owner) && (Number(a.qty) || 0) > 0 && Number(a.dividend) > 0)
            .reduce((s2, a) => s2 + Number(a.dividend) * Number(a.qty), 0);
        state.cash += dividend;
        let interest = 0;
        for (const p2 of state.parties) {
            const d = Number(p2.debt) || 0;
            if (d <= 0) continue;
            const fee = Math.round(d * (Number(state.platform.edge) || 0.05) * 0.5);
            if (!fee) continue;
            p2.debt = d + fee;
            interest += fee;
        }
        if (interest) {
            state.log = [...(state.log || []), `- 本月对他人放贷利息累计 ${interest}（记在对方欠债里）`].slice(-30);
            logFlow(state, today, '利息', '放贷收息', interest, '记进对方欠债');
        }
        settleInsolvency(state, today);
        state.log = [...(state.log || []), `- ${month} 店铺结算：+${profit}｜派息：+${dividend.toFixed(2)}`].slice(-30);
    }
    state.lastDay = today;
    state.log = [...(state.log || []), `- ${today} 行情更新${disaster ? '（天灾影响）' : ''}`].slice(-30);
    return state;
}

/** 一笔钱动了就记一行，谁、什么时候、什么名目、多少钱 */
function logFlow(state, day, who, kind, amount, note) {
    const list = Array.isArray(state.flows) ? state.flows : [];
    list.push({ day: String(day || ''), who: String(who || ''), kind: String(kind || ''), amount: Math.round((Number(amount) || 0) * 100) / 100, note: String(note || '') });
    state.flows = list.slice(-500);
}

/** 期末爆仓检查：欠的钱超过现钱加持仓，就当场强平；玩家自己一样要挨这一刀 */
function settleInsolvency(state, dayText) {
    const log = [];
    const priceOf = name => {
        const a = state.assets.find(x => String(x.name || '') === String(name || ''));
        return a ? Number(a.price) || 0 : 0;
    };
    const liquidate = (owner, holder) => {
        let recovered = 0;
        for (const a of state.assets) {
            if (String(a.owner || '').trim() !== String(owner || '').trim()) continue;
            const qty = Math.max(0, Number(a.qty) || 0);
            if (!qty) continue;
            const px = Number(a.price) || 0;
            recovered += qty * px * 0.9;
            a.qty = 0;
            a.cost = 0;
            a.short = 0;
        }
        return recovered;
    };
    for (const p2 of state.parties) {
        const holds = state.assets
            .filter(a => String(a.owner || '').trim() === p2.name)
            .reduce((sum, a) => sum + (Number(a.price) || 0) * Math.max(0, Number(a.qty) || 0), 0);
        const worth = (Number(p2.cash) || 0) + holds;
        const debt = Number(p2.debt) || 0;
        if (debt <= 0 || p2.insolvent) continue;
        if (worth < debt) {
            const got = liquidate(p2.name, p2);
            p2.cash = (Number(p2.cash) || 0) + got;
            state.cash += got;
            p2.debt = 0;
            p2.insolvent = true;
            state.platform.exposure = Math.min(100, (Number(state.platform.exposure) || 0) + 8);
            logFlow(state, dayText, p2.name, '爆仓强平', got, `欠 ${debt}，持仓折价九成变卖`);
            log.push(`- ${p2.name} 爆仓：欠 ${debt}，强平回收 ${got.toFixed(2)}`);
        }
    }
    // 玩家自己
    const myHolds = state.assets
        .filter(a => isPlayer(a.owner))
        .reduce((sum, a) => sum + (Number(a.price) || 0) * Math.max(0, Number(a.qty) || 0), 0);
    const myDebt = Number(state.debt) || 0;
    if (myDebt > 0 && (Number(state.cash) || 0) + myHolds < myDebt) {
        const got = liquidate('', null);
        state.cash += got;
        state.debt = Math.max(0, myDebt - got);
        logFlow(state, dayText, '我', '爆仓强平', got, `被强平，偿债 ${got.toFixed(2)}`);
        log.push(`- 你被强平：回收 ${got.toFixed(2)}，剩余欠债 ${state.debt}`);
    }
    if (log.length) state.log = [...(state.log || []), ...log].slice(-30);
    return log;
}

function playerTotal(state) {
    const mine = state.assets.filter(a => isPlayer(a.owner));
    const holdings = mine.reduce((s, a) => s + Number(a.price) * Math.max(0, Number(a.qty) || 0), 0);
    // 融券是欠人家的券，按市价折算成负债
    const shorts = mine.reduce((s, a) => s + Number(a.price) * Math.max(0, Number(a.short) || 0), 0);
    return Number(state.cash || 0) + holdings - Number(state.debt || 0) - shorts;
}

function limitBand(state, prevClose) {
    const rate = Number(state.limitRate) || 0.1;
    const p = Number(prevClose) || 0;
    return { up: clampPrice(p * (1 + rate)), down: clampPrice(p * (1 - rate)) };
}

/** 冲击成本：一次买/卖相对流通盘越大，价格被推得越多 */
function impactOn(state, asset, shares, side) {
    const supply = supplyOf(state, String(asset.name || '')) || 0;
    const base = supply > 0 ? supply : Math.max(1, Number(asset.qty) || 1) * 10;
    const ratio = Math.max(0, Number(shares) || 0) / base;
    const k = Number(state.impact) || 0.02;
    const move = Math.min(0.2, ratio * k * (side === 'buy' ? 1 : -1));
    return move;
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

function section(text) {
    const div = document.createElement('div');
    div.className = 'nt-quest-section';
    div.textContent = text;
    return div;
}

function note(text) {
    const div = document.createElement('div');
    div.className = 'nt-quick-note';
    div.textContent = text;
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

function marketOpen(bookData) {
    const entries = Object.values(bookData?.entries || {});
    const org = entries.find(e => e && (e.comment === '经济机构' || e.comment === '交易所'));
    if (!org) return false;
    const text = String(org.content || '');
    if (/状态：开放/.test(text)) return true;
    if (/状态：筹备|状态：关闭|状态：不存在/.test(text)) return false;
    return /交易所/.test(text);
}

/** 同名标的的流通盘：取所有条目里最大的 supply，没有就按持仓合计兜底 */
function supplyOf(state, name) {
    const list = state.assets.filter(a => String(a.name || '') === name);
    const declared = list.reduce((s, a) => Math.max(s, Number(a.supply) || 0), 0);
    const held = list.reduce((s, a) => s + Math.max(0, Number(a.qty) || 0), 0);
    return declared > 0 ? declared : held;
}

function rankLists(state) {
    const byName = new Map();
    for (const a of state.assets) {
        const name = String(a.name || '').trim();
        if (!name) continue;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(a);
    }
    const inflow = [];
    const share = [];
    const recent = [];
    for (const [name, list] of byName) {
        const supply = supplyOf(state, name);
        for (const a of list) {
            const owner = isPlayer(a.owner) ? '我' : String(a.owner || '').trim();
            const flow = Number(a.inflow) || 0;
            if (flow) inflow.push({ name, owner, value: flow });
            const qty = Math.max(0, Number(a.qty) || 0);
            if (qty > 0 && supply > 0) share.push({ name, owner, value: (qty / supply) * 100 });
            const flows = Array.isArray(a.dayFlows) ? a.dayFlows.slice(-3) : [];
            const sum3 = flows.reduce((s, f) => s + (Number(f.amount) || 0), 0);
            if (Math.abs(sum3) > 0.001) recent.push({ name, owner, value: sum3 });
        }
    }
    const cut = (arr, n) => arr.sort((x, y) => Math.abs(y.value) - Math.abs(x.value)).slice(0, n);
    return { inflow: cut(inflow, 5), share: cut(share, 5), recent: cut(recent, 5) };
}

export async function buildEconomyPanel(book, dateText = '') {
    const body = document.createElement('div');
    body.className = 'nt-economy-panel';
    const bookData = await stBridge.loadWorldInfoAsync(book, true);
    const open = marketOpen(bookData);
    const state = await settle(book, await load(book), dateText);
    await save(book, state);

    const summary = document.createElement('div');
    summary.className = 'nt-quest-main';
    const title = document.createElement('div');
    title.className = 'nt-quest-title';
    title.textContent = '经营资产';
    summary.appendChild(title);
    summary.appendChild(row('现金', String(state.cash)));
    const shortDebt = state.assets
        .filter(a => isPlayer(a.owner))
        .reduce((s2, a) => s2 + Number(a.price) * Math.max(0, Number(a.short) || 0), 0);
    summary.appendChild(row('融资负债', String(state.debt || 0)));
    summary.appendChild(row('融券负债', shortDebt.toFixed(2)));
    summary.appendChild(row('总资产', String(Math.round(playerTotal(state) * 100) / 100)));
    summary.appendChild(row('最后行情', state.lastDay || '未结算'));
    summary.appendChild(row('当前模式', (MODES.find(m => m.key === state.mode) || MODES[0]).label));
    body.appendChild(summary);

    // 模式切换：纯投资 / 做市商 / 交易所
    const modeBar = document.createElement('div');
    modeBar.className = 'nt-quick-char-actions';
    modeBar.style.flexWrap = 'wrap';
    for (const m of MODES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nt-quick-btn-text' + (state.mode === m.key ? ' primary' : '');
        btn.textContent = m.label;
        btn.addEventListener('click', async () => {
            state.mode = m.key;
            state.log = [...(state.log || []), `- 模式切换：${m.label}`].slice(-30);
            await save(book, state);
            body.replaceWith(await buildEconomyPanel(book, dateText));
        });
        modeBar.appendChild(btn);
    }
    body.appendChild(modeBar);

    if (!state.assets.length && !state.businesses.length) {
        body.appendChild(note('经济数据尚未生成。等 AI 根据当前世界观建立账户、资金、股票、店铺或产业后，这里才会出现内容。'));
        return body;
    }

    // 排行榜：庄家视角最该看的三张
    const ranks = rankLists(state);
    if (ranks.inflow.length || ranks.share.length || ranks.recent.length) {
        body.appendChild(section('排行榜'));
        const fmt = (tag, list, unit) => {
            if (!list.length) return;
            const line = list
                .map(x => `${x.owner || '我'}·${x.name} ${unit === '%' ? x.value.toFixed(1) + '%' : x.value.toFixed(0)}`)
                .join('  ');
            body.appendChild(row(tag, line));
        };
        fmt('净投入', ranks.inflow, '');
        fmt('持仓占比', ranks.share, '%');
        fmt('近三日净流入', ranks.recent, '');
    }

    if (!open) {
        body.appendChild(note('本世界还没有证券交易所。想炒股，需要先在剧情里让交易所、商号股份和交易规则出现。'));
    } else {
        body.appendChild(section('我的持仓 / 市场'));
    }

    const mine = open ? state.assets.filter(a => isPlayer(a.owner)) : [];
    const rowId = a => String(a.id || a.name || '');
    const expanded = expandedKey;

    // 行情列表：一行一只，点一下才展开下单卡
    if (mine.length) {
        const head = document.createElement('div');
        head.className = 'nt-quote-head';
        for (const [cls, label] of [['name', '名称'], ['price', '现价'], ['chg', '涨跌'], ['qty', '持仓'], ['share', '占比']]) {
            const c = document.createElement('span');
            c.className = 'nt-quote-' + cls;
            c.textContent = label;
            head.appendChild(c);
        }
        body.appendChild(head);
    }
    for (const asset of mine) {
        const isOpen = expanded === rowId(asset);
        const row = document.createElement('div');
        row.className = 'nt-quote-row' + (isOpen ? ' open' : '');
        row.addEventListener('click', async (ev) => {
            if (ev.target.closest('.nt-trade-form') || ev.target.closest('button')) return;
            expandedKey = isOpen ? '' : rowId(asset);
            body.replaceWith(await buildEconomyPanel(book, dateText));
        });

        const change = asset.prevClose ? ((asset.price - asset.prevClose) / asset.prevClose) * 100 : 0;
        const share = supplyOf(state, String(asset.name || ''));
        const shareTxt = share > 0 ? `${(Math.max(0, asset.qty) / share * 100).toFixed(1)}%` : '—';
        const nameEl = document.createElement('span');
        nameEl.className = 'nt-quote-name';
        nameEl.textContent = asset.name;
        if ((Number(asset.qty) || 0) > 0) {
            const tag = document.createElement('i');
            tag.className = 'nt-quote-tag';
            tag.textContent = '持';
            nameEl.appendChild(tag);
        }
        const priceEl = document.createElement('span');
        priceEl.className = 'nt-quote-price';
        priceEl.textContent = String(asset.price);
        const chgEl = document.createElement('span');
        chgEl.className = 'nt-quote-chg ' + (change > 0 ? 'up' : change < 0 ? 'down' : 'flat');
        chgEl.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
        const qtyEl = document.createElement('span');
        qtyEl.className = 'nt-quote-qty';
        qtyEl.textContent = String(Math.max(0, Number(asset.qty) || 0));
        const shareEl = document.createElement('span');
        shareEl.className = 'nt-quote-share';
        shareEl.textContent = shareTxt;
        row.append(nameEl, priceEl, chgEl, qtyEl, shareEl);
        body.appendChild(row);

        if (!isOpen) continue;

        const detail = document.createElement('div');
        detail.className = 'nt-quote-detail';
        const canvas = document.createElement('canvas');
        canvas.width = 260;
        canvas.height = 56;
        canvas.className = 'nt-economy-kline';
        detail.appendChild(canvas);
        requestAnimationFrame(() => drawKline(canvas, asset.candles));

        const bandTxt = (() => {
            const b = limitBand(state, asset.prevClose || asset.price);
            return `涨停 ${b.up}  跌停 ${b.down}`;
        })();
        const line = document.createElement('div');
        line.className = 'nt-quest-read-detail';
        line.textContent = `成本 ${asset.cost || 0}｜融券 ${asset.short || 0}｜${asset.type || ''}`
            + `｜买一 ${(asset.price * 0.999).toFixed(2)} 卖一 ${(asset.price * 1.001).toFixed(2)}`
            + `｜${bandTxt}`;
        detail.appendChild(line);

        const actions = document.createElement('div');
        actions.className = 'nt-quick-char-actions';

        const openForm = (mode) => {
            detail.querySelectorAll('.nt-trade-form').forEach(el => el.remove());
            const labels = { buy: '买入', sell: '卖出', margin: '融资买入', short: '融券卖出', cover: '买券还券' };
            const max = mode === 'buy' ? Math.floor(state.cash / asset.price)
                : mode === 'sell' ? (asset.qty || 0)
                : mode === 'margin' ? Math.floor((state.cash * 2) / asset.price)
                : mode === 'short' ? 1000
                : (asset.short || 0);
            const form = document.createElement('div');
            form.className = 'nt-trade-form';
            const title2 = document.createElement('div');
            title2.className = 'nt-trade-title';
            const badge = document.createElement('span');
            badge.className = 'nt-trade-badge';
            badge.textContent = `现价 ${asset.price}`;
            title2.textContent = `${labels[mode]} · ${asset.name}`;
            title2.appendChild(badge);
            form.appendChild(title2);
            const meta = document.createElement('div');
            meta.className = 'nt-trade-meta';
            meta.textContent = `可操作上限：${Math.max(0, max)}`;
            form.appendChild(meta);
            const input = document.createElement('input');
            input.type = 'number';
            input.min = '1';
            input.step = '1';
            input.value = String(Math.min(1, Math.max(0, max)));
            input.className = 'nt-trade-input';
            form.appendChild(input);
            const chips = document.createElement('div');
            chips.className = 'nt-trade-chips';
            for (const [label, ratio] of [['1/4', 0.25], ['1/2', 0.5], ['全部', 1]]) {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'nt-trade-chip';
                chip.textContent = label;
                chip.addEventListener('click', () => {
                    input.value = String(Math.max(0, Math.floor(max * ratio)));
                    update();
                });
                chips.appendChild(chip);
            }
            form.appendChild(chips);
            const calc = document.createElement('div');
            calc.className = 'nt-trade-preview';
            form.appendChild(calc);
            const err = document.createElement('div');
            err.className = 'nt-trade-error';
            form.appendChild(err);
            const fee = () => (state.mode === 'exchange' ? Number(state.feeRate) || 0 : 0);
            const update = () => {
                const n = Math.max(0, parseInt(input.value || '0', 10) || 0);
                const buySide = mode === 'buy' || mode === 'margin' || mode === 'cover';
                const move = impactOn(state, asset, n, buySide ? 'buy' : 'sell');
                const bandEst = limitBand(state, asset.prevClose || asset.price);
                const est = Math.min(bandEst.up, Math.max(bandEst.down, clampPrice(asset.price * (1 + move))));
                const amount = n * est;
                const f = amount * fee();
                const cashFlow = (mode === 'sell' || mode === 'short') ? amount - f : amount + f;
                calc.innerHTML = '';
                const kv = (k, v, tone) => {
                    const r2 = document.createElement('div');
                    r2.className = 'nt-trade-kv' + (tone ? ' ' + tone : '');
                    const a2 = document.createElement('span');
                    a2.textContent = k;
                    const b2 = document.createElement('span');
                    b2.textContent = v;
                    r2.append(a2, b2);
                    calc.appendChild(r2);
                };
                kv('预计成交价', `${est.toFixed(2)}（${move >= 0 ? '+' : ''}${(move * 100).toFixed(2)}%）`, buySide ? 'up' : 'down');
                kv(mode === 'sell' || mode === 'short' ? '预计回款' : '预计花费', amount.toFixed(2));
                if (f > 0) kv('手续费', f.toFixed(2), 'dim');
                kv(mode === 'sell' || mode === 'short' ? '到手' : '合计支出', cashFlow.toFixed(2), mode === 'sell' || mode === 'short' ? 'up' : 'down');
                err.textContent = n > max ? '超过可操作上限' : '';
            };
            input.addEventListener('input', update);
            update();
            const bar = document.createElement('div');
            bar.className = 'nt-quick-char-actions';
            const confirm = document.createElement('button');
            confirm.type = 'button';
            const buyish = mode === 'buy' || mode === 'margin' || mode === 'cover';
            confirm.className = 'nt-trade-confirm ' + (buyish ? 'buy' : 'sell');
            confirm.textContent = '确认下单';
            confirm.addEventListener('click', async () => {
                const n = Math.max(0, parseInt(input.value || '0', 10) || 0);
                if (!n || n > max) { err.textContent = '数量无效或超过上限'; return; }
                const amount = n * asset.price;
                const f = amount * fee();
                if (mode === 'buy') {
                    state.cash -= amount + f;
                    asset.qty += n;
                    asset.cost = Math.round(((asset.cost * (asset.qty - n) + amount) / asset.qty) * 100) / 100;
                    asset.inflow = (Number(asset.inflow) || 0) + amount;
                } else if (mode === 'sell') {
                    state.cash += amount - f;
                    asset.qty -= n;
                    asset.inflow = (Number(asset.inflow) || 0) - amount;
                } else if (mode === 'margin') {
                    const need = amount + f;
                    if (need > state.cash) { state.debt += need - state.cash; state.cash = 0; }
                    else state.cash -= need;
                    asset.qty += n;
                    asset.inflow = (Number(asset.inflow) || 0) + amount;
                } else if (mode === 'short') {
                    state.cash += amount - f;
                    asset.short = (Number(asset.short) || 0) + n;
                } else {
                    state.cash -= amount + f;
                    asset.short = (Number(asset.short) || 0) - n;
                    asset.inflow = (Number(asset.inflow) || 0) - amount;
                }
                if (state.mode === 'exchange') state.cash += f;
                const buySide = mode === 'buy' || mode === 'margin' || mode === 'cover';
                const band = limitBand(state, asset.prevClose || asset.price);
                const move = impactOn(state, asset, n, buySide ? 'buy' : 'sell');
                const pushed = clampPrice(asset.price * (1 + move));
                asset.price = Math.min(band.up, Math.max(band.down, pushed));
                asset.dayVolume = (Number(asset.dayVolume) || 0) + n;
                const day = state.lastDay || '未结算';
                const flows = Array.isArray(asset.dayFlows) ? asset.dayFlows : [];
                const last = flows.at(-1);
                if (last && last.day === day) last.amount += (mode === 'sell' || mode === 'cover' ? -amount : amount);
                else flows.push({ day, amount: mode === 'sell' || mode === 'cover' ? -amount : amount });
                asset.dayFlows = flows.slice(-10);
                logFlow(state, state.lastDay || '', '我', labels[mode], buySide ? -amount : amount, `${asset.name} ×${n} @${asset.price}`);
                if (f > 0) logFlow(state, state.lastDay || '', state.mode === 'exchange' ? '我(交易所)' : '市场', '手续费', f, `${asset.name} ×${n}`);
                await save(book, state);
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'nt-quick-btn-text';
            cancel.textContent = '取消';
            cancel.addEventListener('click', () => form.remove());
            bar.appendChild(confirm);
            bar.appendChild(cancel);
            form.appendChild(bar);
            detail.appendChild(form);
        };

        for (const [key, label] of [['buy', '买入'], ['sell', '卖出'], ['margin', '融资买入'], ['short', '融券卖出'], ['cover', '买券还券']]) {
            const b = document.createElement('button');
            b.type = 'button';
            const up = key === 'buy' || key === 'margin';
            const down = key === 'sell' || key === 'short';
            b.className = 'nt-trade-act' + (up ? ' buy' : down ? ' sell' : '');
            b.textContent = label;
            b.addEventListener('click', () => openForm(key));
            actions.appendChild(b);
        }
        detail.appendChild(actions);
        body.appendChild(detail);
    }

    // 别人的持仓：只读
    const others = open ? state.assets.filter(a => !isPlayer(a.owner)) : [];
    if (others.length) {
        body.appendChild(section('他人持仓'));
        const grouped = new Map();
        for (const a of others) {
            const owner = String(a.owner || '').trim();
            if (!grouped.has(owner)) grouped.set(owner, []);
            grouped.get(owner).push(a);
        }
        for (const [owner, list] of grouped) {
            const item = document.createElement('div');
            item.className = 'nt-quest-read-item';
            const n = document.createElement('div');
            n.className = 'nt-quest-read-name';
            n.textContent = owner;
            item.appendChild(n);
            const d = document.createElement('div');
            d.className = 'nt-quest-read-detail';
            d.textContent = list
                .map(a => `${a.name}×${a.qty || 0}（${a.price}）`)
                .join('　');
            item.appendChild(d);
            body.appendChild(item);
        }
    }

    // ── 场子（通用）：可以开成交易所、赌场、商会，门槛和抽水都能改 ──
    if (state.mode !== 'trader') {
        const pf = state.platform;
        body.appendChild(section(`场子 · ${pf.name || '未命名'}`));
        const mk = document.createElement('div');
        mk.className = 'nt-quick-note';
        mk.textContent = `类型 ${pf.kind}｜入场规矩 ${pf.gate || '（没写，随你）'}｜抽水 ${(pf.edge * 100).toFixed(1)}%｜注意度 ${Math.round(pf.exposure)}%｜在册 ${state.members.length} 人`;
        body.appendChild(mk);

        const bar = document.createElement('div');
        bar.className = 'nt-quick-char-actions';

        const setup = document.createElement('button');
        setup.type = 'button';
        setup.className = 'nt-trade-act';
        setup.textContent = '设置场子';
        setup.addEventListener('click', async () => {
            const name = window.prompt('这场子叫什么名字？', pf.name || '');
            if (name === null) return;
            const kind = window.prompt('类型随便写：casino / exchange / shop / 学校社团群 / 什么都行', pf.kind || 'casino');
            const gate = window.prompt('入场规矩自己写，写空就是不设限（例：交押金 / 要有熟人带 / 拍正面照 / 背出社规）', pf.gate || '');
            const edge = Number(window.prompt('抽水率（0.05 就是 5%，0 就是不抽）', String(pf.edge || 0.05)) || pf.edge);
            pf.name = String(name || '');
            pf.kind = String(kind || 'casino');
            pf.gate = String(gate || '');
            pf.edge = Math.max(0, Math.min(0.5, edge));
            state.log = [...(state.log || []), `- 场子更新：${pf.name}｜${pf.kind}｜规矩 ${pf.gate || '不设限'}｜抽水 ${(pf.edge * 100).toFixed(1)}%`].slice(-30);
            await save(book, state);
            body.replaceWith(await buildEconomyPanel(book, dateText));
        });
        bar.appendChild(setup);

        body.appendChild(bar);

        const sorted = [...state.members].sort((a, b) => (Number(b.deposit) || 0) - (Number(a.deposit) || 0));
        for (const m of sorted) {
            const item = document.createElement('div');
            item.className = 'nt-quest-read-item';
            const n = document.createElement('div');
            n.className = 'nt-quest-read-name';
            n.textContent = `${m.name}${m.proof ? `｜${m.proof}` : ''}${(Number(m.suspect) || 0) >= 60 ? '｜可疑' : ''}`;
            const d = document.createElement('div');
            d.className = 'nt-quest-read-detail';
            d.textContent = `入金 ${Number(m.deposit) || 0}｜余额 ${Number(m.balance) || 0}｜入会 ${m.joined || '—'}`;
            const act = document.createElement('div');
            act.className = 'nt-quick-char-actions';
            const inBtn = document.createElement('button');
            inBtn.type = 'button';
            inBtn.className = 'nt-trade-act buy';
            inBtn.textContent = '收款入金';
            inBtn.addEventListener('click', async () => {
                const v = Number(window.prompt(`收 ${m.name} 多少钱？`, '1000') || 0);
                if (!v) return;
                m.deposit = (Number(m.deposit) || 0) + v;
                m.balance = (Number(m.balance) || 0) + v;
                state.cash += v;
                pf.exposure = Math.min(100, (Number(pf.exposure) || 0) + 2);
                state.log = [...(state.log || []), `- ${m.name} 入金 ${v}`].slice(-30);
                logFlow(state, state.lastDay || '', m.name, '入金', v, pf.name || '场子');
                await save(book, state);
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            const bankBtn = document.createElement('button');
            bankBtn.type = 'button';
            bankBtn.className = 'nt-trade-act';
            bankBtn.textContent = '抽水';
            bankBtn.addEventListener('click', async () => {
                const take = Math.round((Number(m.balance) || 0) * (Number(pf.edge) || 0.05));
                if (!take) return;
                m.balance = (Number(m.balance) || 0) - take;
                state.cash += take;
                pf.exposure = Math.min(100, (Number(pf.exposure) || 0) + 3);
                state.log = [...(state.log || []), `- 从 ${m.name} 抽水 ${take}`].slice(-30);
                logFlow(state, state.lastDay || '', m.name, '抽水', -take, pf.name || '场子');
                await save(book, state);
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            act.append(inBtn, bankBtn);
            item.append(n, d, act);
            body.appendChild(item);
        }

        const ruleBox = document.createElement('div');
        ruleBox.className = 'nt-quick-note';
        ruleBox.textContent = state.rules ? `场子自己的规矩：${state.rules}` : '规矩还没写。想加什么玩法，就写在世界书里，或者让我写进去。';
        body.appendChild(ruleBox);

        const ruleBtn = document.createElement('button');
        ruleBtn.type = 'button';
        ruleBtn.className = 'nt-trade-act';
        ruleBtn.textContent = '写规矩';
        ruleBtn.addEventListener('click', async () => {
            const r = window.prompt('这场子的规矩你自己定，写什么都行（程序不解读，只按这句话记账和结算）', state.rules || '');
            if (r === null) return;
            state.rules = String(r || '');
            await save(book, state);
            body.replaceWith(await buildEconomyPanel(book, dateText));
        });
        bar.appendChild(ruleBtn);

        if (pf.exposure >= 60) {
            const warn = document.createElement('div');
            warn.className = 'nt-quick-note';
            warn.textContent = `注意度 ${Math.round(pf.exposure)}%：已经有人开始打听这场子是谁开的了`;
            body.appendChild(warn);
        }
    }

    // ── 经济主体：玩家之外的人也有钱、有仓、有欠债 ────────────
    body.appendChild(section('其他人 / 其他势力'));
    {
        const pbar = document.createElement('div');
        pbar.className = 'nt-quick-char-actions';
        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.className = 'nt-trade-act';
        syncBtn.textContent = '跟随剧情同步参与者';
        syncBtn.addEventListener('click', async () => {
            const data2 = await stBridge.loadWorldInfoAsync(book, true);
            const names = Object.values(data2?.entries || {})
                .map(e => String(e && e.comment || ''))
                .filter(c => c.startsWith('角色·'))
                .map(c => c.slice(3).trim())
                .filter(Boolean)
                .filter(n => !/^(我|玩家|主角|用户)$/.test(n));
            let added = 0;
            for (const n of names) {
                if (state.parties.some(p2 => p2.name === n)) continue;
                const hasBook = state.assets.some(a => String(a.owner || '').trim() === n);
                state.parties.push({ name: n, cash: 0, debt: 0, note: hasBook ? '持着仓' : '' });
                added += 1;
            }
            if (added) state.log = [...(state.log || []), `- 同步到 ${added} 位新参与者（来自角色追踪）`].slice(-30);
            await save(book, state);
            body.replaceWith(await buildEconomyPanel(book, dateText));
        });
        pbar.appendChild(syncBtn);
        body.appendChild(pbar);
    }
    if (state.parties.length) {
        for (const p2 of state.parties) {
            const holds = state.assets.filter(a => String(a.owner || '').trim() === p2.name);
            const holdValue = holds.reduce((sum, a) => sum + (Number(a.price) || 0) * Math.max(0, Number(a.qty) || 0), 0);
            const item = document.createElement('div');
            item.className = 'nt-quest-read-item';
            const n = document.createElement('div');
            n.className = 'nt-quest-read-name';
            n.textContent = p2.name + (p2.note ? `｜${p2.note}` : '') + (p2.insolvent ? '｜已爆仓' : '');
            const d = document.createElement('div');
            d.className = 'nt-quest-read-detail';
            d.textContent = `现金 ${p2.cash}｜持仓 ${holdValue.toFixed(2)}｜欠债 ${p2.debt}`
                + (holds.length ? `｜持 ${holds.map(a => `${a.name}×${a.qty || 0}`).join('、')}` : '');
            const act = document.createElement('div');
            act.className = 'nt-quick-char-actions';
            const pay = document.createElement('button');
            pay.type = 'button';
            pay.className = 'nt-trade-act buy';
            pay.textContent = '给我钱';
            pay.addEventListener('click', async () => {
                const v = Number(window.prompt(`向 ${p2.name} 收多少？`, '0') || 0);
                if (v <= 0) return;
                if (p2.cash < v) { window.alert(`${p2.name} 拿不出来这么多`); return; }
                p2.cash -= v;
                state.cash += v;
                state.log = [...(state.log || []), `- ${p2.name} 交了 ${v}`].slice(-30);
                logFlow(state, state.lastDay || '', p2.name, '交钱', v, '');
                await save(book, state);
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            const lend = document.createElement('button');
            lend.type = 'button';
            lend.className = 'nt-trade-act sell';
            lend.textContent = '给我欠债';
            lend.addEventListener('click', async () => {
                const v = Number(window.prompt(`让 ${p2.name} 欠你多少？`, '0') || 0);
                if (v <= 0) return;
                p2.debt = (Number(p2.debt) || 0) + v;
                p2.cash += v;
                state.log = [...(state.log || []), `- 放给 ${p2.name} ${v}（记债）`].slice(-30);
                logFlow(state, state.lastDay || '', p2.name, '放贷', -v, '记成债权');
                await save(book, state);
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            const repay = document.createElement('button');
            repay.type = 'button';
            repay.className = 'nt-trade-act';
            repay.textContent = '还债';
            repay.addEventListener('click', async () => {
                const v = Number(window.prompt(`${p2.name} 还多少？（现欠 ${p2.debt || 0}）`, String(Math.min(Number(p2.debt) || 0, 1000))) || 0);
                if (v <= 0) return;
                const real = Math.min(v, Number(p2.debt) || 0);
                if (!real) return;
                p2.debt = (Number(p2.debt) || 0) - real;
                p2.cash -= real;
                if (p2.cash < 0) { state.debt = (Number(state.debt) || 0) + (-p2.cash); p2.cash = 0; }
                state.cash += real;
                state.log = [...(state.log || []), `- ${p2.name} 还债 ${real}`].slice(-30);
                logFlow(state, state.lastDay || '', p2.name, '还债', real, '');
                await save(book, state);
                body.replaceWith(await buildEconomyPanel(book, dateText));
            });
            act.append(pay, lend, repay);
            item.append(n, d, act);
            body.appendChild(item);
        }
    }

    // ── 流水明细 ───────────────────────────────────────────
    {
        body.appendChild(section('流水明细'));
        const flows = Array.isArray(state.flows) ? state.flows.slice(-12).reverse() : [];
        if (!flows.length) {
            body.appendChild(note('还没有流水。第一笔入金、第一单成交之后，这里会一条条记下来。'));
        } else {
            for (const f of flows) {
                body.appendChild(row(`${f.day || '—'}｜${f.who || '—'}｜${f.kind}`, `${f.amount >= 0 ? '+' : ''}${f.amount}`));
            }
        }
        const bar2 = document.createElement('div');
        bar2.className = 'nt-quick-char-actions';
        const exportBtn = document.createElement('button');
        exportBtn.type = 'button';
        exportBtn.className = 'nt-trade-act';
        exportBtn.textContent = '导出全部明细';
        exportBtn.addEventListener('click', async () => {
            const all = Array.isArray(state.flows) ? state.flows : [];
            const tsv = ['日期\t谁\t名目\t金额\t备注']
                .concat(all.map(f => [f.day, f.who, f.kind, f.amount, f.note].join('\t')))
                .join('\n');
            let copied = false;
            try { await navigator.clipboard.writeText(tsv); copied = true; } catch (_) {}
            const box = document.createElement('textarea');
            box.value = tsv || '（没有流水）';
            box.rows = 12;
            box.className = 'nt-trade-input';
            box.style.fontSize = '10px';
            body.appendChild(row('已复制到剪贴板', copied ? '是' : '否（请手动全选复制）'));
            body.appendChild(box);
            box.focus();
            box.select();
        });
        bar2.appendChild(exportBtn);
        body.appendChild(bar2);
    }

    body.appendChild(section('店铺 / 产业'));
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
