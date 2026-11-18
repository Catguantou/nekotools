// 新手引导：4 步、可跳过、可重开；首次打开 NEKOTOOL 面板且有角色时自动弹。
import { settings } from './settings.js';
import { stBridge } from './st_bridge.js';

const GUIDE_VERSION = 1;
const MASK_ID = 'nt-guide-mask';
let mounted = false;
let currentStep = 0;

const STEPS = [
    {
        title: 'NEKOTOOL 是什么',
        body: () => `
            <div class="nt-guide-kicker">01 / 四个入口</div>
            <h3>世界书管理器</h3>
            <ul>
                <li>角色卡可以绑定它原来的世界书</li>
                <li>删除角色卡可以同步删除绑定的世界书，删除世界书也可以同步删除角色卡</li>
                <li>删除角色卡时可以选择同步删除聊天记录</li>
                <li>在面板里多选世界书删除</li>
                <li>进入一本书后，多选条目删除</li>
                <li>多选条目转发到其他世界书</li>
            </ul>
            <h3>文本管理器</h3>
            <ul>
                <li>收藏喜欢的楼层</li>
                <li>导出纯 TXT 文本</li>
                <li>自定义八股清理规则，支持视觉隐藏、真正删除、撤销</li>
            </ul>
            <h3>世界模拟</h3>
            <ul>
                <li>总开关决定：状态栏、预览、角色、世界、地图、支线、总结等哪些会运行</li>
                <li>可以自定义提示词；默认提示词会直接显示在自定义输入框里</li>
                <li>请求更新时可以选择用主 API 还是副 API</li>
            </ul>
            <h3>TOOL 菜单</h3>
            <p class="nt-guide-note">世界时钟、地图、新闻日报、世界日志、角色管理、可办事项、快捷行动、请求更新、存档、手动修改，以及每轮自动全量更新。</p>
        `,
    },
    {
        title: '选择运行方式',
        body: () => {
            const hasSub = hasSecondaryApi();
            return `
                <div class="nt-guide-kicker">02 / 主 API 与副 API</div>
                <label class="nt-guide-choice"><input type="radio" name="nt-guide-mode" value="light" checked> <b>轻量模式</b><span>只用主 API，每轮自动增量更新。</span></label>
                <label class="nt-guide-choice"><input type="radio" name="nt-guide-mode" value="split"> <b>分开模式</b><span>主 API 写正文，副 API 每轮全量更新世界书。</span></label>
                <label class="nt-guide-choice"><input type="radio" name="nt-guide-mode" value="later"> <b>先不决定</b><span>之后在 NEKOTOOL 设置里改。</span></label>
                <p class="nt-guide-note">${hasSub ? '已经检测到副 API 配置，可以直接用。' : '副 API 需要先在设置里保存一套配置。'}</p>
                <button type="button" class="nt-guide-link" id="nt-guide-open-api">[去 API 配置]</button>
            `;
        },
        after: () => {
            const btn = document.getElementById('nt-guide-open-api');
            if (btn) btn.onclick = () => {
                closeGuide(false);
                window.dispatchEvent(new CustomEvent('nekotool:open-api-settings'));
            };
        },
    },
    {
        title: '面板位置',
        body: () => `
            <div class="nt-guide-kicker">03 / 常用入口</div>
            <div class="nt-guide-map">
                <div><b>01 概览</b><span>模块开关、总结开关、运行限制</span></div>
                <div><b>02 世界模拟</b><span>状态栏、角色/世界/地图/支线/总结的追踪开关，自定义提示词</span></div>
                <div><b>03 世界书</b><span>世界书管理、条目管理、多选删除/转发</span></div>
                <div><b>04 文本</b><span>楼层收藏、纯 TXT 导出、八股清理</span></div>
                <div><b>05 设置</b><span>API 配置、数据导入导出、诊断</span></div>
            </div>
            <p class="nt-guide-note">TOOL 菜单是聊天输入栏旁边的竖条，拖到边缘可以半隐藏。常用功能不必每次都进设置。</p>
        `,
    },
    {
        title: '开始使用',
        body: () => {
            const hasSub = hasSecondaryApi();
            return `
                <div class="nt-guide-kicker">04 / 最后一步</div>
                <p>引导不会自动初始化世界书，也不会自动发请求。你可以先自己玩，需要时再点「请求更新」。</p>
                ${hasSub ? `
                <div class="nt-guide-choice-box">
                    <b>之后手动请求更新默认用：</b>
                    <label><input type="radio" name="nt-guide-update-api" value="main" checked> 主 API</label>
                    <label><input type="radio" name="nt-guide-update-api" value="secondary"> 副 API</label>
                </div>` : '<p class="nt-guide-note">还没有副 API，之后请求更新默认使用主 API。</p>'}
                <p class="nt-guide-note">随时可以在 01 概览点「新手引导」重新打开。</p>
            `;
        },
    },
];

