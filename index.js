import { installFetchHook } from './core/hooks.js';
import { settings } from './core/settings.js';
import { registry } from './core/registry.js';
import { mountPanel } from './core/panel.js';
import { mountQuickMenu } from './core/quickmenu.js';

import './modules/rewriter.js';
import './modules/worldsim.js';
import './modules/textmanager.js';

let booted = false;

function boot() {
    // 三个入口（DOMContentLoaded / jQuery ready / 兜底）会重复触发，
    // 不挡一下就会把模块 init 跑两遍、监听器注册两份。
    if (booted) return;
    booted = true;

    console.log('[nekotools] 正在启动... build 2026-11-18A / v1.9.3');
    settings.load();

    for (const mod of registry.list()) {
        const s = settings.get(mod.id);
        if (typeof s.enabled === 'boolean') mod.enabled = s.enabled;
        if (typeof mod.init === 'function') {
            try { mod.init(); } catch (e) { console.error(`[nekotools:init:${mod.id}]`, e); }
        }
    }

    installFetchHook(true);

    // ⭐ 延迟挂载面板，确保酒馆 DOM 完全加载
    setTimeout(() => {
        console.log('[nekotools] 挂载面板...');
        mountPanel();
    }, 1500);

    // ⭐ 输入栏快捷入口（和面板独立，失败了不影响面板）
    setTimeout(() => {
        try { mountQuickMenu(); } catch (e) { console.error('[nekotools:quickmenu]', e); }
    }, 1200);
}

// ⭐ 多重触发机制，确保面板一定能加载
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}

// 酒馆特定的加载事件
$(document).ready(() => {
    setTimeout(boot, 500);
});

// 兜底：5秒后强制尝试挂载
setTimeout(() => {
    if (!document.getElementById('nt-ws-panel')) {
        console.warn('[nekotools] 面板未找到，强制重新挂载');
        mountPanel();
    }
}, 5000);
