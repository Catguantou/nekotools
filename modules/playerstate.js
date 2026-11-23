import { registry } from '../core/registry.js';
import { stBridge } from '../core/st_bridge.js';

const TAG = 'ws_player';
const SECTIONS = [
    { key: '玩家势力', title: '玩家势力' },
    { key: '据点', title: '据点' },
    { key: '经营资产', title: '经营资产' },
    { key: '文娱作品', title: '文娱作品' },
];

function prompt() {
    return `<nekotools:playerstate>
【玩家状态更新】
只在本轮玩家确实做了以下事情时更新对应内容，没有发生就不输出：
- 建立/加入势力，人员或职位变化；
- 建立、搬迁、升级据点；
- 账户、资产、店铺、产业发生变化；
- 开始创作、发布作品、作品反馈变化。

用 <${TAG}> 包裹变化内容，按段写：
【玩家势力】
...
【据点】
...
【经营资产】
...
【文娱作品】
...

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
        for (const section of SECTIONS) {
            const content = sections[section.key];
            if (!content) continue;
            await stBridge.updateEntry(book, section.title, content, true, [], {
                position: 0, depth: 0, order: 870,
            });
        }
    },
});