function hasSecondaryApi() {
    const cfg = settings.get('worldsim') || {};
    const profiles = Array.isArray(cfg.apiProfiles) ? cfg.apiProfiles : [];
    return profiles.length > 0 || Boolean(cfg.refreshApi && (cfg.refreshApi.profileId || cfg.refreshApi.source || cfg.refreshApi.url));
}

function markOnboarded() {
    settings.set('worldsim', { onboardedVersion: GUIDE_VERSION });
}

function closeGuide(mark = true) {
    const mask = document.getElementById(MASK_ID);
    if (mask) mask.remove();
    if (mark) markOnboarded();
}

function renderStep() {
    const mask = document.getElementById(MASK_ID);
    if (!mask) return;
    const step = STEPS[currentStep];
    const dots = STEPS.map((_, i) => `<span class="nt-guide-dot${i === currentStep ? ' active' : ''}"></span>`).join('');
    mask.innerHTML = `
        <div class="nt-guide-card">
            <div class="nt-guide-head">
                <span class="nt-guide-title">新手引导</span>
                <span class="nt-guide-dots">${dots}</span>
                <button type="button" class="nt-guide-x" title="关闭">×</button>
            </div>
            <div class="nt-guide-step-title">${step.title}</div>
            <div class="nt-guide-body">${step.body()}</div>
            <div class="nt-guide-foot">
                <button type="button" class="nt-guide-btn" id="nt-guide-skip">跳过引导</button>
                <span class="nt-guide-spacer"></span>
                ${currentStep > 0 ? '<button type="button" class="nt-guide-btn" id="nt-guide-prev">上一步</button>' : ''}
                <button type="button" class="nt-guide-btn primary" id="nt-guide-next">${currentStep === STEPS.length - 1 ? '完成' : '下一步'}</button>
            </div>
        </div>`;
    mask.querySelector('.nt-guide-x').onclick = () => closeGuide(true);
    mask.querySelector('#nt-guide-skip').onclick = () => closeGuide(true);
    const prev = mask.querySelector('#nt-guide-prev');
    if (prev) prev.onclick = () => { currentStep--; renderStep(); };
    mask.querySelector('#nt-guide-next').onclick = () => {
        if (currentStep < STEPS.length - 1) {
            currentStep++;
            renderStep();
            if (STEPS[currentStep].after) STEPS[currentStep].after();
            return;
        }
        const choice = document.querySelector('input[name="nt-guide-update-api"]:checked');
        if (choice) {
            const cfg = settings.get('worldsim') || {};
            settings.set('worldsim', { refreshApi: { ...(cfg.refreshApi || {}), manualChoice: choice.value } });
        }
        closeGuide(true);
    };
    if (step.after) step.after();
}

function showGuide(force = false) {
    if (!force && (settings.get('worldsim').onboardedVersion || 0) >= GUIDE_VERSION) return false;
    if (!document.getElementById('nt-ws-panel')) return false;
    const existing = document.getElementById(MASK_ID);
    if (existing) existing.remove();
    currentStep = 0;
    const mask = document.createElement('div');
    mask.id = MASK_ID;
    mask.addEventListener('click', (e) => { if (e.target === mask) closeGuide(true); });
    document.body.appendChild(mask);
    renderStep();
    return true;
}

export function mountOnboarding() {
    if (mounted) return;
    mounted = true;
    window.addEventListener('nekotool:open-guide', () => showGuide(true));
    const maybe = () => {
        if ((settings.get('worldsim').onboardedVersion || 0) >= GUIDE_VERSION) return;
        if (!stBridge.getCharacterName()) return;
        if (document.getElementById(MASK_ID)) return;
        const panel = document.getElementById('nt-ws-panel');
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        if (rect.height < 20) return;
        showGuide(false);
    };
    document.addEventListener('click', (e) => {
        if (e.target.closest('#nt-ws-panel .inline-drawer-toggle, #nt-ws-panel .nt-tab')) setTimeout(maybe, 250);
    }, true);
    setTimeout(maybe, 1800);
    const timer = setInterval(() => {
        if ((settings.get('worldsim').onboardedVersion || 0) >= GUIDE_VERSION) {
            clearInterval(timer);
            return;
        }
        maybe();
    }, 2500);
}
