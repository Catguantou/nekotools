// 新手引导：4 步、可跳过、可重开；首次打开 NEKOTOOL 面板且有角色时自动弹。
import { settings } from './settings.js';
import { stBridge } from './st_bridge.js';

const GUIDE_VERSION = 1;
const MASK_ID = 'nt-guide-mask';
let mounted = false;
let currentStep = 0;

const STEPS = [
    {
        code: '01',
        title: 'NEKOTOOL 是什么',
        subtitle: '',
        body: () => `
            <div class="nt-guide-modules">
                <section class="nt-guide-module">
                    <div class="nt-guide-module-head"><span class="nt-guide-code">W_01</span><h4>世界书管理器</h4></div>
                    <ul>
                        <li>角色卡可以绑定它原来的世界书</li>
                        <li>删角色卡可同步删绑定的世界书，删世界书也可同步删角色卡</li>
                        <li>删角色卡时可以选择同步删聊天记录</li>
                        <li>面板里多选世界书删除</li>
                        <li>进入一本书后，多选条目删除</li>
                        <li>多选条目转发到其他世界书</li>
                    </ul>
                </section>
                <section class="nt-guide-module">
                    <div class="nt-guide-module-head"><span class="nt-guide-code">T_01</span><h4>文本管理器</h4></div>
                    <ul>
                        <li>收藏喜欢的楼层</li>
                        <li>导出纯 TXT 文本</li>
                        <li>自定义八股清理：视觉隐藏、真正删除、撤销</li>
                    </ul>
                </section>
                <section class="nt-guide-module">
                    <div class="nt-guide-module-head"><span class="nt-guide-code">S_01</span><h4>世界模拟</h4></div>
                    <ul>
                        <li>总开关决定状态栏、预览、角色、世界、地图、支线、总结哪些运行</li>
                        <li>可以自定义提示词，默认提示词会直接显示在输入框里</li>
                        <li>请求更新时可选主 API 或副 API</li>
                    </ul>
                </section>
                <section class="nt-guide-module">
                    <div class="nt-guide-module-head"><span class="nt-guide-code">U_01</span><h4>TOOL 菜单</h4></div>
                    <p>世界时钟、地图、新闻日报、世界日志、角色管理、可办事项、快捷行动、请求更新、存档、手动修改。</p>
                    <p class="nt-guide-dim">请求更新里还可以打开「每轮自动全量更新」。</p>
                </section>
            </div>
        `,
    },
    {
        code: '02',
        title: '选择运行方式',
        subtitle: '主 API 写故事，副 API 可选',
        body: () => {
            const hasSub = hasSecondaryApi();
            return `
                <div class="nt-guide-options">
                    <label class="nt-guide-option">
                        <input type="radio" name="nt-guide-mode" value="light" checked>
                        <span class="nt-guide-radio"></span>
                        <span><b>轻量模式</b><small>只用主 API，每轮自动增量更新。</small></span>
                    </label>
                    <label class="nt-guide-option">
                        <input type="radio" name="nt-guide-mode" value="split">
                        <span class="nt-guide-radio"></span>
                        <span><b>分开模式</b><small>主 API 写正文，副 API 每轮全量更新世界书。</small></span>
                    </label>
                    <label class="nt-guide-option">
                        <input type="radio" name="nt-guide-mode" value="later">
                        <span class="nt-guide-radio"></span>
                        <span><b>先不决定</b><small>之后在 NEKOTOOL 设置里改。</small></span>
                    </label>
                </div>
                <div class="nt-guide-callout">
                    <span>${hasSub ? '已检测到副 API 配置，可以直接用。' : '副 API 需要先在设置里保存一套配置。'}</span>
                    <button type="button" class="nt-guide-link" id="nt-guide-open-api">去 API 配置 →</button>
                </div>
            `;
        },
        after: () => {
            const btn = document.getElementById('nt-guide-open-api');
            if (btn) btn.onclick = () => {
                closeGuide(true);
                window.dispatchEvent(new CustomEvent('nekotool:open-api-settings'));
            };
        },
    },
    {
        code: '03',
        title: '面板位置',
        subtitle: '常用功能在哪个页签',
        body: () => `
            <div class="nt-guide-map">
                <div class="nt-guide-map-row"><span class="nt-guide-code">01</span><b>概览</b><span>模块开关、总结开关、运行限制</span></div>
                <div class="nt-guide-map-row"><span class="nt-guide-code">02</span><b>世界模拟</b><span>状态栏、角色/世界/地图/支线/总结、自定义提示词</span></div>
                <div class="nt-guide-map-row"><span class="nt-guide-code">03</span><b>世界书</b><span>世界书管理、条目管理、多选删除/转发</span></div>
                <div class="nt-guide-map-row"><span class="nt-guide-code">04</span><b>文本</b><span>楼层收藏、纯 TXT 导出、八股清理</span></div>
                <div class="nt-guide-map-row"><span class="nt-guide-code">05</span><b>设置</b><span>API 配置、数据导入导出、诊断</span></div>
            </div>
            <div class="nt-guide-callout">
                <span>TOOL 菜单在聊天输入栏旁边，拖到边缘可以半隐藏。</span>
            </div>
        `,
    },
    {
        code: '04',
        title: '开始使用',
        subtitle: '不会自动扣 API，也不会自动初始化',
        body: () => {
            const hasSub = hasSecondaryApi();
            return `
                <p class="nt-guide-lead">引导不会自动初始化世界书，也不会自动发请求。先自己玩也可以，需要时再点「请求更新」。</p>
                ${hasSub ? `
                <div class="nt-guide-choice-box">
                    <b>之后手动请求更新默认用：</b>
                    <div class="nt-guide-options compact">
                        <label class="nt-guide-option">
                            <input type="radio" name="nt-guide-update-api" value="main" checked>
                            <span class="nt-guide-radio"></span><span><b>主 API</b><small>酒馆当前 API</small></span>
                        </label>
                        <label class="nt-guide-option">
                            <input type="radio" name="nt-guide-update-api" value="secondary">
                            <span class="nt-guide-radio"></span><span><b>副 API</b><small>设置里保存的副 API</small></span>
                        </label>
                    </div>
                </div>` : '<div class="nt-guide-callout"><span>还没有副 API，请求更新默认使用主 API。</span></div>'}
                <p class="nt-guide-dim">随时可以在 01 概览点「新手引导」重新打开。</p>
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
    const total = STEPS.length;
    const segments = STEPS.map((_, i) => `<span class="nt-guide-seg${i <= currentStep ? ' on' : ''}"></span>`).join('');
    mask.innerHTML = `
        <div class="nt-guide-card">
            <div class="nt-guide-scan"></div>
            <div class="nt-guide-head">
                <div class="nt-guide-brand"><b>NEKOTOOL</b><span>// ONBOARDING</span></div>
                <div class="nt-guide-counter">${step.code}<span>/ ${String(total).padStart(2, '0')}</span></div>
                <button type="button" class="nt-guide-x" title="关闭">×</button>
            </div>
            <div class="nt-guide-progress">${segments}</div>
            <div class="nt-guide-step-head">
                <span class="nt-guide-step-code">${step.code}</span>
                <div><h2>${step.title}</h2>${step.subtitle ? `<p>${step.subtitle}</p>` : ''}</div>
            </div>
            <div class="nt-guide-body">${step.body()}</div>
            <div class="nt-guide-foot">
                <button type="button" class="nt-guide-btn ghost" id="nt-guide-skip">跳过引导</button>
                <span class="nt-guide-spacer"></span>
                ${currentStep > 0 ? '<button type="button" class="nt-guide-btn" id="nt-guide-prev">上一步</button>' : ''}
                <button type="button" class="nt-guide-btn primary" id="nt-guide-next">${currentStep === total - 1 ? '完成' : '下一步 →'}</button>
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
        if (panel.getBoundingClientRect().height < 20) return;
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
