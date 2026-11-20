// ==UserScript==
// @license      GPL-3.0
// @name         LINUX.SB 每日自动（签到 + 称号 + 广告 + 积分 v2.3.1）
// @namespace    https://linux.sb/
// @source       https://github.com/xucux/tampermonkey-script
// @version      2.3.1
// @description  linux.sb 每日自动签到、免费抽取称号一次、点击 3 次带星广告、领取积分（带可视化面板）
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

    const statusNodes = {};
    let panelLogs = null;
    let panelRunBtn = null;
    let panelAdsBtn = null;

    function panelLog(text) {
        if (!panelLogs) return;
        const line = document.createElement('div');
        const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        line.textContent = `${time} ${text}`;
        panelLogs.appendChild(line);
        while (panelLogs.children.length > 12) panelLogs.removeChild(panelLogs.firstChild);
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

    function render() {
        const set = (key, text, ok) => {
            const el = statusNodes[key];
            if (!el) return;
            el.textContent = text;
            el.classList.toggle('ok', Boolean(ok));
        };
        set('checkin', state.checkin ? '✔ 已完成' : '— 未执行', state.checkin);
        set('gacha', state.gacha ? '✔ 已完成' : '— 未执行', state.gacha);
        set('ads', `${Math.min(state.adClicks, CONFIG.AD_DAILY_LIMIT)} / ${CONFIG.AD_DAILY_LIMIT}`,
            state.adClicks >= CONFIG.AD_DAILY_LIMIT);
        set('points', state.points ? '✔ 已领取' : (state.adReward > 0 ? `广告奖励 ${state.adReward} 次` : '— 未执行'),
            state.points || state.adReward > 0);
    }

    function setRunning(value) {
        if (panelRunBtn) panelRunBtn.disabled = value;
        if (panelAdsBtn) panelAdsBtn.disabled = value;
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
  .panel { width: 268px; border: 1px solid #d7e5dc; border-radius: 10px; background: #fff;
    box-shadow: 0 8px 24px rgba(16,24,40,.16); color: #1f2937; overflow: hidden;
    font: 12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif; }
  .head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #f0faf4;
    border-bottom: 1px solid #e2f1e8; }
  .head strong { flex: 1; font-size: 12px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #2ecc71; }
  .collapse { border: 0; background: transparent; color: #6b7280; font-size: 14px; line-height: 1;
    cursor: pointer; padding: 2px 4px; }
  .body { padding: 8px 10px 10px; }
  .rows { display: grid; gap: 4px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .row span { color: #6b7280; }
  .row b { font-weight: 600; }
  .row b.ok { color: #16a34a; }
  .chk { display: flex; align-items: center; gap: 4px; color: #16a34a; font-size: 11px; cursor: pointer; }
  .chk input { width: 12px; height: 12px; margin: 0; accent-color: #2ecc71; }
  .chk b { font-weight: 600; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
  button.act { padding: 5px 4px; border: 1px solid #b7e4c7; border-radius: 6px;
    background: #2ecc71; color: #fff; font-size: 11px; cursor: pointer; white-space: nowrap; }
  button.act:hover { background: #27ae60; }
  button.act.ghost { background: #fff; color: #16a34a; }
  button.act:disabled { opacity: .55; cursor: default; }
  .logs { margin-top: 8px; max-height: 92px; overflow: auto; border-top: 1px dashed #e5e7eb;
    padding-top: 6px; color: #6b7280; font-size: 11px; }
  .logs div { white-space: pre-wrap; word-break: break-all; }
  .panel.collapsed .body { display: none; }
</style>
<div class="panel">
  <div class="head"><span class="dot"></span><strong>LINUX.SB 每日任务</strong><button class="collapse" title="收起">−</button></div>
  <div class="body">
    <div class="rows">
      <div class="row"><span>签到</span><b data-k="checkin">—</b></div>
      <div class="row"><span>称号免费抽</span><b data-k="gacha">—</b></div>
      <div class="row"><span>带星广告</span><b data-k="ads">0 / 3</b></div>
      <div class="row"><span>领取积分</span><b data-k="points">—</b></div>
      <div class="row"><span>定时自动</span><label class="chk"><input type="checkbox" data-auto> 每天 <b data-auto-time>00:05</b></label></div>
    </div>
    <div class="actions">
      <button class="act" data-act="run">立即执行</button>
      <button class="act ghost" data-act="ads">继续广告</button>
      <button class="act ghost" data-act="resetAds">重置广告</button>
      <button class="act ghost" data-act="reset">重置今日</button>
    </div>
    <div class="logs"></div>
  </div>
</div>`;

        document.body.appendChild(host);

        const panel = shadow.querySelector('.panel');
        const collapseBtn = shadow.querySelector('.collapse');
        collapseBtn.addEventListener('click', () => {
            const collapsed = panel.classList.toggle('collapsed');
            collapseBtn.textContent = collapsed ? '+' : '−';
            store.set('sb_panel_collapsed', collapsed);
        });
        if (store.get('sb_panel_collapsed', false)) {
            panel.classList.add('collapsed');
            collapseBtn.textContent = '+';
        }

        shadow.querySelectorAll('[data-k]').forEach((el) => {
            statusNodes[el.dataset.k] = el;
        });
        panelLogs = shadow.querySelector('.logs');

        const autoInput = shadow.querySelector('[data-auto]');
        const autoTimeLabel = shadow.querySelector('[data-auto-time]');
        if (autoTimeLabel) autoTimeLabel.textContent = CONFIG.AUTO_RUN_TIME;
        if (autoInput) {
            autoInput.checked = autoEnabled;
            autoInput.addEventListener('change', () => {
                autoEnabled = autoInput.checked;
                store.set('sb_auto_run_enabled', autoEnabled);
                log(autoEnabled
                    ? `定时自动已开启：每天 ${CONFIG.AUTO_RUN_TIME}（页面需保持打开）`
                    : '定时自动已关闭');
            });
        }

        panelRunBtn = shadow.querySelector('[data-act="run"]');
        panelAdsBtn = shadow.querySelector('[data-act="ads"]');
        const resetAdsBtn = shadow.querySelector('[data-act="resetAds"]');
        const resetBtn = shadow.querySelector('[data-act="reset"]');

        panelRunBtn.addEventListener('click', () => {
            if (running) return;
            runAll();
        });
        panelAdsBtn.addEventListener('click', () => {
            if (running) return;
            runAdsOnly();
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
                if (node.matches('button.sidebar-promotions-show')) continue;
                if (/显示广告/.test(node.textContent || '')) continue;
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

    async function clickShowAds() {
        const candidates = Array.from(document.querySelectorAll('button.sidebar-promotions-show'))
            .concat(Array.from(document.querySelectorAll('button, a'))
                .filter((el) => /显示广告/.test(el.textContent || '') && el.closest('[class*="promotions"]')));

        const btn = candidates.find((el) => isVisible(el) && !el.disabled);
        if (!btn) return false;

        log('广告：点击“显示广告”展开列表');
        await clickAd(btn);
        await sleep(800);
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
                // 列表点完会收起，点“显示广告”再展开继续
                if (await clickShowAds()) continue;
                break;
            }

            const item = pool[0];
            runClicked.add(item.el);

            log(`广告：点击第 ${state.adClicks + 1} 次`, item.key);
            await clickAd(item.el);

            if (await waitAdConfirmed(item.el)) {
                state.adClicks += 1;
                saveState();
                didSomething = true;
                log(`广告：站点已确认 ${state.adClicks}/${CONFIG.AD_DAILY_LIMIT}`);
            } else {
                warn('广告：站点未确认本次点击，稍后重试', item.key);
            }

            await sleep(600);
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