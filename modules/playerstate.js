import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';

const TAG = 'ws_player';
const SECTIONS = [
    { key: '玩家势力', title: '玩家势力' },
    { key: '据点', title: '据点' },
    { key: '经济机构', title: '经济机构' },
    { key: '经营资产', title: '经营资产' },
    { key: '文娱作品', title: '文娱作品' },
];

function prompt() {
    return `<nekotools:playerstate>
【玩家状态更新】
只在本轮玩家确实做了以下事情时更新对应内容，没有发生就不输出：
- 建立/加入势力，人员或职位变化；
- 建立、搬迁、升级据点；
- 建立交易所、钱庄、市场，或让交易所开放/关闭；
- 玩家开始经营、资金/资产/股票/店铺/产业发生变化；
- 开始创作、发布作品、作品反馈变化。

用 <${TAG}> 包裹变化内容，按段写：
【玩家势力】
...
【据点】
...
【经济机构】
名称：
类型：交易所 / 银行 / 钱庄 / 商会 / 市场 / 其他
状态：筹备 / 开放 / 关闭
范围：
规则：
控制者：
【经营资产】
只写玩家真正开始经营或资产发生变化时；内容用 JSON：
{"cash":0,"debt":0,"assets":[{"id":"唯一短id","name":"资产名","type":"股票/商品/物品","qty":0,"cost":0,"price":10,"prevClose":10,"trend":0,"short":0,"candles":[{"o":10,"h":10,"l":10,"c":10,"v":1000}]}],"businesses":[{"name":"店铺/产业","status":"营业","profit":0}]}
资产名、股票、店铺、产业必须根据当前世界观生成，不要套用现代股票名。
【文娱作品】
只写玩家真的有文娱活动时；内容用 JSON：
{"works":[{"title":"作品名","type":"小说/画/戏/电影/歌","status":"创作中/已发布/连载中/完结","quality":"粗糙/一般/优秀/杰作","heat":"冷清/小有名气/热门/爆火/现象级","spread":"本地/地区/全国/世界","reputation":"差评/一般/好评/神作","heatScore":0,"comments":["代表性评论"],"awards":["奖项"]}]}

只写变化的段，不重写没有变化的段；不要额外发请求。
</nekotools:playerstate>`;
}

function splitSections(text) {
    const out = {};
    let current = '';
    for (const line of String(text || '').split('\n')) {
        const m = line.match(/^【([^】]+)】\s*$/);
        if (m) {
            current = m[1].trim();
            out[current] = '';
        } else if (current) {
            out[current] += (out[current] ? '\n' : '') + line;
        }
    }
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.trim()]));
}

registry.register({
    id: 'playerstate',
    name: '玩家状态',
    enabled: true,
    order: 56,
    tags: [TAG],
    onRequest(ctx) {
        if (Array.isArray(ctx.__nt_pendingSystems)) {
            ctx.__nt_pendingSystems.push({ role: 'system', content: prompt() });
        }
    },
    async onResponse({ captured }) {
        const raw = captured?.[TAG];
        if (!raw) return;
        const book = stBridge.currentTrackerName();
        if (!book) return;
        const sections = splitSections(raw);
        // 一次读盘、一次写盘：先把变化段全挑出来，再看有没有真的变
        const pending = [];
        for (const section of SECTIONS) {
            const content = sections[section.key];
            if (!content) continue;
            pending.push([section, content]);
        }
        if (!pending.length) return;
        const data = await stBridge.loadWorldInfoAsync(book, true);
        if (!data) return;
        let changed = false;
        for (const [section, content] of pending) {
            const entry = Object.values(data.entries || {}).find(e => e && e.comment === section.title);
            if (entry && entry.content === content) continue;
            stBridge.upsertEntryInBook(data, section.title, content, {
                isConstant: true, keywords: [], extra: { position: 0, depth: 0, order: 870 },
            });
            changed = true;
        }
        if (!changed) return;
        await stBridge.persistLorebook(book, data);
    },
});
