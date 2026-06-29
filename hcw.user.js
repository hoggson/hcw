// ==UserScript==
// @name         hoggson's Chain Watcher
// @version      2.4
// @description  Alerts player when the Torn page chain timer drops below a user-defined value by flashing the screen red and/or playing a sound. Includes an icon-click easy target launcher using a hosted public target list with local fallback.
// @author       hoggson
// @match        https://www.torn.com/*
// @icon         https://torn.com/favicon.ico
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      hoggson.co.uk
// @connect      api.torn.com
// @license      MIT
// @namespace    https://modgaming.co.uk/hcw/hcw.user.js
// @downloadURL https://update.greasyfork.org/scripts/478643/hoggson%27s%20Chain%20Watcher.user.js
// @updateURL https://update.greasyfork.org/scripts/478643/hoggson%27s%20Chain%20Watcher.meta.js
// ==/UserScript==

(function hcwUserscript() {
    'use strict';

    const EASY_TARGETS_URL = 'https://hoggson.co.uk/hcw/easy-targets.json';
    const EASY_TARGETS_CACHE_KEY = 'hcw.easyTargets.cache.v1';
    const EASY_TARGETS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const SOUND_LEADER_KEY = 'hcw.sound.leader';
    const SOUND_LEADER_TTL_MS = 5000;
    const THEME_SYNC_KEY = 'hcw.themeSync.enabled';
    const VIEWER_ID_KEY = 'hcw.viewerId';
    const REQUEST_TIMEOUT_MS = 8000;
    const tabId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const BUILT_IN_EASY_TARGETS = [
        6, 209, 351, 396, 588, 777, 822, 852, 986, 1509,
        1968, 2020, 2042, 2328, 2720, 2721, 2854, 2940, 3078, 3457,
        3496, 3659, 4376, 4556, 4581, 4686, 4720, 5288, 5639, 5803,
        5915, 5926, 6022, 6044, 6248, 6301, 6428, 6639, 6670, 6817,
        6915, 7227, 7238, 7277, 7507, 7710, 7897, 7990, 8137, 8296
    ];

    let previousStateBelowThreshold = false;
    let alertedForCurrentThreshold = false;

    let alertThresholdInSeconds = parseInt(localStorage.getItem('alertThreshold'), 10) || 150;
    let selectedSound = localStorage.getItem('alertSound') || 'alarm';
    let alertVolume = (localStorage.getItem('alertVolume') || 100) / 100;
    let openMode = localStorage.getItem('openMode') || 'current';
    let screenFlashEnabled = localStorage.getItem('screenFlashEnabled') !== 'false';
    let ignoreSmallChain = localStorage.getItem('ignoreSmallChain') !== 'false';
    let previousAttacksEnabled = localStorage.getItem('attackListEnabled') === 'true';
    let tornApiKey = localStorage.getItem('tornApiKey') || '';
    let themeSyncEnabled = localStorage.getItem(THEME_SYNC_KEY) === 'true';

    let chainStatusElement = null;
    let targetStatusElement = null;
    let attackStatusElement = null;
    let themeSyncStatusElement = null;
    let attackBox = null;
    let currentAttackPage = 0;
    let cachedAttacks = [];
    let hospitalInterval = null;
    let themeMediaQuery = null;
    let themeRetryTimer = null;
    let viewerTornId = null;
    const hospitalTimers = {};
    const profileCache = {};

    const sounds = {
        silent: null,
        beep: 'https://hoggson.co.uk/hcw/beep.mp3',
        alarm: 'https://hoggson.co.uk/hcw/alarm.mp3',
        siren: 'https://hoggson.co.uk/hcw/siren.mp3'
    };

    function onReady(fn) {
        if (document.body) {
            fn();
            return;
        }
        document.addEventListener('DOMContentLoaded', fn, { once: true });
    }

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function numberOrNull(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function detectViewerTornId() {
        if (viewerTornId) return viewerTornId;
        const tornUser = document.querySelector('#torn-user');
        if (tornUser && tornUser.value) {
            try {
                const parsed = JSON.parse(tornUser.value.replace(/&quot;/g, '"'));
                const detectedId = numberOrNull(parsed?.id || parsed?.userID || parsed?.player_id);
                if (detectedId) {
                    viewerTornId = detectedId;
                    localStorage.setItem(VIEWER_ID_KEY, String(detectedId));
                    return viewerTornId;
                }
            } catch {
                // Fall back to cached viewer ID below.
            }
        }
        viewerTornId = numberOrNull(localStorage.getItem(VIEWER_ID_KEY));
        return viewerTornId;
    }

    function formatDuration(seconds) {
        const total = Math.max(0, Math.ceil(Number(seconds) || 0));
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return mins ? `${mins}m ${String(secs).padStart(2, '0')}s` : `${secs}s`;
    }

    function parseTimerText(text) {
        const parts = String(text || '').trim().split(':').map((part) => Number.parseInt(part, 10));
        if (parts.length < 2 || parts.some((part) => !Number.isFinite(part))) return null;
        return parts.reduce((total, part) => (total * 60) + part, 0);
    }

    function findPageChainBar() {
        const selectors = [
            'a[class*="chain-bar"]',
            '[class*="chain-bar"]',
            'a[href*="/war/chain"]',
            'a[href*="step=chainreport"]'
        ];
        const candidates = Array.from(new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))));
        return candidates
            .map((candidate) => candidate.closest('a') || candidate)
            .find((candidate) => {
                const nameText = cleanText(candidate.querySelector('[class*="bar-name"]')?.textContent);
                const href = candidate.getAttribute?.('href') || '';
                const fullText = cleanText(candidate.textContent);
                return /^chain:?$/i.test(nameText) || /(?:\/war\/chain|step=chainreport)/i.test(href) || /\bChain:\b/i.test(fullText);
            }) || null;
    }

    function parsePageChainCount(text) {
        const match = cleanText(text).match(/^([\d,]+)/);
        if (!match) return null;
        const count = Number.parseInt(match[1].replace(/,/g, ''), 10);
        return Number.isFinite(count) ? count : null;
    }

    function readPageChainState() {
        const chainBar = findPageChainBar();
        if (!chainBar) {
            return {
                ok: true,
                source: 'page',
                active: false,
                current: 0,
                remainingSeconds: 0,
                cooldown: false,
                reason: 'chain-bar-missing'
            };
        }

        const cooldown = Boolean(chainBar.querySelector('[class*="cooldown"]') || /\bcooldown\b/i.test(cleanText(chainBar.textContent)));
        const timerElement = chainBar.querySelector('[class*="bar-timeleft"]');
        const totalTimeInSeconds = timerElement ? parseTimerText(timerElement.textContent) : 0;
        const chainValueText = cleanText(chainBar.querySelector('[class*="bar-value"]')?.textContent);
        const chainCount = parsePageChainCount(chainValueText);

        if (!Number.isFinite(chainCount)) {
            return {
                ok: false,
                source: 'page',
                active: false,
                current: 0,
                remainingSeconds: 0,
                cooldown,
                reason: 'chain-count-missing'
            };
        }

        if (!Number.isFinite(totalTimeInSeconds)) {
            return {
                ok: false,
                source: 'page',
                active: false,
                current: chainCount,
                remainingSeconds: 0,
                cooldown,
                reason: 'timer-invalid'
            };
        }

        const hasNoChain = chainCount <= 0 || totalTimeInSeconds <= 0;
        return {
            ok: true,
            source: 'page',
            active: !cooldown && !hasNoChain,
            current: chainCount,
            remainingSeconds: totalTimeInSeconds,
            cooldown,
            reason: hasNoChain ? 'inactive' : null
        };
    }

    function setChainStatus(state, ignoredSmallChain) {
        if (!chainStatusElement) return;
        if (!state || !state.ok) {
            chainStatusElement.textContent = `Chain status: Torn page data unavailable (${state?.reason || 'unknown'}).`;
            return;
        }
        if (!state.active) {
            chainStatusElement.textContent = state.cooldown ? 'Chain status: cooldown.' : 'Chain status: inactive.';
            return;
        }
        const count = Number.isFinite(state.current) ? `${state.current} hits` : 'active';
        const ignored = ignoredSmallChain ? ' (ignored under 10)' : '';
        chainStatusElement.textContent = `Chain: ${count}, ${formatDuration(state.remainingSeconds)} left${ignored}.`;
    }

    function claimSoundLeadership() {
        const raw = localStorage.getItem(SOUND_LEADER_KEY);
        const now = Date.now();
        let leader = null;
        try {
            leader = raw ? JSON.parse(raw) : null;
        } catch {
            leader = null;
        }
        if (!leader || !leader.id || (now - (leader.ts || 0)) > SOUND_LEADER_TTL_MS) {
            leader = { id: tabId, ts: now };
            localStorage.setItem(SOUND_LEADER_KEY, JSON.stringify(leader));
        }
        if (leader.id === tabId) {
            leader.ts = now;
            localStorage.setItem(SOUND_LEADER_KEY, JSON.stringify(leader));
            return true;
        }
        return false;
    }

    function isCurrentLeader() {
        const raw = localStorage.getItem(SOUND_LEADER_KEY);
        if (!raw) return false;
        try {
            const leader = JSON.parse(raw);
            return leader.id === tabId && (Date.now() - (leader.ts || 0)) <= SOUND_LEADER_TTL_MS;
        } catch {
            return false;
        }
    }

    function maintainSoundLeadership() {
        const raw = localStorage.getItem(SOUND_LEADER_KEY);
        const now = Date.now();
        let leader = null;
        try {
            leader = raw ? JSON.parse(raw) : null;
        } catch {
            leader = null;
        }
        if (leader && leader.id === tabId) {
            leader.ts = now;
            localStorage.setItem(SOUND_LEADER_KEY, JSON.stringify(leader));
            return;
        }
        if (!leader || !leader.id || (now - (leader.ts || 0)) > SOUND_LEADER_TTL_MS) {
            claimSoundLeadership();
        }
    }

    function flashScreenRed() {
        const flashDiv = document.createElement('div');
        flashDiv.style.position = 'fixed';
        flashDiv.style.top = '0';
        flashDiv.style.left = '0';
        flashDiv.style.width = '100vw';
        flashDiv.style.height = '100vh';
        flashDiv.style.backgroundColor = 'red';
        flashDiv.style.zIndex = '-1';
        document.body.appendChild(flashDiv);
        setTimeout(() => {
            flashDiv.remove();
        }, 1000);
    }

    function playAlertSound() {
        if (selectedSound === 'silent') return;
        const audio = new Audio(sounds[selectedSound]);
        audio.volume = alertVolume;
        audio.play().catch((error) => {
            console.warn('[HCW] Audio playback failed:', error);
        });
    }

    function checkChainTimer() {
        const chainState = readPageChainState();
        const chainCount = Number(chainState.current);
        const remainingSeconds = Number(chainState.remainingSeconds);
        const isSmallChain = ignoreSmallChain && Number.isFinite(chainCount) && chainCount > 0 && chainCount < 10;
        setChainStatus(chainState, isSmallChain);

        if (!chainState.ok || !chainState.active || chainState.cooldown || isSmallChain) {
            previousStateBelowThreshold = false;
            alertedForCurrentThreshold = false;
            return;
        }

        if (Number.isFinite(remainingSeconds) && remainingSeconds < alertThresholdInSeconds) {
            if (!alertedForCurrentThreshold) {
                alertedForCurrentThreshold = true;
            }
            if (screenFlashEnabled) {
                flashScreenRed();
            }
            if (claimSoundLeadership()) {
                playAlertSound();
            }
            previousStateBelowThreshold = true;
        } else {
            previousStateBelowThreshold = false;
            alertedForCurrentThreshold = false;
        }
    }

    function normalizeTargetList(value) {
        const targets = Array.isArray(value?.targets) ? value.targets : Array.isArray(value) ? value : [];
        return Array.from(new Set(targets
            .map((target) => Number.parseInt(target, 10))
            .filter((target) => Number.isFinite(target) && target > 0)));
    }

    function readCachedTargets() {
        try {
            const raw = localStorage.getItem(EASY_TARGETS_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const targets = normalizeTargetList(parsed);
            if (!targets.length) return null;
            return {
                targets,
                generatedAt: parsed.generated_at || null,
                fetchedAt: Number(parsed.fetched_at) || 0
            };
        } catch {
            return null;
        }
    }

    function writeCachedTargets(payload) {
        const targets = normalizeTargetList(payload);
        if (!targets.length) return null;
        const cachePayload = {
            schema_version: 1,
            generated_at: payload?.generated_at || null,
            fetched_at: Date.now(),
            count: targets.length,
            targets
        };
        try {
            localStorage.setItem(EASY_TARGETS_CACHE_KEY, JSON.stringify(cachePayload));
        } catch {
            // Cache is nice to have, not required.
        }
        return cachePayload;
    }

    function requestText(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout: REQUEST_TIMEOUT_MS,
                    headers: { Accept: 'application/json' },
                    onload: (response) => {
                        if (response.status >= 200 && response.status < 300) {
                            resolve(response.responseText || '');
                        } else {
                            reject(new Error(`HTTP ${response.status}`));
                        }
                    },
                    ontimeout: () => reject(new Error('request-timeout')),
                    onerror: () => reject(new Error('request-error'))
                });
                return;
            }

            fetch(url, { cache: 'no-store' })
                .then((response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return response.text();
                })
                .then(resolve)
                .catch(reject);
        });
    }

    async function requestJson(url) {
        const text = await requestText(url);
        const payload = JSON.parse(text);
        if (payload?.error) {
            const errorText = payload.error.error || payload.error || 'Torn API error';
            throw new Error(String(errorText));
        }
        return payload;
    }

    async function fetchHostedTargets() {
        const text = await requestText(`${EASY_TARGETS_URL}?_=${Date.now()}`);
        const payload = JSON.parse(text);
        const cached = writeCachedTargets(payload);
        return cached?.targets || [];
    }

    async function getEasyTargets() {
        const cached = readCachedTargets();
        const cacheFresh = cached && Date.now() - cached.fetchedAt <= EASY_TARGETS_CACHE_TTL_MS;
        if (cacheFresh) {
            return { targets: cached.targets, source: 'cached' };
        }

        try {
            const hostedTargets = await fetchHostedTargets();
            if (hostedTargets.length) {
                return { targets: hostedTargets, source: 'hosted' };
            }
        } catch (error) {
            console.warn('[HCW] Hosted easy target list unavailable:', error);
        }

        if (cached?.targets?.length) {
            return { targets: cached.targets, source: 'cached' };
        }

        return { targets: BUILT_IN_EASY_TARGETS, source: 'built-in' };
    }

    function randomItem(items) {
        return items[Math.floor(Math.random() * items.length)];
    }

    function setTargetStatus(message) {
        if (!targetStatusElement) return;
        targetStatusElement.textContent = message || '';
    }

    function openAttack(targetId) {
        if (!targetId) return;
        const attackLink = `https://www.torn.com/page.php?sid=attack&user2ID=${encodeURIComponent(targetId)}`;
        if (openMode === 'newtab') {
            window.open(attackLink, '_blank');
        } else {
            window.location.href = attackLink;
        }
    }

    async function openRandomTarget() {
        setTargetStatus('Loading target list...');
        const result = await getEasyTargets();
        const targetId = randomItem(result.targets || []);
        if (!targetId) {
            setTargetStatus('No easy targets available.');
            return;
        }
        setTargetStatus(`Opening target ${targetId} (${result.source}).`);
        openAttack(targetId);
    }

    function obfuscateKey(key) {
        if (!key) return '';
        return `${key.slice(0, 4)}${'*'.repeat(Math.max(0, key.length - 4))}`;
    }

    function setAttackStatus(message) {
        if (attackStatusElement) attackStatusElement.textContent = message || '';
    }

    function clearObject(object) {
        Object.keys(object).forEach((key) => {
            delete object[key];
        });
    }

    async function fetchAttacks() {
        if (!tornApiKey) return [];
        const url = `https://api.torn.com/user/?selections=attacks&key=${encodeURIComponent(tornApiKey)}`;
        const data = await requestJson(url);
        const viewerId = detectViewerTornId();
        return Object.values(data.attacks || {})
            .filter((attack) => {
                const attackerId = numberOrNull(attack?.attacker_id);
                const defenderId = numberOrNull(attack?.defender_id);
                if (!defenderId) return false;
                if (viewerId && defenderId === viewerId) return false;
                if (viewerId && attackerId && attackerId !== viewerId) return false;
                return true;
            })
            .sort((a, b) => parseFloat(b.respect || 0) - parseFloat(a.respect || 0))
            .slice(0, 100);
    }

    async function fetchDefenderProfile(id) {
        if (!id) return { level: 'N/A', hospitalTime: null, isHospital: false, until: 0 };
        if (profileCache[id]) return profileCache[id];
        try {
            const url = `https://api.torn.com/user/${encodeURIComponent(id)}?selections=profile&key=${encodeURIComponent(tornApiKey)}`;
            const data = await requestJson(url);
            const level = data.level || 'N/A';
            let hospitalTime = null;
            let isHospital = false;
            let until = 0;
            if (data.status?.state === 'Hospital') {
                isHospital = true;
                until = Number(data.status.until) || 0;
                const remaining = until - Math.floor(Date.now() / 1000);
                if (remaining > 0) hospitalTime = formatDuration(remaining);
            }
            profileCache[id] = { level, hospitalTime, isHospital, until };
            return profileCache[id];
        } catch {
            return { level: 'N/A', hospitalTime: null, isHospital: false, until: 0 };
        }
    }

    function startHospitalCountdown() {
        if (hospitalInterval) clearInterval(hospitalInterval);
        hospitalInterval = setInterval(() => {
            Object.keys(hospitalTimers).forEach((id) => {
                const timer = hospitalTimers[id];
                if (!timer || timer.remaining <= 0) return;
                timer.remaining -= 5;
                const element = document.getElementById(`hcw-hospital-${id}`);
                if (element) element.textContent = `Hospital: ${formatDuration(timer.remaining)}`;
            });
        }, 5000);
    }

    function appendAttackPanelMessage(message) {
        if (!attackBox) return;
        attackBox.textContent = '';
        const heading = document.createElement('h2');
        heading.textContent = 'Previous Attacks';
        attackBox.appendChild(heading);
        const note = document.createElement('div');
        note.className = 'hcw-muted';
        note.textContent = message;
        attackBox.appendChild(note);
    }

    async function renderAttackPage() {
        if (!attackBox) return;
        attackBox.textContent = '';
        clearObject(hospitalTimers);

        const heading = document.createElement('h2');
        heading.textContent = 'Previous Attacks';
        attackBox.appendChild(heading);

        if (!tornApiKey) {
            appendAttackPanelMessage('Save a Torn API key in HCW to use Previous Attacks.');
            return;
        }

        const seenIds = new Set();
        const pageAttacks = [];
        for (let index = currentAttackPage * 10; index < cachedAttacks.length && pageAttacks.length < 10; index += 1) {
            const attack = cachedAttacks[index];
            const id = attack?.defender_id;
            if (id && !seenIds.has(id)) {
                seenIds.add(id);
                pageAttacks.push(attack);
            }
        }

        if (!pageAttacks.length) {
            const empty = document.createElement('div');
            empty.className = 'hcw-muted';
            empty.textContent = 'No previous attacks found.';
            attackBox.appendChild(empty);
        }

        for (const attack of pageAttacks) {
            const name = attack.defender_name || 'Unknown';
            const id = attack.defender_id || '';
            const respect = parseFloat(attack.respect || 0);
            const profile = await fetchDefenderProfile(id);

            const entry = document.createElement('div');
            entry.className = `hcw-attack-entry ${profile.isHospital ? 'hcw-hospital' : 'hcw-alive'}`;

            const link = document.createElement('a');
            link.href = `https://www.torn.com/profiles.php?XID=${encodeURIComponent(id)}`;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = name;
            entry.appendChild(link);

            const summary = document.createElement('div');
            summary.textContent = `Level ${profile.level} | Respect: ${Number.isFinite(respect) ? respect.toFixed(2) : '0.00'}`;
            entry.appendChild(summary);

            const status = document.createElement('div');
            if (profile.isHospital) {
                const remaining = profile.until - Math.floor(Date.now() / 1000);
                hospitalTimers[id] = { remaining };
                status.id = `hcw-hospital-${id}`;
                status.textContent = `Hospital: ${formatDuration(remaining)}`;
            } else {
                status.textContent = 'Alive';
            }
            entry.appendChild(status);
            attackBox.appendChild(entry);
        }

        const controls = document.createElement('div');
        controls.className = 'hcw-refresh-controls';

        const refreshButton = document.createElement('button');
        refreshButton.textContent = 'Refresh';
        styleButton(refreshButton);
        refreshButton.addEventListener('click', () => loadPreviousAttacks(true));

        const prevButton = document.createElement('button');
        prevButton.textContent = 'Prev';
        styleButton(prevButton);
        prevButton.addEventListener('click', () => {
            currentAttackPage -= 1;
            if (currentAttackPage < 0) {
                currentAttackPage = Math.max(0, Math.floor((cachedAttacks.length - 1) / 10));
            }
            renderAttackPage();
        });

        const pageIndicator = document.createElement('span');
        pageIndicator.textContent = `${currentAttackPage + 1} of ${Math.max(1, Math.ceil(cachedAttacks.length / 10))}`;

        const nextButton = document.createElement('button');
        nextButton.textContent = 'Next';
        styleButton(nextButton);
        nextButton.addEventListener('click', () => {
            currentAttackPage += 1;
            if (currentAttackPage * 10 >= cachedAttacks.length) currentAttackPage = 0;
            renderAttackPage();
        });

        controls.appendChild(refreshButton);
        controls.appendChild(prevButton);
        controls.appendChild(pageIndicator);
        controls.appendChild(nextButton);
        attackBox.appendChild(controls);

        startHospitalCountdown();
    }

    async function loadPreviousAttacks(force = false) {
        if (!previousAttacksEnabled) return;
        if (!attackBox) showAttackBox(false);
        if (!tornApiKey) {
            appendAttackPanelMessage('Save a Torn API key in HCW to use Previous Attacks.');
            setAttackStatus('Previous Attacks needs a Torn API key.');
            return;
        }
        if (!force && cachedAttacks.length) {
            renderAttackPage();
            return;
        }
        setAttackStatus('Loading Previous Attacks...');
        appendAttackPanelMessage('Loading Previous Attacks...');
        try {
            cachedAttacks = await fetchAttacks();
            currentAttackPage = 0;
            clearObject(profileCache);
            setAttackStatus(cachedAttacks.length ? `Loaded ${cachedAttacks.length} attacks.` : 'No previous attacks found.');
            await renderAttackPage();
        } catch (error) {
            console.warn('[HCW] Previous Attacks failed:', error);
            setAttackStatus(`Previous Attacks failed: ${error.message || error}`);
            appendAttackPanelMessage(`Previous Attacks failed: ${error.message || error}`);
        }
    }

    function showAttackBox(load = true) {
        if (!attackBox) {
            attackBox = document.createElement('div');
            attackBox.id = 'hcw-attack-box';
            attackBox.style.position = 'fixed';
            attackBox.style.top = 'calc(5% + 40px)';
            attackBox.style.right = '10px';
            attackBox.style.width = '420px';
            attackBox.style.maxHeight = '600px';
            attackBox.style.overflowY = 'auto';
            attackBox.style.zIndex = '9999';
            document.body.appendChild(attackBox);
        }
        attackBox.style.display = 'block';
        if (load) loadPreviousAttacks();
    }

    function hideAttackBox() {
        if (attackBox) attackBox.style.display = 'none';
        if (hospitalInterval) {
            clearInterval(hospitalInterval);
            hospitalInterval = null;
        }
    }

    function setPreviousAttacksEnabled(enabled) {
        previousAttacksEnabled = enabled === true;
        localStorage.setItem('attackListEnabled', String(previousAttacksEnabled));
        if (previousAttacksEnabled) {
            setAttackStatus(tornApiKey ? 'Previous Attacks enabled.' : 'Previous Attacks needs a Torn API key.');
            showAttackBox();
        } else {
            setAttackStatus('Previous Attacks disabled.');
            hideAttackBox();
        }
    }

    function setThemeSyncStatus(message) {
        if (themeSyncStatusElement) themeSyncStatusElement.textContent = message || '';
    }

    function prefersDark() {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function findThemeCheckbox() {
        return document.querySelector('#dark-mode-state');
    }

    function syncThemeToSystem() {
        if (!themeSyncEnabled) return;
        const checkbox = findThemeCheckbox();
        if (!checkbox) {
            setThemeSyncStatus('Waiting for Torn theme control...');
            if (themeRetryTimer) clearTimeout(themeRetryTimer);
            themeRetryTimer = setTimeout(syncThemeToSystem, 500);
            return;
        }
        const shouldBeDark = prefersDark();
        if (checkbox.checked !== shouldBeDark) {
            checkbox.click();
            setThemeSyncStatus(`Synced to ${shouldBeDark ? 'dark' : 'light'} mode.`);
            return;
        }
        setThemeSyncStatus(`Already ${shouldBeDark ? 'dark' : 'light'} mode.`);
    }

    function ensureThemeSyncListener() {
        if (themeMediaQuery || !window.matchMedia) return;
        themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => syncThemeToSystem();
        if (typeof themeMediaQuery.addEventListener === 'function') {
            themeMediaQuery.addEventListener('change', onChange);
        } else if (typeof themeMediaQuery.addListener === 'function') {
            themeMediaQuery.addListener(onChange);
        }
    }

    function setThemeSyncEnabled(enabled) {
        themeSyncEnabled = enabled === true;
        localStorage.setItem(THEME_SYNC_KEY, String(themeSyncEnabled));
        if (themeSyncEnabled) {
            ensureThemeSyncListener();
            syncThemeToSystem();
        } else {
            if (themeRetryTimer) clearTimeout(themeRetryTimer);
            setThemeSyncStatus('Theme sync disabled.');
        }
    }

    function styleButton(button, color = '#28a745') {
        button.style.marginLeft = '5px';
        button.style.backgroundColor = color;
        button.style.color = 'white';
        button.style.border = 'none';
        button.style.padding = '3px 8px';
        button.style.borderRadius = '4px';
        button.style.cursor = 'pointer';
    }

    function appendDivider(parent) {
        const divider = document.createElement('div');
        divider.style.borderTop = '1px solid rgba(255,255,255,0.15)';
        divider.style.margin = '8px 0';
        parent.appendChild(divider);
    }

    function appendSectionTitle(parent, title) {
        const heading = document.createElement('div');
        heading.textContent = title;
        heading.style.fontWeight = '700';
        heading.style.margin = '4px 0 6px';
        heading.style.color = '#9fd4ff';
        parent.appendChild(heading);
    }

    function injectStyles() {
        if (document.getElementById('hcw-styles')) return;
        const style = document.createElement('style');
        style.id = 'hcw-styles';
        style.textContent = `
            #hcw-attack-box {
                background: rgba(0,0,0,0.8);
                color: #fff;
                border: 1px solid #444;
                border-radius: 6px;
                padding: 8px;
                font: 12px Arial, sans-serif;
                box-shadow: 0 12px 32px rgba(0,0,0,0.35);
            }
            #hcw-attack-box h2 {
                margin: 0 0 8px;
                font-size: 14px;
                border-bottom: 1px solid #555;
                padding-bottom: 4px;
                color: #28a745;
            }
            #hcw-attack-box .hcw-muted {
                color: #cfe8ff;
                line-height: 1.35;
            }
            #hcw-attack-box .hcw-attack-entry {
                border-bottom: 1px solid #333;
                padding: 6px 0;
                line-height: 1.35;
            }
            #hcw-attack-box .hcw-attack-entry a {
                color: #4fc3f7;
                font-weight: 700;
                text-decoration: none;
            }
            #hcw-attack-box .hcw-attack-entry a:hover {
                text-decoration: underline;
            }
            #hcw-attack-box .hcw-alive {
                border-left: 3px solid #28a745;
                padding-left: 6px;
            }
            #hcw-attack-box .hcw-hospital {
                border-left: 3px solid #dc3545;
                padding-left: 6px;
            }
            #hcw-attack-box .hcw-refresh-controls {
                margin-top: 10px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #hcw-attack-box .hcw-refresh-controls span {
                color: #fff;
                flex: 1;
                text-align: center;
            }
        `;
        document.head.appendChild(style);
    }

    function createControls(parent) {
        appendSectionTitle(parent, 'Chain Watcher');

        const timerDropdown = document.createElement('select');
        [30, 60, 90, 120, 150, 180, 210, 240, 270].forEach((seconds) => {
            const option = document.createElement('option');
            option.value = seconds;
            option.textContent = `${seconds / 60} minutes`;
            timerDropdown.appendChild(option);
        });
        timerDropdown.value = alertThresholdInSeconds;
        timerDropdown.addEventListener('change', (event) => {
            alertThresholdInSeconds = parseInt(event.target.value, 10);
            localStorage.setItem('alertThreshold', alertThresholdInSeconds);
            alertedForCurrentThreshold = false;
        });

        const flashWrapper = document.createElement('label');
        flashWrapper.style.color = 'white';
        flashWrapper.style.marginLeft = '5px';
        flashWrapper.style.fontSize = '12px';
        flashWrapper.style.display = 'inline-flex';
        flashWrapper.style.alignItems = 'center';

        const flashCheckbox = document.createElement('input');
        flashCheckbox.type = 'checkbox';
        flashCheckbox.checked = screenFlashEnabled;
        flashCheckbox.style.marginRight = '3px';
        flashCheckbox.addEventListener('change', (event) => {
            screenFlashEnabled = event.target.checked;
            localStorage.setItem('screenFlashEnabled', screenFlashEnabled);
        });

        flashWrapper.appendChild(flashCheckbox);
        flashWrapper.appendChild(document.createTextNode('Screen Flash'));

        const soundDropdown = document.createElement('select');
        Object.keys(sounds).forEach((key) => {
            const option = document.createElement('option');
            option.value = key;
            option.textContent = key.charAt(0).toUpperCase() + key.slice(1);
            soundDropdown.appendChild(option);
        });
        soundDropdown.value = selectedSound;
        soundDropdown.addEventListener('change', (event) => {
            selectedSound = event.target.value;
            localStorage.setItem('alertSound', selectedSound);
        });

        const smallChainWrapper = document.createElement('label');
        smallChainWrapper.style.color = 'white';
        smallChainWrapper.style.marginLeft = '5px';
        smallChainWrapper.style.fontSize = '12px';
        smallChainWrapper.style.display = 'inline-flex';
        smallChainWrapper.style.alignItems = 'center';

        const smallChainCheckbox = document.createElement('input');
        smallChainCheckbox.type = 'checkbox';
        smallChainCheckbox.checked = ignoreSmallChain;
        smallChainCheckbox.style.marginRight = '3px';
        smallChainCheckbox.addEventListener('change', (event) => {
            ignoreSmallChain = event.target.checked;
            localStorage.setItem('ignoreSmallChain', ignoreSmallChain);
            if (ignoreSmallChain) {
                previousStateBelowThreshold = false;
                alertedForCurrentThreshold = false;
            }
        });

        smallChainWrapper.appendChild(smallChainCheckbox);
        smallChainWrapper.appendChild(document.createTextNode('Ignore chains under 10'));

        const volumeWrapper = document.createElement('div');
        volumeWrapper.style.display = 'inline-flex';
        volumeWrapper.style.alignItems = 'center';
        volumeWrapper.style.marginLeft = '5px';

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = 0;
        volumeSlider.max = 100;
        volumeSlider.value = localStorage.getItem('alertVolume') || 100;

        const volumeLabel = document.createElement('span');
        volumeLabel.textContent = `Volume: ${volumeSlider.value}%`;
        volumeLabel.style.color = 'white';
        volumeLabel.style.marginLeft = '5px';
        volumeLabel.style.fontSize = '12px';

        volumeSlider.addEventListener('input', (event) => {
            alertVolume = event.target.value / 100;
            localStorage.setItem('alertVolume', event.target.value);
            volumeLabel.textContent = `Volume: ${event.target.value}%`;
        });

        volumeWrapper.appendChild(volumeSlider);
        volumeWrapper.appendChild(volumeLabel);

        const testButton = document.createElement('button');
        testButton.textContent = 'Test Sound';
        styleButton(testButton);
        testButton.addEventListener('click', () => {
            playAlertSound();
        });

        const openModeDropdown = document.createElement('select');
        ['current', 'newtab'].forEach((mode) => {
            const option = document.createElement('option');
            option.value = mode;
            option.textContent = mode === 'current' ? 'Current Window' : 'New Tab';
            openModeDropdown.appendChild(option);
        });
        openModeDropdown.value = openMode;
        openModeDropdown.style.marginLeft = '5px';
        openModeDropdown.addEventListener('change', (event) => {
            openMode = event.target.value;
            localStorage.setItem('openMode', openMode);
        });

        const helpButton = document.createElement('button');
        helpButton.textContent = 'Help';
        styleButton(helpButton, '#007bff');
        helpButton.addEventListener('click', () => {
            window.open('https://hoggson.co.uk/hcw', '_blank');
        });

        parent.appendChild(timerDropdown);
        parent.appendChild(flashWrapper);
        parent.appendChild(soundDropdown);
        parent.appendChild(smallChainWrapper);
        parent.appendChild(volumeWrapper);
        parent.appendChild(testButton);
        parent.appendChild(openModeDropdown);
        parent.appendChild(helpButton);

        chainStatusElement = document.createElement('div');
        chainStatusElement.textContent = 'Chain status: waiting for Torn page data.';
        chainStatusElement.style.color = '#cfe8ff';
        chainStatusElement.style.fontSize = '11px';
        chainStatusElement.style.marginTop = '6px';
        chainStatusElement.style.lineHeight = '1.35';
        parent.appendChild(chainStatusElement);

        targetStatusElement = document.createElement('div');
        targetStatusElement.textContent = 'Click the icon for an easy target.';
        targetStatusElement.style.color = '#cfe8ff';
        targetStatusElement.style.fontSize = '11px';
        targetStatusElement.style.marginTop = '3px';
        targetStatusElement.style.lineHeight = '1.35';
        parent.appendChild(targetStatusElement);

        appendDivider(parent);
        appendSectionTitle(parent, 'Previous Attacks');

        const attacksWrapper = document.createElement('label');
        attacksWrapper.style.color = 'white';
        attacksWrapper.style.fontSize = '12px';
        attacksWrapper.style.display = 'inline-flex';
        attacksWrapper.style.alignItems = 'center';

        const attacksCheckbox = document.createElement('input');
        attacksCheckbox.type = 'checkbox';
        attacksCheckbox.checked = previousAttacksEnabled;
        attacksCheckbox.style.marginRight = '5px';
        attacksCheckbox.addEventListener('change', (event) => {
            setPreviousAttacksEnabled(event.target.checked);
        });

        attacksWrapper.appendChild(attacksCheckbox);
        attacksWrapper.appendChild(document.createTextNode('Enable Previous Attacks'));
        parent.appendChild(attacksWrapper);

        const keyWrapper = document.createElement('div');
        keyWrapper.style.display = 'flex';
        keyWrapper.style.alignItems = 'center';
        keyWrapper.style.gap = '6px';
        keyWrapper.style.marginTop = '6px';
        keyWrapper.style.flexWrap = 'wrap';

        const keyInput = document.createElement('input');
        keyInput.type = 'password';
        keyInput.autocomplete = 'off';
        keyInput.spellcheck = false;
        keyInput.value = tornApiKey;
        keyInput.placeholder = 'Torn API key';
        keyInput.title = tornApiKey ? `Saved key: ${obfuscateKey(tornApiKey)}` : 'Torn API key';
        keyInput.style.width = '240px';
        keyInput.style.padding = '4px 6px';
        keyInput.style.borderRadius = '4px';
        keyInput.style.border = '1px solid rgba(255,255,255,0.35)';
        keyInput.style.background = 'rgba(0,0,0,0.35)';
        keyInput.style.color = '#fff';

        const saveKeyButton = document.createElement('button');
        saveKeyButton.textContent = 'Save key';
        styleButton(saveKeyButton);
        saveKeyButton.addEventListener('click', () => {
            tornApiKey = keyInput.value.trim();
            localStorage.setItem('tornApiKey', tornApiKey);
            keyInput.title = tornApiKey ? `Saved key: ${obfuscateKey(tornApiKey)}` : 'Torn API key';
            clearObject(profileCache);
            cachedAttacks = [];
            setAttackStatus(tornApiKey ? 'Torn API key saved.' : 'Torn API key cleared.');
            if (previousAttacksEnabled && tornApiKey) loadPreviousAttacks(true);
            if (previousAttacksEnabled && !tornApiKey) appendAttackPanelMessage('Save a Torn API key in HCW to use Previous Attacks.');
        });

        const clearKeyButton = document.createElement('button');
        clearKeyButton.textContent = 'Clear';
        styleButton(clearKeyButton, '#6c757d');
        clearKeyButton.addEventListener('click', () => {
            tornApiKey = '';
            keyInput.value = '';
            keyInput.title = 'Torn API key';
            localStorage.removeItem('tornApiKey');
            cachedAttacks = [];
            clearObject(profileCache);
            setAttackStatus('Torn API key cleared.');
            if (previousAttacksEnabled) appendAttackPanelMessage('Save a Torn API key in HCW to use Previous Attacks.');
        });

        const refreshAttacksButton = document.createElement('button');
        refreshAttacksButton.textContent = 'Refresh';
        styleButton(refreshAttacksButton);
        refreshAttacksButton.addEventListener('click', () => {
            if (!previousAttacksEnabled) {
                setPreviousAttacksEnabled(true);
                attacksCheckbox.checked = true;
            } else {
                loadPreviousAttacks(true);
            }
        });

        keyWrapper.appendChild(keyInput);
        keyWrapper.appendChild(saveKeyButton);
        keyWrapper.appendChild(clearKeyButton);
        keyWrapper.appendChild(refreshAttacksButton);
        parent.appendChild(keyWrapper);

        attackStatusElement = document.createElement('div');
        attackStatusElement.textContent = previousAttacksEnabled
            ? (tornApiKey ? 'Previous Attacks enabled.' : 'Previous Attacks needs a Torn API key.')
            : 'Previous Attacks disabled.';
        attackStatusElement.style.color = '#cfe8ff';
        attackStatusElement.style.fontSize = '11px';
        attackStatusElement.style.marginTop = '5px';
        attackStatusElement.style.lineHeight = '1.35';
        parent.appendChild(attackStatusElement);

        appendDivider(parent);
        appendSectionTitle(parent, 'Torn Theme');

        const themeWrapper = document.createElement('label');
        themeWrapper.style.color = 'white';
        themeWrapper.style.fontSize = '12px';
        themeWrapper.style.display = 'inline-flex';
        themeWrapper.style.alignItems = 'center';

        const themeCheckbox = document.createElement('input');
        themeCheckbox.type = 'checkbox';
        themeCheckbox.checked = themeSyncEnabled;
        themeCheckbox.style.marginRight = '5px';
        themeCheckbox.addEventListener('change', (event) => {
            setThemeSyncEnabled(event.target.checked);
        });

        themeWrapper.appendChild(themeCheckbox);
        themeWrapper.appendChild(document.createTextNode('Sync Torn theme with system'));
        parent.appendChild(themeWrapper);

        themeSyncStatusElement = document.createElement('div');
        themeSyncStatusElement.textContent = themeSyncEnabled ? 'Theme sync enabled.' : 'Theme sync disabled.';
        themeSyncStatusElement.style.color = '#cfe8ff';
        themeSyncStatusElement.style.fontSize = '11px';
        themeSyncStatusElement.style.marginTop = '5px';
        themeSyncStatusElement.style.lineHeight = '1.35';
        parent.appendChild(themeSyncStatusElement);
    }

    function createUi() {
        injectStyles();

        const toggleButton = document.createElement('button');
        toggleButton.textContent = 'HCW';
        toggleButton.title = 'hoggson\'s Chain Watcher';
        toggleButton.style.position = 'fixed';
        toggleButton.style.top = '5%';
        toggleButton.style.right = '10px';
        toggleButton.style.zIndex = '10001';
        toggleButton.style.backgroundColor = '#28a745';
        toggleButton.style.color = 'white';
        toggleButton.style.border = 'none';
        toggleButton.style.padding = '3px 8px';
        toggleButton.style.borderRadius = '4px';
        toggleButton.style.cursor = 'pointer';
        toggleButton.style.display = 'flex';
        toggleButton.style.alignItems = 'center';

        const icon = document.createElement('img');
        icon.src = 'https://hoggson.co.uk/hcw/chainwatch.ico';
        icon.alt = '';
        icon.title = 'Open easy target';
        icon.style.width = '16px';
        icon.style.height = '16px';
        icon.style.marginRight = '5px';
        toggleButton.prepend(icon);
        document.body.appendChild(toggleButton);

        icon.addEventListener('mouseenter', () => {
            icon.src = 'https://hoggson.co.uk/hcw/chainwatchtarget.ico';
        });
        icon.addEventListener('mouseleave', () => {
            icon.src = 'https://hoggson.co.uk/hcw/chainwatch.ico';
        });
        icon.addEventListener('click', (event) => {
            event.stopPropagation();
            openRandomTarget();
        });

        const popup = document.createElement('div');
        popup.style.position = 'fixed';
        popup.style.top = `calc(${toggleButton.style.top} + 35px)`;
        popup.style.right = '10px';
        popup.style.zIndex = '10000';
        popup.style.background = 'rgba(0,0,0,0.8)';
        popup.style.padding = '8px';
        popup.style.borderRadius = '6px';
        popup.style.display = 'none';
        popup.style.maxWidth = '520px';
        document.body.appendChild(popup);

        createControls(popup);

        toggleButton.addEventListener('click', () => {
            popup.style.display = popup.style.display === 'none' ? 'block' : 'none';
        });
    }

    window.addEventListener('beforeunload', () => {
        if (isCurrentLeader()) {
            localStorage.removeItem(SOUND_LEADER_KEY);
        }
    });

    window.addEventListener('storage', (event) => {
        if (event.key !== SOUND_LEADER_KEY) return;
        maintainSoundLeadership();
    });

    onReady(() => {
        createUi();
        if (previousAttacksEnabled) showAttackBox();
        if (themeSyncEnabled) {
            ensureThemeSyncListener();
            syncThemeToSystem();
        }
        checkChainTimer();
        setInterval(checkChainTimer, 2000);
        setInterval(maintainSoundLeadership, 2000);
    });
})();
