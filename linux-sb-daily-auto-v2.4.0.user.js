// ==UserScript==
// @license      GPL-3.0
// @name         LINUX.SB 每日自动（签到 + 称号 + 广告 + 积分 v2.4.0）
// @namespace    https://linux.sb/
// @source       https://github.com/xucux/tampermonkey-script
// @version      2.4.0
// @description  linux.sb 每日自动签到、免费抽取称号一次、点击 3 次带星广告、领取积分（玻璃拟态可视化面板）
// @author       Grok
// @match        https://linux.sb/*
// @match        https://www.linux.sb/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    if (window.top !== window.self) return;
    if (/\/(login|register|password_recovery)/.test(location.pathname)) return;

    const TAG = '[LINUX.SB 自动]';
    const VERSION = '2.4.0';
    const CONFIG = {
        AD_DAILY_LIMIT: 3,          // 每天点击带星（红点）广告的次数
        AD_WAIT_MS: 12000,          // 等待侧边栏广告卡注入的最长时间
        AD_CONFIRM_MS: 4000,        // 点击后等待站点确认（红点标记完成）的最长时间
        DEBUG: false,               // 改成 true 会打印广告卡完整 HTML
        AUTO_RUN_TIME: '00:05',     // 每天定时自动执行的时间（页面需保持打开）
        AUTO_RUN_INTERVAL_MS: 30 * 60 * 1000 // 两次自动重试的最小间隔（全天重试，直到任务完成）
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /* ---------------- 本地状态：按自然日重置 ---------------- */

    function todayKey() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const store = {
        get(key, fallback) {
            try {
                const value = GM_getValue(key, null);
                if (value !== null && value !== undefined) return value;
            } catch (_) {}
            try {
                const raw = localStorage.getItem(key);
                return raw ? JSON.parse(raw) : fallback;
            } catch (_) {
                return fallback;
            }
        },
        set(key, value) {
            try {
                GM_setValue(key, value);
                return;
            } catch (_) {}
            try {
                localStorage.setItem(key, JSON.stringify(value));
            } catch (_) {}
        }
    };

    const STATE_KEY = 'sb_daily_auto_v2';
    const LOGIC_VERSION = 4;

    function freshState() {
        return {
            date: todayKey(), logicVersion: LOGIC_VERSION,
            checkin: false, gacha: false, adClicks: 0, points: false, adReward: 0
        };
    }

    let state = store.get(STATE_KEY, null);
    if (!state || typeof state !== 'object' || state.date !== todayKey()) {
        state = freshState();
    }
    // 兼容 2.0.x 的 ads 数组
    if (typeof state.adClicks !== 'number') {
        state.adClicks = Array.isArray(state.ads) ? state.ads.length : 0;
    }
    delete state.ads;
    if (typeof state.adReward !== 'number') state.adReward = 0;

    // 旧版把普通横幅也算进广告次数，升级后清空广告计数，其它进度保留
    if (state.logicVersion !== LOGIC_VERSION) {
        state.adClicks = 0;
        state.adReward = 0;
        state.logicVersion = LOGIC_VERSION;
        store.set(STATE_KEY, state);
    }

    const saveState = () => {
        store.set(STATE_KEY, state);
        render();
    };

    let autoEnabled = store.get('sb_auto_run_enabled', true);
    const AUTO_STATE_KEY = 'sb_auto_run_state';
    let autoState = store.get(AUTO_STATE_KEY, null);
    if (!autoState || typeof autoState !== 'object' || autoState.date !== todayKey()) {
        autoState = { date: todayKey(), tries: 0, lastTry: 0 };
    }

    let didSomething = false;

    // 记录当前页面渲染的日期。站点广告表单里的 reward_day、红点状态都来自页面渲染那一刻，
    // 页面跨天后必须先刷新，否则 0 点后的点击会记到昨天。
    const pageDay = todayKey();
    const RELOAD_KEY = 'sb_reload_for_day';

    /* ---------------- 可视化面板 ---------------- */

    const PANEL_POS_KEY = 'sb_panel_pos';
    const PANEL_THEME_KEY = 'sb_panel_theme';
    const CELEBRATE_KEY = 'sb_celebrate_date';
    const CONFETTI_COLORS = ['#3ddc97', '#fbbf24', '#60a5fa', '#f472b6', '#a78bfa', '#fb923c'];

    const statusNodes = {};
    const panelEls = {};
    let panelCard = null;
    let panelLogs = null;
    let panelRunBtn = null;
    let panelAdsBtn = null;
    let panelRunLabel = null;
    let pillSub = null;
    let ringMain = null;
    let ringMini = null;
    let adsSegs = [];
    let actionButtons = [];

    function panelLog(text) {
        if (!panelLogs) return;
        const line = document.createElement('div');
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        line.textContent = `${time} ${text}`;
        panelLogs.appendChild(line);
        while (panelLogs.children.length > 30) panelLogs.removeChild(panelLogs.firstChild);
        panelLogs.scrollTop = panelLogs.scrollHeight;
    }

    function log(...args) {
        console.log(TAG, ...args);
        panelLog(args.map((x) => {
            if (typeof x === 'string') return x;
            try { return JSON.stringify(x); } catch (_) { return String(x); }
        }).join(' '));
    }

    function warn(...args) {
        console.warn(TAG, ...args);
        panelLog('⚠ ' + args.map((x) => (typeof x === 'string' ? x : String(x))).join(' '));
    }

    function overallDoneCount() {
        return Number(Boolean(state.checkin)) + Number(Boolean(state.gacha)) +
            Number(Boolean(state.points)) + Number(state.adClicks >= CONFIG.AD_DAILY_LIMIT);
    }

    function overallProgress() {
        const limit = CONFIG.AD_DAILY_LIMIT;
        const ads = Math.min(state.adClicks, limit) / limit;
        return (Number(Boolean(state.checkin)) + Number(Boolean(state.gacha)) +
            Number(Boolean(state.points)) + ads) / 4;
    }

    function panelDateLabel() {
        const d = new Date();
        const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
        return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${week}`;
    }

    function setRingProgress(circle, progress) {
        if (!circle) return;
        const r = Number(circle.getAttribute('r')) || 17;
        const c = 2 * Math.PI * r;
        const ratio = Math.min(1, Math.max(0, progress));
        circle.style.strokeDasharray = `${c} ${c}`;
        circle.style.strokeDashoffset = String(c * (1 - ratio));
    }

    function celebrate() {
        if (!panelCard) return;
        const layer = panelCard.querySelector('.confetti-layer');
        if (!layer) return;

        panelCard.classList.add('celebrate');
        for (let i = 0; i < 22; i += 1) {
            const bit = document.createElement('i');
            bit.style.left = `${4 + Math.random() * 92}%`;
            bit.style.width = `${4 + Math.random() * 4}px`;
            bit.style.height = `${6 + Math.random() * 6}px`;
            bit.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
            bit.style.animationDelay = `${(Math.random() * 0.4).toFixed(2)}s`;
            bit.style.animationDuration = `${(1.5 + Math.random() * 0.8).toFixed(2)}s`;
            layer.appendChild(bit);
        }
        setTimeout(() => layer.replaceChildren(), 2800);
        setTimeout(() => panelCard.classList.remove('celebrate'), 2300);
    }

    function render() {
        const limit = CONFIG.AD_DAILY_LIMIT;
        const adsCount = Math.min(state.adClicks, limit);
        const progress = overallProgress();
        const done = overallDoneCount();

        const set = (key, text, ok) => {
            const el = statusNodes[key];
            if (!el) return;
            el.textContent = text;
            const row = el.closest ? el.closest('.task') : null;
            if (row) row.classList.toggle('done', Boolean(ok));
        };
        set('checkin', state.checkin ? '已完成' : '待执行', state.checkin);
        set('gacha', state.gacha ? '已完成' : '待执行', state.gacha);
        set('ads', `${adsCount} / ${limit}`, adsCount >= limit);
        set('points', state.points ? '已领取' : (state.adReward > 0 ? `奖励 ${state.adReward} 次` : '待执行'),
            state.points || state.adReward > 0);

        if (panelEls.adsRow) {
            panelEls.adsRow.classList.toggle('partial', adsCount > 0 && adsCount < limit);
        }
        adsSegs.forEach((seg, i) => seg.classList.toggle('on', i < adsCount));

        setRingProgress(ringMain, progress);
        setRingProgress(ringMini, progress);

        if (panelEls.done) panelEls.done.textContent = String(done);
        if (panelEls.pct) panelEls.pct.textContent = `${Math.round(progress * 100)}%`;
        if (panelEls.miniPct) panelEls.miniPct.textContent = `${Math.round(progress * 100)}%`;
        if (panelEls.hint) {
            panelEls.hint.textContent = progress >= 1 ? '全部完成' : (done > 0 ? '进行中' : '等待执行');
            panelEls.hint.classList.toggle('done', progress >= 1);
        }
        const isRunning = panelCard && panelCard.classList.contains('running');
        if (pillSub) {
            pillSub.textContent = progress >= 1
                ? '今日全部完成'
                : (isRunning ? '执行中…' : `${done} / 4 已完成`);
        }
        if (panelCard) panelCard.classList.toggle('all-done', progress >= 1);

        if (progress >= 1 && store.get(CELEBRATE_KEY, '') !== todayKey()) {
            store.set(CELEBRATE_KEY, todayKey());
            celebrate();
        }
    }

    function setRunning(value) {
        if (panelCard) panelCard.classList.toggle('running', value);
        if (panelRunLabel) panelRunLabel.textContent = value ? '执行中…' : '立即执行';
        if (pillSub && value) pillSub.textContent = '执行中…';
        actionButtons.forEach((btn) => {
            btn.disabled = value;
        });
    }

    function mountPanel() {
        const host = document.createElement('div');
        host.id = 'sb-daily-auto-panel';
        host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });

        shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap {
    --bg: rgba(255, 255, 255, .8);
    --panel: rgba(255, 255, 255, .55);
    --panel-2: rgba(243, 250, 246, .9);
    --text: #17231d;
    --muted: #5f7168;
    --line: rgba(18, 63, 45, .1);
    --line-strong: rgba(18, 63, 45, .16);
    --hover: rgba(16, 122, 87, .07);
    --ok: #0f9d6c;
    --ok-bg: rgba(16, 185, 129, .14);
    --warn: #b45309;
    --warn-bg: rgba(245, 158, 11, .16);
    --gold: #ea9a0b;
    --accent-1: #3ddc97;
    --accent-2: #079769;
    --glow: rgba(16, 185, 129, .32);
    --border: rgba(255, 255, 255, .7);
    --log-bg: rgba(15, 46, 36, .045);
    --chip-bg: rgba(255, 255, 255, .5);
    --shadow: 0 18px 40px -18px rgba(6, 60, 43, .45), 0 0 0 1px rgba(16, 24, 40, .04),
      0 2px 10px rgba(15, 23, 42, .05), inset 0 1px 0 rgba(255, 255, 255, .8);
    position: relative;
    font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
    color: var(--text);
    -webkit-font-smoothing: antialiased;
  }
  .wrap[data-theme="dark"] {
    --bg: rgba(15, 24, 21, .76);
    --panel: rgba(255, 255, 255, .05);
    --panel-2: rgba(255, 255, 255, .06);
    --text: #e9f5ef;
    --muted: #8fa79b;
    --line: rgba(255, 255, 255, .08);
    --line-strong: rgba(255, 255, 255, .15);
    --hover: rgba(52, 211, 153, .1);
    --ok: #4ade9c;
    --ok-bg: rgba(52, 211, 153, .16);
    --warn: #fbbf24;
    --warn-bg: rgba(251, 191, 36, .14);
    --gold: #fbbf24;
    --border: rgba(255, 255, 255, .1);
    --log-bg: rgba(0, 0, 0, .24);
    --chip-bg: rgba(255, 255, 255, .04);
    --shadow: 0 22px 48px -20px rgba(0, 0, 0, .85), 0 0 0 1px rgba(0, 0, 0, .35),
      0 2px 10px rgba(0, 0, 0, .35), inset 0 1px 0 rgba(255, 255, 255, .06);
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 296px;
    max-height: calc(100vh - 24px);
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--bg);
    -webkit-backdrop-filter: blur(20px) saturate(165%);
    backdrop-filter: blur(20px) saturate(165%);
    box-shadow: var(--shadow);
    transform-origin: 100% 100%;
    animation: sb-pop .26s cubic-bezier(.2, 1.2, .4, 1);
  }
  .card::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(420px 140px at 92% -10%, var(--glow), transparent 70%);
    opacity: .5;
    pointer-events: none;
  }
  .head {
    position: relative;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 12px 9px;
    cursor: grab;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  .head:active { cursor: grabbing; }
  .logo {
    width: 30px;
    height: 30px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 10px;
    color: #fff;
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    box-shadow: 0 8px 16px -8px var(--glow), inset 0 1px 0 rgba(255, 255, 255, .4);
  }
  .logo svg { width: 15px; height: 15px; }
  .titles { flex: 1; min-width: 0; }
  .titles strong {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    font-weight: 650;
    letter-spacing: .2px;
    white-space: nowrap;
  }
  .ver {
    padding: 1px 5px;
    border: 1px solid var(--line-strong);
    border-radius: 99px;
    background: var(--panel);
    color: var(--muted);
    font-size: 9px;
    font-weight: 600;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    color: var(--muted);
    font-size: 10px;
  }
  .live {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #22c55e;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, .14);
    animation: sb-pulse 2.2s ease-in-out infinite;
  }
  .live.off { background: #94a3b8; box-shadow: none; animation: none; }
  .card.running .live { background: #f59e0b; box-shadow: 0 0 0 3px rgba(245, 158, 11, .16); }
  .head-actions { display: flex; gap: 2px; }
  .icon-btn {
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: background .18s, color .18s, transform .18s;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); transform: translateY(-1px); }
  .icon-btn svg { width: 14px; height: 14px; }
  .theme-btn .moon, .theme-btn .sun { display: none; }
  .wrap[data-theme="light"] .theme-btn .moon { display: block; }
  .wrap[data-theme="dark"] .theme-btn .sun { display: block; }
  .body {
    position: relative;
    z-index: 1;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 2px 12px 12px;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--line-strong) transparent;
  }
  .body::-webkit-scrollbar { width: 5px; }
  .body::-webkit-scrollbar-thumb { border-radius: 99px; background: var(--line-strong); }
  .overview {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    overflow: hidden;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 13px;
    background: linear-gradient(135deg, var(--panel-2), var(--panel));
  }
  .overview::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(115deg, transparent 35%, rgba(255, 255, 255, .35) 48%, transparent 60%);
    opacity: 0;
    transform: translateX(-130%);
  }
  .card.running .overview::after { opacity: 1; animation: sb-sweep 2.2s ease-in-out infinite; }
  .ov-cap {
    display: flex;
    align-items: baseline;
    gap: 6px;
    color: var(--muted);
    font-size: 10px;
    letter-spacing: .6px;
  }
  .ov-date { color: var(--muted); font-size: 9.5px; letter-spacing: 0; opacity: .8; }
  .ov-num { display: flex; align-items: baseline; gap: 2px; margin-top: 1px; }
  .ov-num strong {
    background: linear-gradient(120deg, var(--accent-2), var(--accent-1));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -.5px;
    line-height: 1.1;
  }
  .card.all-done .ov-num strong {
    background-image: linear-gradient(120deg, #f59e0b, #f97316);
  }
  .ov-num span { color: var(--muted); font-size: 10px; }
  .ov-hint { display: inline-block; margin-top: 2px; color: var(--muted); font-size: 10px; }
  .ov-hint.done { color: var(--gold); font-weight: 600; }
  .ring-wrap { position: relative; width: 46px; height: 46px; margin-left: auto; flex: none; }
  .ring-wrap svg { width: 46px; height: 46px; transform: rotate(-90deg); }
  .ring-bg { fill: none; stroke: var(--line-strong); stroke-width: 3.4; }
  .ring-fg {
    fill: none;
    stroke-width: 3.4;
    stroke-linecap: round;
    transition: stroke-dashoffset .6s cubic-bezier(.22, 1, .36, 1);
  }
  .pct {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: -.2px;
  }
  .card.all-done .pct { color: var(--gold); }
  .tasks { display: grid; gap: 1px; margin-top: 6px; }
  .task {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 4px;
    border-radius: 10px;
    transition: background .18s;
    animation: sb-rise .3s ease both;
  }
  .task:nth-child(2) { animation-delay: .03s; }
  .task:nth-child(3) { animation-delay: .06s; }
  .task:nth-child(4) { animation-delay: .09s; }
  .task:hover { background: var(--hover); }
  .ico {
    width: 26px;
    height: 26px;
    flex: none;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-2);
    color: var(--muted);
    transition: color .25s, background .25s, border-color .25s;
  }
  .ico svg { width: 14px; height: 14px; }
  .task.done .ico { border-color: transparent; background: var(--ok-bg); color: var(--ok); }
  .task .name {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 550;
    letter-spacing: .1px;
  }
  .pill {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 3px 8px;
    border: 1px solid var(--line);
    border-radius: 99px;
    background: var(--panel-2);
    color: var(--muted);
    font-size: 10px;
    font-weight: 600;
    transition: color .25s, background .25s, border-color .25s;
  }
  .pill b { font-size: 10px; font-weight: 600; }
  .pill .tick { width: 9px; height: 9px; display: none; }
  .task.done .pill { border-color: transparent; background: var(--ok-bg); color: var(--ok); }
  .task.done .pill .tick { display: block; }
  .task.partial .pill { border-color: transparent; background: var(--warn-bg); color: var(--warn); }
  .adbar {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    margin: 2px 4px 4px 39px;
  }
  .adbar i {
    height: 3.5px;
    border-radius: 99px;
    background: var(--line-strong);
    transition: background .35s, box-shadow .35s;
  }
  .adbar i.on {
    background: linear-gradient(90deg, var(--accent-1), var(--accent-2));
    box-shadow: 0 0 6px var(--glow);
  }
  .auto {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel);
  }
  .auto .txt { flex: 1; min-width: 0; }
  .auto .txt b { display: block; font-size: 11px; font-weight: 600; }
  .auto .txt small { display: block; margin-top: 1px; color: var(--muted); font-size: 9.5px; }
  .switch { position: relative; width: 32px; height: 18px; flex: none; cursor: pointer; }
  .switch input {
    position: absolute;
    z-index: 1;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .switch .track {
    position: absolute;
    inset: 0;
    border-radius: 99px;
    background: var(--line-strong);
    transition: background .22s;
  }
  .switch .track::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, .3);
    transition: transform .22s cubic-bezier(.2, 1.4, .4, 1);
  }
  .switch input:checked + .track {
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
  }
  .switch input:checked + .track::after { transform: translateX(14px); }
  .actions { display: grid; gap: 6px; margin-top: 8px; }
  .primary {
    position: relative;
    height: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 0;
    border-radius: 11px;
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    box-shadow: 0 10px 20px -10px var(--glow), inset 0 1px 0 rgba(255, 255, 255, .35);
    color: #fff;
    font-family: inherit;
    font-size: 12px;
    font-weight: 650;
    letter-spacing: .4px;
    cursor: pointer;
    transition: transform .18s, box-shadow .18s, filter .18s;
  }
  .primary:hover {
    filter: saturate(1.12);
    transform: translateY(-1px);
    box-shadow: 0 14px 24px -10px var(--glow), inset 0 1px 0 rgba(255, 255, 255, .35);
  }
  .primary:active { transform: translateY(0) scale(.99); }
  .primary:disabled { opacity: .65; cursor: wait; transform: none; }
  .primary svg { width: 13px; height: 13px; }
  .primary .spinner {
    display: none;
    width: 12px;
    height: 12px;
    border: 1.8px solid rgba(255, 255, 255, .4);
    border-top-color: #fff;
    border-radius: 50%;
    animation: sb-spin .75s linear infinite;
  }
  .card.running .primary .play { display: none; }
  .card.running .primary .spinner { display: block; }
  .acts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .chip {
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border: 1px solid var(--line-strong);
    border-radius: 9px;
    background: var(--chip-bg);
    color: var(--muted);
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: color .18s, background .18s, border-color .18s, transform .18s;
  }
  .chip svg { width: 12px; height: 12px; opacity: .75; }
  .chip:hover {
    border-color: transparent;
    background: var(--hover);
    color: var(--text);
    transform: translateY(-1px);
  }
  .chip:disabled { opacity: .45; cursor: default; transform: none; }
  .logs-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 10px;
    padding: 0 2px 5px;
  }
  .logs-head span { color: var(--muted); font-size: 9.5px; letter-spacing: .8px; }
  .logs-head button {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--muted);
    font-family: inherit;
    font-size: 9.5px;
    cursor: pointer;
    opacity: .75;
  }
  .logs-head button:hover { color: var(--text); opacity: 1; }
  .logs {
    max-height: 92px;
    overflow-y: auto;
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--log-bg);
    color: var(--muted);
    font: 10px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    scrollbar-width: thin;
    scrollbar-color: var(--line-strong) transparent;
  }
  .logs::-webkit-scrollbar { width: 4px; }
  .logs::-webkit-scrollbar-thumb { border-radius: 99px; background: var(--line-strong); }
  .logs:empty::before { content: "暂无日志"; opacity: .55; }
  .logs div { white-space: pre-wrap; word-break: break-all; animation: sb-rise .18s ease both; }
  .logs div:last-child { color: var(--text); }
  .pill-btn {
    display: none;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 6px;
    border: 1px solid var(--border);
    border-radius: 99px;
    background: var(--bg);
    -webkit-backdrop-filter: blur(18px) saturate(160%);
    backdrop-filter: blur(18px) saturate(160%);
    box-shadow: var(--shadow);
    color: var(--text);
    font-family: inherit;
    cursor: pointer;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
    animation: sb-pop .24s cubic-bezier(.2, 1.2, .4, 1);
    transition: transform .18s;
  }
  .pill-btn:hover { transform: translateY(-1px); }
  .wrap.collapsed .card { display: none; }
  .wrap.collapsed .pill-btn { display: flex; }
  .mini-ring { position: relative; width: 30px; height: 30px; flex: none; }
  .mini-ring svg { width: 30px; height: 30px; transform: rotate(-90deg); }
  .mini-bg { fill: none; stroke: var(--line-strong); stroke-width: 3; }
  .mini-fg { fill: none; stroke-width: 3; stroke-linecap: round; transition: stroke-dashoffset .6s cubic-bezier(.22, 1, .36, 1); }
  .mini-pct {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text);
    font-size: 7.5px;
    font-weight: 700;
  }
  .pill-copy { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; line-height: 1.2; }
  .pill-copy b { font-size: 10.5px; font-weight: 650; }
  .pill-copy span { color: var(--muted); font-size: 9px; }
  .confetti-layer { position: absolute; inset: 0; z-index: 5; overflow: hidden; pointer-events: none; }
  .confetti-layer i {
    position: absolute;
    top: -12px;
    border-radius: 2px;
    opacity: 0;
    animation: sb-fall 1.8s ease-in forwards;
  }
  .card.celebrate { animation: sb-glow 2s ease; }
  @keyframes sb-pop {
    from { opacity: 0; transform: scale(.94) translateY(6px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes sb-rise {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: none; }
  }
  @keyframes sb-spin { to { transform: rotate(360deg); } }
  @keyframes sb-pulse {
    0%, 100% { box-shadow: 0 0 0 3px rgba(34, 197, 94, .14); }
    50% { box-shadow: 0 0 0 5px rgba(34, 197, 94, .05); }
  }
  @keyframes sb-sweep {
    0% { transform: translateX(-130%); }
    55%, 100% { transform: translateX(130%); }
  }
  @keyframes sb-fall {
    0% { opacity: 1; transform: translateY(0) rotate(0); }
    100% { opacity: 0; transform: translateY(340px) rotate(540deg); }
  }
  @keyframes sb-glow {
    0%, 100% { box-shadow: var(--shadow); }
    40% { box-shadow: 0 0 0 2px rgba(245, 158, 11, .45), var(--shadow); }
  }
  @media (max-width: 480px) {
    .card { width: 272px; }
    .ver { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: .001s !important; transition-duration: .001s !important; }
  }
</style>
<div class="wrap" data-theme="light">
  <div class="card">
    <div class="head" data-drag>
      <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg></span>
      <div class="titles">
        <strong>LINUX.SB 每日任务<span class="ver">v${VERSION}</span></strong>
        <span class="sub"><i class="live" data-live></i><span data-sub>每日 ${CONFIG.AUTO_RUN_TIME} 自动运行</span></span>
      </div>
      <div class="head-actions">
        <button class="icon-btn theme-btn" data-theme-btn title="切换深浅色">
          <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>
          <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button class="icon-btn" data-collapse title="收起面板">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      </div>
    </div>
    <div class="body">
      <div class="overview">
        <div>
          <span class="ov-cap">今日进度 <span class="ov-date" data-date></span></span>
          <div class="ov-num"><strong data-done>0</strong><span>/ 4</span></div>
          <span class="ov-hint" data-hint>等待执行</span>
        </div>
        <div class="ring-wrap">
          <svg viewBox="0 0 46 46" aria-hidden="true">
            <defs>
              <linearGradient id="sb-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#3ddc97"/>
                <stop offset="100%" stop-color="#079769"/>
              </linearGradient>
            </defs>
            <circle class="ring-bg" cx="23" cy="23" r="17.5"/>
            <circle class="ring-fg" cx="23" cy="23" r="17.5" stroke="url(#sb-ring-grad)" data-ring-main/>
          </svg>
          <span class="pct" data-pct>0%</span>
        </div>
      </div>
      <div class="tasks">
        <div class="task" data-task="checkin">
          <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 10.5h17"/><path d="M9 15l2 2 3.5-3.5"/></svg></span>
          <span class="name">每日签到</span>
          <span class="pill"><svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><b data-k="checkin">待执行</b></span>
        </div>
        <div class="task" data-task="gacha">
          <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9L12 3.5z"/></svg></span>
          <span class="name">称号免费抽</span>
          <span class="pill"><svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><b data-k="gacha">待执行</b></span>
        </div>
        <div class="task" data-task="ads">
          <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8 8 0 0 1 0 12"/></svg></span>
          <span class="name">带星广告</span>
          <span class="pill"><svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><b data-k="ads">0 / ${CONFIG.AD_DAILY_LIMIT}</b></span>
        </div>
        <div class="task" data-task="points">
          <span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/><path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/></svg></span>
          <span class="name">领取积分</span>
          <span class="pill"><svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg><b data-k="points">待执行</b></span>
        </div>
      </div>
      <div class="adbar">${'<i></i>'.repeat(CONFIG.AD_DAILY_LIMIT)}</div>
      <div class="auto">
        <div class="txt"><b>定时自动</b><small>每天 <span data-auto-time>${CONFIG.AUTO_RUN_TIME}</span> 执行 · 页面需保持打开</small></div>
        <label class="switch"><input type="checkbox" data-auto><span class="track"></span></label>
      </div>
      <div class="actions">
        <button class="primary" data-act="run">
          <svg class="play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5-11-6.5z"/></svg>
          <span class="spinner"></span>
          <span data-run-label>立即执行</span>
        </button>
        <div class="acts">
          <button class="chip" data-act="ads"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/><path d="M18.5 15l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1z"/></svg>继续广告</button>
          <button class="chip" data-act="showAds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>显示广告</button>
          <button class="chip" data-act="resetAds"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/></svg>重置广告</button>
          <button class="chip" data-act="reset"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v6M14 11v6"/></svg>重置今日</button>
        </div>
      </div>
      <div class="logs-head"><span>运行日志</span><button data-act="clearLog">清空</button></div>
      <div class="logs"></div>
    </div>
    <div class="confetti-layer"></div>
  </div>
  <button class="pill-btn" data-pill title="展开面板">
    <span class="mini-ring">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="sb-pill-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#3ddc97"/>
            <stop offset="100%" stop-color="#079769"/>
          </linearGradient>
        </defs>
        <circle class="mini-bg" cx="16" cy="16" r="12.5"/>
        <circle class="mini-fg" cx="16" cy="16" r="12.5" stroke="url(#sb-pill-grad)" data-ring-mini/>
      </svg>
      <span class="mini-pct" data-pill-pct>0%</span>
    </span>
    <span class="pill-copy"><b>LINUX.SB 每日</b><span data-pill-sub>0 / 4 已完成</span></span>
  </button>
</div>`;

        document.body.appendChild(host);

        const wrap = shadow.querySelector('.wrap');
        panelCard = shadow.querySelector('.card');
        panelLogs = shadow.querySelector('.logs');

        panelEls.done = shadow.querySelector('[data-done]');
        panelEls.pct = shadow.querySelector('[data-pct]');
        panelEls.miniPct = shadow.querySelector('[data-pill-pct]');
        panelEls.hint = shadow.querySelector('[data-hint]');
        panelEls.sub = shadow.querySelector('[data-sub]');
        panelEls.live = shadow.querySelector('[data-live]');
        panelEls.adsRow = shadow.querySelector('[data-task="ads"]');
        ringMain = shadow.querySelector('[data-ring-main]');
        ringMini = shadow.querySelector('[data-ring-mini]');
        pillSub = shadow.querySelector('[data-pill-sub]');
        panelRunLabel = shadow.querySelector('[data-run-label]');
        adsSegs = Array.from(shadow.querySelectorAll('.adbar i'));

        shadow.querySelector('[data-date]').textContent = panelDateLabel();

        // ---- 深浅色主题 ----
        const savedTheme = store.get(PANEL_THEME_KEY, '');
        let theme = savedTheme === 'dark' || savedTheme === 'light'
            ? savedTheme
            : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        wrap.dataset.theme = theme;
        shadow.querySelector('[data-theme-btn]').addEventListener('click', () => {
            theme = wrap.dataset.theme === 'dark' ? 'light' : 'dark';
            wrap.dataset.theme = theme;
            store.set(PANEL_THEME_KEY, theme);
        });

        // ---- 拖拽与位置记忆 ----
        const clampPos = (left, top) => {
            const rect = host.getBoundingClientRect();
            const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
            const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
            return {
                left: Math.min(Math.max(8, left), maxLeft),
                top: Math.min(Math.max(8, top), maxTop)
            };
        };
        const applyHostPos = (pos) => {
            host.style.left = `${Math.round(pos.left)}px`;
            host.style.top = `${Math.round(pos.top)}px`;
            host.style.right = 'auto';
            host.style.bottom = 'auto';
        };
        const reclampHost = () => {
            if (!host.style.left || host.style.left === 'auto') return;
            const rect = host.getBoundingClientRect();
            applyHostPos(clampPos(rect.left, rect.top));
        };
        const makeDraggable = (handle, onTap) => {
            handle.addEventListener('pointerdown', (down) => {
                if (down.pointerType === 'mouse' && down.button !== 0) return;
                if (!onTap && down.target.closest && down.target.closest('button, input, label, select, a')) return;

                const rect = host.getBoundingClientRect();
                const offsetX = down.clientX - rect.left;
                const offsetY = down.clientY - rect.top;
                let moved = false;

                const onMove = (move) => {
                    if (!moved) {
                        if (Math.hypot(move.clientX - down.clientX, move.clientY - down.clientY) < 4) return;
                        moved = true;
                        host.classList.add('dragging');
                    }
                    applyHostPos(clampPos(move.clientX - offsetX, move.clientY - offsetY));
                };
                const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                    window.removeEventListener('pointercancel', onUp);
                    host.classList.remove('dragging');
                    if (moved) {
                        const end = host.getBoundingClientRect();
                        store.set(PANEL_POS_KEY, { left: end.left, top: end.top });
                    } else if (typeof onTap === 'function') {
                        onTap();
                    }
                };

                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
                window.addEventListener('pointercancel', onUp);
            });
        };
        const setCollapsed = (collapsed) => {
            wrap.classList.toggle('collapsed', collapsed);
            store.set('sb_panel_collapsed', collapsed);
            requestAnimationFrame(reclampHost);
        };

        makeDraggable(shadow.querySelector('[data-drag]'));
        makeDraggable(shadow.querySelector('[data-pill]'), () => setCollapsed(false));
        shadow.querySelector('[data-collapse]').addEventListener('click', () => setCollapsed(true));
        if (store.get('sb_panel_collapsed', false)) wrap.classList.add('collapsed');

        const savedPos = store.get(PANEL_POS_KEY, null);
        if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.top)) {
            requestAnimationFrame(() => applyHostPos(clampPos(savedPos.left, savedPos.top)));
        }
        window.addEventListener('resize', reclampHost);

        // ---- 状态节点与定时开关 ----
        shadow.querySelectorAll('[data-k]').forEach((el) => {
            statusNodes[el.dataset.k] = el;
        });

        const autoInput = shadow.querySelector('[data-auto]');
        const autoTimeLabel = shadow.querySelector('[data-auto-time]');
        if (autoTimeLabel) autoTimeLabel.textContent = CONFIG.AUTO_RUN_TIME;

        const renderAutoHint = () => {
            if (!panelEls.sub || !panelEls.live) return;
            panelEls.sub.textContent = autoEnabled
                ? `每日 ${CONFIG.AUTO_RUN_TIME} 自动运行`
                : '定时自动已暂停';
            panelEls.live.classList.toggle('off', !autoEnabled);
        };

        if (autoInput) {
            autoInput.checked = autoEnabled;
            autoInput.addEventListener('change', () => {
                autoEnabled = autoInput.checked;
                store.set('sb_auto_run_enabled', autoEnabled);
                renderAutoHint();
                log(autoEnabled
                    ? `定时自动已开启：每天 ${CONFIG.AUTO_RUN_TIME}（页面需保持打开）`
                    : '定时自动已关闭');
            });
        }
        renderAutoHint();

        // ---- 操作按钮 ----
        panelRunBtn = shadow.querySelector('[data-act="run"]');
        panelAdsBtn = shadow.querySelector('[data-act="ads"]');
        const showAdsBtn = shadow.querySelector('[data-act="showAds"]');
        const resetAdsBtn = shadow.querySelector('[data-act="resetAds"]');
        const resetBtn = shadow.querySelector('[data-act="reset"]');
        const clearLogBtn = shadow.querySelector('[data-act="clearLog"]');
        actionButtons = Array.from(shadow.querySelectorAll('.actions [data-act]'));

        panelRunBtn.addEventListener('click', () => {
            if (running) return;
            runAll();
        });
        panelAdsBtn.addEventListener('click', () => {
            if (running) return;
            runAdsOnly();
        });
        showAdsBtn.addEventListener('click', async () => {
            if (running) return;
            running = true;
            setRunning(true);
            try {
                log('广告：手动显示广告');
                const ok = await clickShowAds();
                if (!ok) warn('广告：没有可展开的列表或未找到“显示广告”按钮');
            } catch (err) {
                warn('广告：显示广告出错', err);
            } finally {
                render();
                setRunning(false);
                running = false;
            }
        });
        resetAdsBtn.addEventListener('click', () => {
            if (running) return;
            resetAds();
            runAdsOnly();
        });
        resetBtn.addEventListener('click', () => {
            if (running) return;
            resetToday();
            runAll();
        });
        clearLogBtn.addEventListener('click', () => {
            if (panelLogs) panelLogs.replaceChildren();
        });

        render();
    }

    /* ---------------- 1. 每日签到 ---------------- */

    async function stepCheckin() {
        if (state.checkin) {
            log('签到：今日已完成，跳过');
            return;
        }

        const res = await fetch('/daily_checkin', {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        const html = await res.text();

        if (res.redirected && /\/login/.test(res.url)) {
            warn('签到：未登录，跳过');
            return;
        }
        if (/今天已签到|今日已签到|已签到/.test(html)) {
            state.checkin = true;
            saveState();
            log('签到：今日已签到');
            return;
        }

        const csrfMatch = html.match(/name=["']_csrf["']\s+value=["']([^"']+)["']/i) ||
                          html.match(/value=["']([^"']+)["']\s+name=["']_csrf["']/i);
        if (!csrfMatch) {
            warn('签到：未找到 CSRF，可能未登录');
            return;
        }

        const body = new FormData();
        body.append('_csrf', csrfMatch[1]);

        const postRes = await fetch('/daily_checkin', {
            method: 'POST',
            credentials: 'include',
            body,
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        const text = await postRes.text();

        if (postRes.ok) {
            state.checkin = true;
            saveState();
            didSomething = true;
            log('签到：成功');
        } else {
            warn('签到：失败', postRes.status, text.slice(0, 200));
        }
    }

    /* ---------------- 2. 称号：每天免费抽一次 ---------------- */

    async function stepGacha() {
        if (state.gacha) {
            log('称号：今日已抽取，跳过');
            return;
        }

        const res = await fetch('/gacha', {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store'
        });
        const html = await res.text();

        if (res.redirected && /\/login/.test(res.url)) {
            warn('称号：未登录，跳过');
            return;
        }

        const doc = new DOMParser().parseFromString(html, 'text/html');
        const form = doc.querySelector('form[action*="gacha_pull"]');
        if (!form) {
            warn('称号：未找到抽取表单（可能未登录或页面改版）');
            return;
        }

        // 只找 cost=0 的免费按钮，绝不花积分
        const freeBtn = form.querySelector('button.gacha-pull-btn[data-cost="0"], .gacha-pull-btn[data-cost="0"]') ||
            Array.from(form.querySelectorAll('button')).find((btn) => /免费/.test(btn.textContent || ''));
        if (!freeBtn) {
            state.gacha = true;
            saveState();
            log('称号：今日免费次数已用完');
            return;
        }

        const body = new FormData();
        form.querySelectorAll('input[name], select[name], textarea[name]').forEach((el) => {
            if (el.disabled) return;
            if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
            body.append(el.name, el.value);
        });
        if (freeBtn.name) body.append(freeBtn.name, freeBtn.value || '1');

        const action = form.getAttribute('action') || '/gacha_pull';
        const postRes = await fetch(action, {
            method: 'POST',
            credentials: 'include',
            body,
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        const text = await postRes.text();

        if (postRes.ok || postRes.redirected) {
            state.gacha = true;
            saveState();
            didSomething = true;
            log('称号：免费抽取成功', text.slice(0, 120));
        } else {
            warn('称号：抽取失败', postRes.status, text.slice(0, 200));
        }
    }

    /* ---------------- 3. 侧边栏广告：每天 3 次带星广告 ---------------- */

    const AD_CARD_SELECTOR =
        'aside.sidebar .sidebar-promotions-card, aside.sidebar [class*="sidebar-promotions"], ' +
        'aside.sidebar [class*="promotions-card"], .sidebar-promotions-card';

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    // 星标识别：文字符号、class、data 属性、内部图标
    function hasStar(el) {
        if (!el) return false;
        const text = el.textContent || '';
        if (/[★☆⭐✩✪✫✬✭✮✯✰]/.test(text)) return true;

        const cls = String(el.className || '');
        if (/(^|\s)(is-)?star(red)?(\s|$)/i.test(cls)) return true;
        if (/star-|-(star|starred)\b/i.test(cls)) return true;
        if (/lottery-dot|lottery/i.test(cls)) return true;

        if (el.matches('[data-star], [data-is-star], [data-starred], [title*="星"], [aria-label*="星"]')) return true;

        return Boolean(el.querySelector(
            '[class~="star"], [class*="is-star"], [class*="starred"], [class*="star-icon"], [class*="star-badge"]' +
            ', [class*="lottery-dot"], [class*="lottery"]' +
            ', [data-star], [data-starred], [title*="星"], [aria-label*="星"], img[src*="star" i], svg[class*="star" i]'
        ));
    }

    function adKey(el) {
        const href = el.getAttribute('href') || '';
        if (href) return href;
        return '#' + (el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    }

    // 站点用红点（.sidebar-promotions-lottery-dot）标记“有奖广告”，
    // 点完后会在同一个链接上写 data-sidebar-promotions-lottery-done="1"
    function lotteryInfo(el) {
        const link = el && el.matches
            ? (el.matches('a[data-sidebar-promotions-ad-link="1"]') ? el : el.closest('a[data-sidebar-promotions-ad-link="1"]'))
            : null;
        if (!link) return { lottery: false, done: false };
        const hasDot = Boolean(link.querySelector('.sidebar-promotions-lottery-dot, [class*="lottery-dot"]'));
        return {
            lottery: link.dataset.sidebarPromotionsLotterySlot === '1' || hasDot,
            done: link.dataset.sidebarPromotionsLotteryDone === '1'
        };
    }

    // 隐藏表单里的 reward_day 是站点渲染页面时认定的“今天”。
    // 它和本地日期不一致，说明页面（或站点日切时间）不同步，此时点击不会记到今天。
    function pageRewardDay() {
        const input = document.querySelector('[data-sidebar-promotions-click-form] input[name="reward_day"]');
        return input ? input.value : null;
    }

    function adPageIsFresh() {
        const rewardDay = pageRewardDay();
        return rewardDay ? rewardDay === todayKey() : pageDay === todayKey();
    }

    function adCards() {
        const cards = [];
        document.querySelectorAll(AD_CARD_SELECTOR).forEach((el) => {
            if (!isVisible(el)) return;
            if (cards.some((c) => c.contains(el))) return;
            for (let i = cards.length - 1; i >= 0; i -= 1) {
                if (el.contains(cards[i])) cards.splice(i, 1);
            }
            cards.push(el);
        });
        return cards;
    }

    function collectAdItems() {
        const map = new Map();
        for (const card of adCards()) {
            // 卡片标题里出现 ★ 才算整卡带星；lottery-dot 按单个广告位判断，避免误点普通广告
            const starredCard = /[★☆⭐✩✪✫✬✭✮✯✰]/.test(card.textContent || '');
            let nodes = Array.from(card.querySelectorAll('a.sidebar-promotions-slot'));
            if (!nodes.length) nodes = Array.from(card.querySelectorAll('a[href]'));

            for (const node of nodes) {
                if (node.matches('button.sidebar-promotions-show, [data-sidebar-promotions-show], [data-sidebar-promotions-hide]')) continue;
                if (/展开广告|显示广告|收起广告/.test(node.textContent || '')) continue;
                if (!isVisible(node)) continue;

                const el = node.closest('a[href]') || node;
                const holder = el.closest('.sidebar-promotions-slot, [class*="promotions-slot"]') || el.parentElement;
                const isStar = starredCard || hasStar(node) || Boolean(holder && hasStar(holder));

                if (map.has(el)) {
                    if (isStar) map.get(el).star = true;
                    continue;
                }
                const lottery = lotteryInfo(el);
                map.set(el, {
                    el,
                    key: adKey(el),
                    star: isStar,
                    lottery: lottery.lottery,
                    done: lottery.done
                });
            }
        }
        return Array.from(map.values());
    }

    function isExternalHref(a) {
        try {
            return new URL(a.href, location.href).origin !== location.origin;
        } catch (_) {
            return false;
        }
    }

    // 侧边栏里“有图 + 短文字”的横幅，基本就是广告位
    function hasBannerVisual(a) {
        const img = a.querySelector('img');
        if (img) {
            const rect = img.getBoundingClientRect();
            if (rect.width >= 60 && rect.height >= 24) return true;
        }
        if (a.querySelector('picture')) return true;
        if (/url\(/i.test(getComputedStyle(a).backgroundImage)) return true;
        const first = a.firstElementChild;
        return Boolean(first && /url\(/i.test(getComputedStyle(first).backgroundImage));
    }

    function collectBannerItems() {
        const map = new Map();
        const sidebar = document.querySelector('aside.sidebar') ||
            document.querySelector('.sidebar') ||
            document.querySelector('aside');
        if (!sidebar) return [];

        sidebar.querySelectorAll('a[href]').forEach((a) => {
            if (!isVisible(a)) return;

            const rect = a.getBoundingClientRect();
            if (rect.width < 90 || rect.height < 28 || rect.height > 160) return;
            if (!hasBannerVisual(a)) return;

            const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (text.length > 40) return;
            if (/^(回复|登录|注册|首页|更多|上一页|下一页)$/.test(text)) return;

            const cls = String(a.className || '');
            const href = a.getAttribute('href') || '';
            const looksAdUrl = /ad|promo|banner|click|jump|goto/i.test(href);
            if (!isExternalHref(a) && !looksAdUrl && !/ad|promo|banner/i.test(cls)) return;

            const lottery = lotteryInfo(a);
            map.set(a, {
                el: a,
                key: adKey(a),
                star: hasStar(a) || hasStar(a.parentElement),
                lottery: lottery.lottery,
                done: lottery.done,
                banner: true,
                external: isExternalHref(a)
            });
        });

        return Array.from(map.values());
    }

    function collectAllAdItems() {
        const map = new Map();

        for (const item of collectAdItems()) map.set(item.el, item);
        for (const item of collectBannerItems()) {
            if (map.has(item.el)) {
                const existing = map.get(item.el);
                existing.star = existing.star || item.star;
                existing.lottery = existing.lottery || item.lottery;
                existing.done = existing.done || item.done;
                existing.banner = true;
                existing.external = existing.external || item.external;
            } else {
                map.set(item.el, item);
            }
        }

        return Array.from(map.values());
    }

    async function waitForAdItems() {
        const deadline = Date.now() + CONFIG.AD_WAIT_MS;
        while (Date.now() < deadline) {
            const items = collectAllAdItems();
            if (items.length) return items;
            await sleep(150);
        }
        return collectAllAdItems();
    }

    // 点击广告时拦截弹窗，但保留站点自己的点击逻辑
    let adClickGuard = null;

    function installAdClickGuard() {
        document.addEventListener('click', (event) => {
            if (!adClickGuard) return;
            const anchor = event.target && event.target.closest ? event.target.closest('a') : null;
            if (!anchor || anchor !== adClickGuard) return;

            event.preventDefault();

            // 站内跳转链接（点击统计/跳转）用 fetch 补一次，避免被拦弹窗后丢点击
            const rawHref = anchor.getAttribute('href') || '';
            if (/^(#|javascript:)/i.test(rawHref)) return;
            try {
                const url = new URL(rawHref, location.href);
                if (url.origin === location.origin) {
                    fetch(url.href, { credentials: 'include', keepalive: true }).catch(() => {});
                }
            } catch (_) {}
        }, true);
    }

    async function clickAd(el) {
        let originalOpen = null;
        try {
            originalOpen = window.open;
            window.open = () => null;
        } catch (_) {}

        adClickGuard = el.closest ? el.closest('a') : null;

        try {
            el.scrollIntoView({ block: 'center' });
            await sleep(300);
            el.click();
            await sleep(1000);
        } finally {
            adClickGuard = null;
            try {
                if (originalOpen) window.open = originalOpen;
            } catch (_) {}
        }
    }

    function promotionsBoards() {
        return Array.from(document.querySelectorAll('[data-sidebar-promotions-board]'));
    }

    function adsWrap(board) {
        return board ? board.querySelector('[data-sidebar-promotions-wrap]') : null;
    }

    // 站点收起广告时可能只加 is-hidden 类（CSS 里 display:none!important），
    // 不一定设置 hidden 属性，所以要三种情况都判断
    function wrapCollapsed(wrap) {
        if (!wrap) return false;
        if (wrap.hidden) return true;
        if (wrap.classList.contains('is-hidden')) return true;
        const style = getComputedStyle(wrap);
        return style.display === 'none' || style.visibility === 'hidden';
    }

    function adsCollapsed() {
        return promotionsBoards().some((board) => wrapCollapsed(adsWrap(board)));
    }

    // 文案兜底：广告卡结构变了或没有 board 标记时，直接按“显示广告 / 展开广告”找按钮
    function findShowButton() {
        const direct = document.querySelector('[data-sidebar-promotions-show]');
        if (direct && direct.isConnected && !direct.disabled) return direct;
        return Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) => {
            if (!el.isConnected || el.disabled) return false;
            return /^(显示广告|展开广告|显示广告位)$/.test((el.textContent || '').replace(/\s+/g, ''));
        }) || null;
    }

    function adsNeedShow() {
        if (adsCollapsed()) return true;
        const btn = findShowButton();
        return Boolean(btn && isVisible(btn) && !collectAllAdItems().length);
    }

    function describeAds() {
        const boards = promotionsBoards();
        if (!boards.length) {
            const btn = findShowButton();
            return `无广告卡标记，显示广告按钮${btn ? (isVisible(btn) ? '可见' : '存在但不可见') : '不存在'}`;
        }
        return boards.map((board, i) => {
            const wrap = adsWrap(board);
            const btn = board.querySelector('[data-sidebar-promotions-show]');
            return `#${i} 列表${wrap ? (wrapCollapsed(wrap) ? '已收起' : '已展开') : '不存在'}，按钮${btn ? (isVisible(btn) ? '可见' : '隐藏') : '无'}`;
        }).join('；');
    }

    // 站点把“今天已完成这次抽奖”的结果放在 #notify-modal 里，需要点“知道了”关掉，
    // 否则弹窗会一直挡在页面上（点完最后一个广告时尤其明显）。
    async function closeRewardModal(waitMs = 1500) {
        const deadline = Date.now() + waitMs;
        let modal = document.getElementById('notify-modal');
        while ((!modal || modal.hidden) && Date.now() < deadline) {
            await sleep(100);
            modal = document.getElementById('notify-modal');
        }
        if (!modal || modal.hidden) return '';

        const body = document.getElementById('notify-modal-body');
        const text = body ? (body.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const closeBtn = modal.querySelector('[data-modal-close]');
        if (closeBtn) closeBtn.click();
        else modal.hidden = true;

        log('广告：已关闭奖励弹窗' + (text ? `（${text.slice(0, 60)}）` : ''));
        return text;
    }

    // 站点的“显示广告”按钮是 [data-sidebar-promotions-show]，点它要 POST 成功列表才会展开。
    // 若按钮监听没绑上（卡片是后注入的）或请求被拦，则直接提交站点的展开表单兜底。
    async function expandBoard(board) {
        const wrap = adsWrap(board);
        if (!wrap || !wrapCollapsed(wrap)) return true;

        const showBtn = board.querySelector('[data-sidebar-promotions-show]');
        const textBtn = Array.from(board.querySelectorAll('button, a, [role="button"]'))
            .find((el) => /展开广告|显示广告/.test((el.textContent || '').replace(/\s+/g, '')));
        const btn = [showBtn, textBtn].find((el) => el && el.isConnected && !el.disabled);

        if (btn) {
            log(`广告：点击“${(btn.textContent || '显示广告').trim().slice(0, 8)}”展开列表`);
            await clickAd(btn);
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
                if (!wrapCollapsed(wrap)) {
                    await closeRewardModal(800);
                    return true;
                }
                await sleep(150);
            }
        } else {
            warn('广告：未找到“显示广告”按钮');
        }

        const form = board.querySelector('[data-sidebar-promotions-show-form]');
        if (form) {
            log('广告：点击未生效，直接提交展开表单');
            try {
                await fetch(form.action, {
                    method: 'POST',
                    body: new FormData(form),
                    credentials: 'same-origin',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' }
                });
            } catch (_) {}
            wrap.hidden = false;
            wrap.classList.remove('is-hidden');
            wrap.style.display = '';
            await sleep(300);
            if (!wrapCollapsed(wrap)) {
                await closeRewardModal(800);
                return true;
            }
        }

        warn('广告：列表仍未展开');
        return false;
    }

    async function clickShowAds() {
        const collapsed = promotionsBoards().filter((board) => wrapCollapsed(adsWrap(board)));
        let expanded = false;

        for (const board of collapsed) {
            if (await expandBoard(board)) expanded = true;
        }
        if (expanded) return true;

        // 没有识别到收起的广告卡，但页面上确实有可见的“显示广告”按钮且看不到广告位
        const btn = findShowButton();
        if (!btn || !isVisible(btn)) return false;
        if (collectAllAdItems().length) return false;

        log(`广告：点击“${(btn.textContent || '显示广告').trim().slice(0, 8)}”显示广告`);
        await clickAd(btn);
        await sleep(1500);
        await closeRewardModal(800);
        if (!collectAllAdItems().length) warn('广告：点击显示广告后仍未看到广告位');
        return true;
    }

    // 点击后等站点自己的 /promotions_click 响应把该广告位标记为“今日已完成”
    async function waitAdConfirmed(el) {
        const deadline = Date.now() + CONFIG.AD_CONFIRM_MS;
        while (Date.now() < deadline) {
            if (el.dataset && el.dataset.sidebarPromotionsLotteryDone === '1') return true;
            await sleep(200);
        }
        return Boolean(el.dataset && el.dataset.sidebarPromotionsLotteryDone === '1');
    }

    async function stepAds() {
        // 不管今天还剩几次、页面数据是否跨天，先把广告列表展开（手动点过“隐藏广告”后也要能恢复）
        await closeRewardModal(0);
        log(`广告：${describeAds()}`);
        if (adsNeedShow()) await clickShowAds();

        if (state.adClicks >= CONFIG.AD_DAILY_LIMIT) {
            log(`广告：今日已完成 ${state.adClicks} 次，跳过（可点“重置广告”重试）`);
            return;
        }

        if (!adPageIsFresh()) {
            warn('广告：页面里的 reward_day 不是今天，点击不会生效，下次定时重试');
            return;
        }

        let items = await waitForAdItems();
        if (!items.length) {
            // 列表可能被收起，只剩“显示广告”按钮
            if (await clickShowAds()) {
                await sleep(900);
                items = collectAllAdItems();
            }
        }
        if (!items.length) {
            warn('广告：未找到侧边栏广告位，下次定时重试');
            return;
        }
        if (CONFIG.DEBUG) {
            console.table(items.map((item) => ({
                文字: (item.el.textContent || '').trim().slice(0, 30),
                链接: item.key,
                有奖: item.lottery,
                已完成: item.done
            })));
        }

        // 页面是今天的数据时，用站点标记同步进度（手动点过或之前的运行已完成的广告）
        if (adPageIsFresh()) {
            const claimed = items.filter((item) => item.lottery && item.done).length;
            if (claimed > state.adClicks) {
                state.adClicks = Math.min(claimed, CONFIG.AD_DAILY_LIMIT);
                saveState();
                log(`广告：站点显示今日已完成 ${claimed} 个有奖广告，已同步进度`);
            }
        }

        const lotteryItems = items.filter((item) => item.lottery);
        if (!lotteryItems.length) {
            warn('广告：今日没有带红点的有奖广告，下次定时重试');
            return;
        }

        log(`广告：发现 ${items.length} 个广告位，其中带红点 ${lotteryItems.length} 个`);
        log('广告候选：' + lotteryItems.slice(0, 4).map((item) =>
            `${(item.el.textContent || '').trim().slice(0, 16) || item.el.getAttribute('href') || '?'}`
        ).join(' / '));

        const runClicked = new Set();
        let guard = 0;

        while (state.adClicks < CONFIG.AD_DAILY_LIMIT && guard < 12) {
            guard += 1;

            const current = collectAllAdItems();
            const pool = current.filter((item) =>
                item.lottery && !item.done && !runClicked.has(item.el) && isVisible(item.el));

            if (!pool.length) {
                // 列表点完会收起，点“展开广告”再展开继续
                if (await clickShowAds()) continue;
                break;
            }

            const item = pool[0];
            runClicked.add(item.el);

            log(`广告：点击第 ${state.adClicks + 1} 次`, item.key);
            await clickAd(item.el);

            const confirmed = await waitAdConfirmed(item.el);
            // 每次抽奖站点都会弹奖励窗（最后一次是“广告幸运奖励”），点完就顺手关掉
            await closeRewardModal(1200);

            if (confirmed) {
                state.adClicks += 1;
                saveState();
                didSomething = true;
                log(`广告：站点已确认 ${state.adClicks}/${CONFIG.AD_DAILY_LIMIT}`);
            } else {
                warn('广告：站点未确认本次点击，稍后重试', item.key);
            }

            await sleep(600);
        }

        await closeRewardModal(0);

        // 点完广告后站点会自动把列表收起（setHidden(true)），这里再展开一次，
        // 否则今天不会再触发定时任务，广告列表会一直保持收起
        if (adsNeedShow()) {
            log('广告：站点已自动收起列表，重新显示广告');
            await clickShowAds();
        }

        if (state.adClicks < CONFIG.AD_DAILY_LIMIT) {
            warn(`广告：今日完成 ${state.adClicks}/${CONFIG.AD_DAILY_LIMIT} 次，下次定时继续重试`);
        } else {
            log(`广告：今日 ${CONFIG.AD_DAILY_LIMIT} 次已完成`);
        }
    }

    /* ---------------- 4. 领取积分 ---------------- */

    async function stepPoints() {
        if (state.points) {
            log('积分：今日已领取，跳过');
            return;
        }

        const candidates = Array.from(document.querySelectorAll(
            'a, button, [role="button"], [data-claim-points], [data-points-claim]'
        ));

        const el = candidates.find((node) => {
            if (!isVisible(node) || node.disabled) return false;

            const text = (node.textContent || '').replace(/\s+/g, '').trim();
            if (/显示广告|红包|优惠券|签到|抽奖|兑换/.test(text)) return false;

            if (node.matches('[data-claim-points], [data-points-claim]')) return true;
            return /^(领取|立即领取|点击领取)(积分|奖励|点数)$/.test(text);
        });

        if (!el) {
            log('积分：未发现可领取的积分按钮');
            return;
        }

        el.scrollIntoView({ block: 'center' });
        await sleep(300);
        el.click();

        state.points = true;
        saveState();
        didSomething = true;
        await sleep(1200);
        log('积分：已领取', (el.textContent || '').trim().slice(0, 40));
    }

    /* ---------------- 汇总与启动 ---------------- */

    function notifySummary() {
        const summary = [
            `签到：${state.checkin ? '完成' : '未完成'}`,
            `称号免费抽：${state.gacha ? '完成' : '未完成'}`,
            `带星广告：${state.adClicks}/${CONFIG.AD_DAILY_LIMIT}`,
            `领取积分：${state.points ? '完成' : (state.adReward ? `广告奖励 ${state.adReward} 次` : '未完成')}`
        ].join(' | ');

        log(summary);

        if (!didSomething) return;
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({
                    title: 'LINUX.SB 每日任务',
                    text: summary,
                    timeout: 5000
                });
            }
        } catch (_) {}
    }

    let running = false;

    async function runAll() {
        if (running) {
            log('正在执行中，请稍候');
            return;
        }

        const today = todayKey();
        if (state.date !== today) {
            state = freshState();
            saveState();
            log('检测到新的一天，已重置每日状态');
        }

        running = true;
        setRunning(true);

        log('开始执行每日任务', { ...state });

        const safe = async (label, fn) => {
            try {
                await fn();
            } catch (err) {
                warn(`${label} 执行出错：`, err);
            }
        };

        await safe('签到', stepCheckin);
        await safe('称号', stepGacha);
        await safe('广告', stepAds);
        await safe('积分', stepPoints);

        notifySummary();
        render();
        setRunning(false);
        running = false;
    }

    async function runAdsOnly() {
        if (running) {
            log('正在执行中，请稍候');
            return;
        }
        running = true;
        setRunning(true);

        try {
            await stepAds();
        } catch (err) {
            warn('广告执行出错：', err);
        }

        render();
        setRunning(false);
        running = false;
    }

    function resetAds() {
        state.adClicks = 0;
        state.adReward = 0;
        saveState();
        log('已重置广告次数');
    }

    function resetToday() {
        state = freshState();
        saveState();
        log('已重置今日状态');
    }

    /* ---------------- 每天定时自动执行 ---------------- */

    function autoDueTime(now) {
        const parts = String(CONFIG.AUTO_RUN_TIME).split(':').map(Number);
        const hour = Number.isFinite(parts[0]) ? parts[0] : 0;
        const minute = Number.isFinite(parts[1]) ? parts[1] : 5;
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    }

    function allDailyTasksDone() {
        return state.checkin && state.gacha && state.adClicks >= CONFIG.AD_DAILY_LIMIT;
    }

    function lastReloadAt() {
        try {
            return Number(sessionStorage.getItem(RELOAD_KEY) || 0);
        } catch (_) {
            return 0;
        }
    }

    function markReload() {
        try {
            sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        } catch (_) {}
    }

    let lastStaleWarnAt = 0;

    function schedulerTick() {
        if (!autoEnabled || running) return;

        const now = new Date();
        const today = todayKey();

        if (autoState.date !== today) {
            autoState = { date: today, tries: 0, lastTry: 0 };
            store.set(AUTO_STATE_KEY, autoState);
        }

        if (now < autoDueTime(now)) return;

        // 页面跨天：DOM 里的 reward_day、CSRF、红点状态都是昨天的，先刷新一次拿今天的数据。
        // 刷新间隔与重试间隔一致，避免站点日切时间比本地晚时反复 reload。
        if (!adPageIsFresh()) {
            if (Date.now() - lastReloadAt() > CONFIG.AUTO_RUN_INTERVAL_MS) {
                markReload();
                log('定时自动：页面里的 reward_day 不是今天，刷新后执行今日任务');
                location.reload();
                return;
            }
            if (Date.now() - lastStaleWarnAt > CONFIG.AUTO_RUN_INTERVAL_MS) {
                lastStaleWarnAt = Date.now();
                warn('定时自动：页面数据还不是今天的，稍后重试');
            }
            return;
        }

        if (state.date !== today) {
            state = freshState();
            saveState();
            log('检测到新的一天，已重置每日状态');
        }

        if (allDailyTasksDone()) return;
        if (autoState.tries > 0 && now.getTime() - autoState.lastTry < CONFIG.AUTO_RUN_INTERVAL_MS) return;

        autoState.tries += 1;
        autoState.lastTry = now.getTime();
        store.set(AUTO_STATE_KEY, autoState);

        log(`定时自动：第 ${autoState.tries} 次执行`);
        runAll();
    }

    function startScheduler() {
        setInterval(schedulerTick, 30000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) schedulerTick();
        });
    }

    /* ---------------- 初始化 ---------------- */

    mountPanel();
    render();
    installAdClickGuard();
    startScheduler();

    setTimeout(runAll, 1200);
})();