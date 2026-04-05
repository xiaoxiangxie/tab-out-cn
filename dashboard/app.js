/* ================================================================
   Tab Mission Control — Dashboard App

   This file is the brain of the dashboard. It:
   1. Talks to the Chrome extension (to read/close actual browser tabs)
   2. Fetches mission data from our Express server (/api/missions)
   3. Renders mission cards, banners, stats, and the scatter meter
   4. Handles all user actions (close tabs, archive, dismiss, focus)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   EXTENSION BRIDGE

   The dashboard runs in an iframe inside the Chrome extension's
   new-tab page. To communicate with the extension's background
   script, we use window.postMessage — the extension's content
   script listens and relays messages.

   When running in a regular browser tab (dev mode), we gracefully
   fall back without crashing.
   ---------------------------------------------------------------- */

// Track whether the extension is actually available (set after first successful call)
let extensionAvailable = false;

// Track all open tabs fetched from the extension (array of tab objects)
let openTabs = [];

/**
 * sendToExtension(action, data)
 *
 * Sends a message to the parent frame (the Chrome extension) and
 * waits up to 3 seconds for a response.
 *
 * Think of it like sending a text message and waiting for a reply —
 * if no reply comes in 3 seconds, we give up gracefully.
 */
function sendToExtension(action, data = {}) {
  return new Promise((resolve) => {
    // If we're not inside an iframe, there's no extension to talk to
    if (window.parent === window) {
      resolve({ success: false, reason: 'not-in-extension' });
      return;
    }

    // Generate a random ID so we can match the response to this specific request
    const messageId = 'tmc-' + Math.random().toString(36).slice(2);

    // Set a 3-second timeout in case the extension doesn't respond
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, 3000);

    // Listen for the matching response from the extension
    function handler(event) {
      if (event.data && event.data.messageId === messageId) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    }

    window.addEventListener('message', handler);

    // Send the message to the parent frame (extension)
    window.parent.postMessage({ action, messageId, ...data }, '*');
  });
}

/**
 * fetchOpenTabs()
 *
 * Asks the extension for the list of currently open browser tabs.
 * Sets extensionAvailable = true if it works, false otherwise.
 */
async function fetchOpenTabs() {
  const result = await sendToExtension('getTabs');
  if (result && result.success && Array.isArray(result.tabs)) {
    openTabs = result.tabs;
    extensionAvailable = true;
  } else {
    openTabs = [];
    extensionAvailable = false;
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Tells the extension to close all tabs matching the given URLs.
 * After closing, we re-fetch the tab list so our state stays accurate.
 */
async function closeTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await sendToExtension('closeTabs', { urls });
  // Refresh our local tab list to reflect what was closed
  await fetchOpenTabs();
}

/**
 * focusTabsByUrls(urls)
 *
 * Tells the extension to bring the first matching tab into focus
 * (switch to that tab in Chrome). Used by the "Focus on this" button.
 */
async function focusTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await sendToExtension('focusTabs', { urls });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * showToast(message)
 *
 * Shows a brief pop-up notification at the bottom of the screen.
 * Like the little notification that pops up when you send a message.
 */
/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — this creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 *
 * Each particle:
 * - Is either a circle or a square (randomly chosen)
 * - Uses the dashboard's color palette: amber, sage, slate, with some light variants
 * - Flies outward in a random direction with a gravity arc
 * - Fades out over ~800ms, then is removed from the DOM
 *
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  // Color palette drawn from the dashboard's CSS variables
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    // Randomly decide: circle or square
    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px

    // Pick a random color from the palette
    const color = colors[Math.floor(Math.random() * colors.length)];

    // Style the particle
    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle  = Math.random() * Math.PI * 2;           // random direction (radians)
    const speed  = 60 + Math.random() * 120;              // px/second
    const vx     = Math.cos(angle) * speed;               // horizontal velocity
    const vy     = Math.sin(angle) * speed - 80;          // vertical: bias upward a bit
    const gravity = 200;                                   // downward pull (px/s²)

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200;          // 700–900ms

    // Animate with requestAnimationFrame for buttery-smooth motion
    function frame(now) {
      const elapsed = (now - startTime) / 1000; // seconds
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) {
        el.remove();
        return;
      }

      // Position: initial velocity + gravity arc
      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;

      // Fade out during the second half of the animation
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;

      // Slight rotation for realism
      const rotate = elapsed * 200 * (isCircle ? 0 : 1); // squares spin, circles don't

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card in two phases:
 * 1. Fade out + scale down (GPU-accelerated, smooth)
 * 2. After fade completes, remove from DOM
 *
 * Also fires confetti from the card's center for a satisfying "done!" moment.
 */
function animateCardOut(card) {
  if (!card) return;

  // Get the card's center position on screen for the confetti origin
  const rect = card.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;

  // Shoot confetti from the card's center
  shootConfetti(cx, cy);

  // Phase 1: fade + scale down
  card.classList.add('closing');
  // Phase 2: remove from DOM after animation
  setTimeout(() => {
    card.remove();
    // After card is gone, check if the missions grid is now empty
    // and show the empty state if so
    checkAndShowEmptyState();
  }, 300);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Called after each card is removed from the DOM. If all mission cards
 * are gone (the grid is empty), we swap in a fun empty state instead of
 * showing a blank, lifeless grid.
 *
 * Only activates in AI view (isAIView = true), since the static domain
 * view handles its own zero-tabs case separately.
 */
function checkAndShowEmptyState() {
  if (!isAIView) return;

  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  // Count remaining mission cards (excludes anything already animating out)
  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  // All missions are gone — show the empty state
  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  // Update the section count to reflect the clear state
  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 missions';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * e.g. "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';

  const then = new Date(dateStr);
  const now = new Date();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting()
 *
 * Returns an appropriate greeting based on the current hour.
 * Morning = before noon, Afternoon = noon–5pm, Evening = after 5pm.
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning, Zara';
  if (hour < 17) return 'Good afternoon, Zara';
  return 'Good evening, Zara';
}

/**
 * getDateDisplay()
 *
 * Returns a formatted date string like "Friday, April 4, 2026".
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * countOpenTabsForMission(missionUrls)
 *
 * Counts how many of the user's currently open browser tabs
 * match any of the URLs associated with a mission.
 *
 * We match by domain (hostname) rather than exact URL, because
 * the exact URL often changes (e.g. page IDs, session tokens).
 */
function countOpenTabsForMission(missionUrls) {
  return getOpenTabsForMission(missionUrls).length;
}

/**
 * getOpenTabsForMission(missionUrls)
 *
 * Returns the actual tab objects from openTabs that match
 * any URL in the mission's URL list (matched by domain).
 */
function getOpenTabsForMission(missionUrls) {
  if (!missionUrls || missionUrls.length === 0 || openTabs.length === 0) return [];

  // Extract the domains from the mission's saved URLs
  // missionUrls can be either URL strings or objects with a .url property
  const missionDomains = missionUrls.map(item => {
    const urlStr = (typeof item === 'string') ? item : (item.url || '');
    try {
      return new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr).hostname;
    } catch {
      return urlStr;
    }
  });

  // Find open tabs whose hostname matches any mission domain
  return openTabs.filter(tab => {
    try {
      const tabDomain = new URL(tab.url).hostname;
      return missionDomains.some(d => tabDomain.includes(d) || d.includes(tabDomain));
    } catch {
      return false;
    }
  });
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS

   We store these as a constant so we can reuse them in buttons
   without writing raw SVG every time. Each value is an HTML string
   ready to be injected with innerHTML.
   ---------------------------------------------------------------- */
const ICONS = {
  // Tab/browser icon — used in the "N tabs open" badge
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,

  // X / close icon — used in "Close N tabs" button
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,

  // Archive / trash icon — used in "Close & archive" button
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,

  // Arrow up-right — used in "Focus on this" button
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`
};


/* ----------------------------------------------------------------
   MISSION CARD RENDERERS

   Two distinct renderers for the two sections:

   1. renderOpenTabsMissionCard() — for "Right now" section.
      Shows currently open tabs as chips. Has "Close all" button.
      These missions come from /api/cluster-tabs (ephemeral, live).

   2. renderHistoryMissionCard() — for "Pick back up" section.
      Lighter/smaller treatment. Has "Reopen" link.
      These missions come from /api/history-missions (from the DB).
   ---------------------------------------------------------------- */

/**
 * renderOpenTabsMissionCard(mission, missionIndex)
 *
 * Builds the HTML for a single "Right now" mission card.
 * The mission object comes from /api/cluster-tabs and has this shape:
 *   { name, summary, tabs: [{ url, title, tabId }] }
 *
 * @param {Object} mission      - Mission object from cluster-tabs API
 * @param {number} missionIndex - 0-based index, used as a fallback ID
 * @returns {string}            - HTML string ready for innerHTML
 */
function renderOpenTabsMissionCard(mission, missionIndex) {
  const tabs = mission.tabs || [];
  const tabCount = tabs.length;

  // Tab count badge — always shown since every card has open tabs by definition
  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  // Check if any tabs in this mission are duplicates
  const dupeMap = window._dupeUrlMap || {};
  const missionHasDupes = tabs.some(t => dupeMap[t.url]);

  // Page chips — one per actual open tab (up to 5 shown, rest summarized)
  const visibleTabs = tabs.slice(0, 5);
  const extraCount  = tabs.length - visibleTabs.length;
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const dupeCount = dupeMap[tab.url];
    const dupeTag = dupeCount ? ` <span style="color:var(--accent-amber);font-weight:600">(${dupeCount}x)</span>` : '';
    return `<span class="page-chip clickable" data-action="focus-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="${label.replace(/"/g, '&quot;')}">${display}${dupeTag}</span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip">+${extraCount} more</span>` : '');

  // Use a stable ID based on mission name (not array index, which shifts when
  // earlier missions are closed). This way closing mission #2 doesn't break
  // the button on mission #5.
  const stableId = mission._stableId || missionIndex;

  // Get duplicate URLs that belong to this mission
  const missionDupeUrls = tabs.filter(t => dupeMap[t.url]).map(t => t.url);
  const uniqueDupeUrls = [...new Set(missionDupeUrls)];

  let actionsHtml = '';
  if (tabCount > 0) {
    actionsHtml += `
      <button class="action-btn close-tabs" data-action="close-open-tabs" data-open-mission-id="${stableId}">
        ${ICONS.close}
        Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
      </button>`;
  }
  if (uniqueDupeUrls.length > 0) {
    const extraDupes = uniqueDupeUrls.reduce((s, u) => s + dupeMap[u] - 1, 0);
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${uniqueDupeUrls.map(u => encodeURIComponent(u)).join(',')}">
        Close ${extraDupes} duplicate${extraDupes !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card has-active-bar" data-open-mission-id="${stableId}">
      <div class="status-bar active"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag active">Open</span>
          ${tabBadge}
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="mission-pages">${pageChips}</div>
        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}

/**
 * renderHistoryMissionCard(mission)
 *
 * Builds the HTML for a single "Pick back up" history card.
 * Lighter visual treatment — smaller, no status bar color, just info + reopen.
 * The mission object comes from /api/history-missions and has the DB shape:
 *   { id, name, summary, status, last_activity, urls: [{ url, title }] }
 *
 * @param {Object} mission - Mission object from history-missions API
 * @returns {string}       - HTML string ready for innerHTML
 */
function renderHistoryMissionCard(mission) {
  const pageCount = (mission.urls || []).length;

  // Status-based age tag (e.g. "2 days cold", "1 week cold")
  const ageLabel = timeAgo(mission.last_activity)
    .replace(' ago', '')
    .replace('yesterday', '1 day')
    .replace(' hrs', 'h')
    .replace(' hr', 'h')
    .replace(' min', 'm');

  return `
    <div class="mission-card history-card" data-mission-id="${mission.id}">
      <div class="status-bar abandoned"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag abandoned">${ageLabel} ago</span>
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="actions">
          <button class="action-btn primary" data-action="focus" data-mission-id="${mission.id}">
            ${ICONS.focus}
            Reopen
          </button>
          <button class="action-btn danger" data-action="dismiss" data-mission-id="${mission.id}">
            Let it go
          </button>
        </div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${pageCount}</div>
        <div class="mission-page-label">pages</div>
      </div>
    </div>`;
}

// Keep the old renderMissionCard() for any legacy use (e.g. handleCloseAllStale)
// but it's no longer called by renderDashboard().
function renderMissionCard(mission, openTabCount) {
  const status = mission.status || 'active';
  const statusBarClass = status;
  let tagLabel = '';
  if (status === 'active') {
    tagLabel = 'Active';
  } else {
    tagLabel = timeAgo(mission.last_activity)
      .replace(' ago', '')
      .replace('yesterday', '1 day')
      .replace(' hrs', 'h')
      .replace(' hr', 'h')
      .replace(' min', 'm');
  }
  const tabBadge = openTabCount > 0
    ? `<span class="open-tabs-badge" data-mission-id="${mission.id}">${ICONS.tabs} ${openTabCount} tab${openTabCount !== 1 ? 's' : ''} open</span>`
    : '';
  const pages = (mission.urls || []).slice(0, 4);
  const pageChips = pages.map(page => {
    const label = page.title || page.url || page;
    const display = label.length > 40 ? label.slice(0, 40) + '…' : label;
    return `<span class="page-chip">${display}</span>`;
  }).join('');
  const pageCount = (mission.urls || []).length;
  const metaHtml = `<div class="mission-meta"><div class="mission-time">${timeAgo(mission.last_activity)}</div><div class="mission-page-count">${pageCount}</div><div class="mission-page-label">pages</div></div>`;
  return `
    <div class="mission-card" data-mission-id="${mission.id}">
      <div class="status-bar ${statusBarClass}"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag ${statusBarClass}">${tagLabel}</span>
          ${tabBadge}
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="mission-pages">${pageChips}</div>
      </div>
      ${metaHtml}
    </div>`;
}


/* ----------------------------------------------------------------
   SCATTER BAR RENDERER

   The scatter bar is the 10-dot "focus level" indicator in the
   top-right. It shows how spread out Zara's attention is across
   missions. More missions = more scatter = more dots filled = redder.
   ---------------------------------------------------------------- */

/**
 * renderScatterBar(missionCount)
 *
 * Fills the 10 scatter dots based on how many active missions exist.
 * Over 5 missions = "high scatter" (red dots).
 */
/**
 * renderScatterBar(tabCount, domainCount)
 *
 * Focus level is based on how many unique domains you're spread across.
 * The bar shows 10 dots scaled to the domain count.
 * 1-3 domains = focused (green), 4-6 = moderate (amber), 7+ = scattered (red)
 */
function renderScatterBar(tabCount, domainCount) {
  const barEl = document.getElementById('scatterBar');
  const captionEl = document.getElementById('scatterCaption');
  if (!barEl || !captionEl) return;

  const isHigh = domainCount > 6;
  const isMod = domainCount > 3;

  let dotsHtml = '';
  for (let i = 0; i < 10; i++) {
    const filled = i < Math.min(domainCount, 10);
    const highClass = filled && isHigh ? ' high' : '';
    dotsHtml += `<div class="scatter-dot${filled ? ' filled' : ''}${highClass}"></div>`;
  }
  barEl.innerHTML = dotsHtml;

  let level = 'focused';
  if (isHigh) level = 'scattered';
  else if (isMod) level = 'moderate';

  captionEl.textContent = `${tabCount} tab${tabCount !== 1 ? 's' : ''} across ${domainCount} site${domainCount !== 1 ? 's' : ''} — ${level}`;
  captionEl.style.color = isHigh ? 'var(--status-abandoned)' : isMod ? 'var(--accent-amber)' : 'var(--status-active)';
}


/**
 * renderPersonalMessage(message)
 *
 * Renders the AI's witty one-liner above the mission cards in the AI view.
 * This looks like a handwritten note or a quote — italic text with a warm
 * left border, referencing the actual tabs the user has open.
 *
 * The element it writes into (#aiPersonalMessage) is injected into the
 * section header area just above the missions grid. If the element doesn't
 * exist yet in the DOM, we create it and insert it there.
 *
 * If message is null or empty, we hide the element gracefully.
 */
function renderPersonalMessage(message) {
  // Find or create the personal message element.
  // We insert it right before the #openTabsMissions grid.
  let el = document.getElementById('aiPersonalMessage');
  if (!el) {
    el = document.createElement('div');
    el.id = 'aiPersonalMessage';
    // Insert before the missions grid
    const missionsEl = document.getElementById('openTabsMissions');
    if (missionsEl && missionsEl.parentNode) {
      missionsEl.parentNode.insertBefore(el, missionsEl);
    }
  }

  if (message) {
    el.className = 'ai-personal-message';
    // Use a left-open quotation mark as a decorative element, then the message text
    el.innerHTML = `<span class="ai-personal-message-quote">&ldquo;</span>${message}`;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB MISSIONS

   Because /api/cluster-tabs missions are ephemeral (not in the DB),
   we keep them in memory so the click handler can look them up when
   a "Close all" button is pressed.

   openTabMissions is repopulated every time renderAIDashboard() runs.
   domainGroups is populated by renderStaticDashboard().
   ---------------------------------------------------------------- */
let openTabMissions = [];
let duplicateTabs   = [];
let domainGroups    = []; // domain-grouped tabs for the static view
let currentPersonalMessage = null; // the AI's witty one-liner about the current tab set

// Tracks whether we're currently showing the AI view or the static view
let isAIView = false;


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   We call this in multiple places, so it lives in one spot.
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns all open tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc. We only want to show and manage actual websites.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER (for static default view)

   When we haven't asked AI to organize tabs yet, we group them
   by domain (e.g. all github.com tabs together) and show a card
   per domain. No AI required — pure JS.
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card in the static view.
 * "group" is: { domain, tabs: [{ url, title, tabId }] }
 *
 * Visually similar to renderOpenTabsMissionCard() but with a neutral
 * gray status bar (not green) and no AI-generated summary.
 */
function renderDomainCard(group, groupIndex) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Detect duplicates within this domain group (same URL multiple times)
  const urlCounts = {};
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  // Tab count badge
  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  // Duplicate warning badge
  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color: var(--accent-amber); background: rgba(200, 113, 58, 0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Page chips — show up to 5, flag duplicates with count and amber color
  // Deduplicate for display: show each URL once with a (Nx) badge if duplicated
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    }
  }
  const visibleTabs = uniqueTabs.slice(0, 5);
  const extraCount  = uniqueTabs.length - visibleTabs.length;
  const pageChips = visibleTabs.map(tab => {
    const label   = tab.title || tab.url || '';
    const display = label.length > 45 ? label.slice(0, 45) + '…' : label;
    const count   = urlCounts[tab.url];
    const dupeTag = count > 1
      ? ` <span style="color:var(--accent-amber);font-weight:600">(${count}x)</span>`
      : '';
    const chipStyle = count > 1 ? ' style="border-color: rgba(200, 113, 58, 0.3);"' : '';
    return `<span class="page-chip clickable"${chipStyle} data-action="focus-tab" data-tab-url="${(tab.url || '').replace(/"/g, '&quot;')}" title="${label.replace(/"/g, '&quot;')}">${display}${dupeTag}</span>`;
  }).join('') + (extraCount > 0 ? `<span class="page-chip">+${extraCount} more</span>` : '');

  // Use amber status bar if there are duplicates
  const statusBarClass = hasDupes ? 'active' : 'neutral';
  const statusBarStyle = hasDupes ? ' style="background: var(--accent-amber);"' : '';

  // Actions: always show close all, add "Close duplicates" if dupes exist
  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"${statusBarStyle}></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${group.domain}</span>
          <span class="mission-tag neutral">Domain</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERERS

   Two modes:
   1. renderStaticDashboard() — instant, no AI call. Groups tabs by domain.
      Shows "Most visited" sites from history. Offers "Organize with AI".
   2. renderAIDashboard()     — calls DeepSeek to cluster tabs into missions.
      Replaces the domain view with AI-curated mission cards.
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The default view. Loads instantly with no AI call:
 * 1. Paint greeting + date
 * 2. Fetch open tabs from the extension
 * 3. Check if there's a cache hit (tabs already organized) → skip to AI view
 * 4. Group tabs by domain (pure JS, no API)
 * 5. Fetch top sites from /api/stats
 * 6. Render domain cards + "Most visited" + "Organize with AI" button
 * 7. Update scatter bar + footer stats
 */
async function renderStaticDashboard() {
  isAIView = false;

  // --- Header: greeting + date ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  // ── Step 1: Fetch open tabs ───────────────────────────────────────────────
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // ── Step 2: Cache check — did we already organize these exact tabs? ───────
  // Build the same URL key the server uses: sorted tab URLs joined by |
  if (realTabs.length > 0) {
    const urlKey = realTabs.map(t => t.url).sort().join('|');
    try {
      const cacheRes = await fetch(`/api/cluster-tabs/cached?urlKey=${encodeURIComponent(urlKey)}`);
      if (cacheRes.ok) {
        const cacheData = await cacheRes.json();
        if (cacheData.cached && cacheData.missions && cacheData.missions.length > 0) {
          // We already have AI results for these exact tabs — go straight to AI view.
          // Pass personalMessage through so the quote is shown even on cache hit.
          console.log('[TMC] Cache hit on load — showing AI view immediately');
          await renderAIDashboard({
            cachedMissions: cacheData.missions,
            personalMessage: cacheData.personalMessage || null,
          });
          return;
        }
      }
    } catch (err) {
      console.warn('[TMC] Cache check failed:', err);
    }
  }

  // ── Step 3: Group open tabs by domain ────────────────────────────────────
  // This is pure JavaScript — no AI, no API calls. We extract the hostname
  // from each tab URL and group them together.
  domainGroups = [];
  const groupMap = {};
  for (const tab of realTabs) {
    try {
      const hostname = new URL(tab.url).hostname;
      if (!groupMap[hostname]) {
        groupMap[hostname] = { domain: hostname, tabs: [] };
      }
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }
  // Sort groups by tab count (most tabs first)
  domainGroups = Object.values(groupMap).sort((a, b) => b.tabs.length - a.tabs.length);

  // ── Step 4: Render domain cards ───────────────────────────────────────────
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.textContent = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`;
    openTabsMissionsEl.innerHTML = domainGroups
      .map((g, idx) => renderDomainCard(g, idx))
      .join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // ── Step 5: Show "Organize with AI" button ────────────────────────────────
  // Only show if there are actually tabs to organize
  const aiBar = document.getElementById('aiOrganizeBar');
  if (aiBar) {
    aiBar.style.display = realTabs.length > 0 ? 'block' : 'none';
  }

  // ── Step 6: Fetch + render top sites ─────────────────────────────────────
  try {
    const statsRes = await fetch('/api/stats');
    if (statsRes.ok) {
      const stats = await statsRes.json();

      // Render top sites section
      const topSitesSection = document.getElementById('topSitesSection');
      const topSitesGrid    = document.getElementById('topSitesGrid');
      const lastRefreshEl   = document.getElementById('lastRefreshTime');

      if (stats.topSites && stats.topSites.length > 0 && topSitesSection) {
        topSitesGrid.innerHTML = stats.topSites.map(site => `
          <a class="top-site-tile" href="${site.domain.startsWith('http') ? site.domain : 'https://' + site.domain}" target="_blank" rel="noopener">
            <div class="top-site-icon">
              <img src="https://www.google.com/s2/favicons?domain=${site.domain}&sz=32" alt="" loading="lazy" onerror="this.style.display='none'">
            </div>
            <div class="top-site-name">${site.domain.replace(/^www\./, '')}</div>
            <div class="top-site-visits">${site.visitCount.toLocaleString()} visits</div>
          </a>
        `).join('');
        topSitesSection.style.display = 'block';
      } else if (topSitesSection) {
        topSitesSection.style.display = 'none';
      }

      if (lastRefreshEl) {
        lastRefreshEl.textContent = stats.lastAnalysis
          ? `History last analyzed ${timeAgo(stats.lastAnalysis)}`
          : 'History not yet analyzed';
      }
    }
  } catch (err) {
    console.warn('[TMC] Could not fetch stats:', err);
  }

  // ── Step 7: Footer stats (scatter bar removed) ───────────────────────────

  // ── Step 8: Footer stats ─────────────────────────────────────────────────
  const statMissions = document.getElementById('statMissions');
  const statTabs     = document.getElementById('statTabs');
  const statStale    = document.getElementById('statStale');
  if (statMissions) statMissions.textContent = domainGroups.length;
  if (statTabs)     statTabs.textContent     = openTabs.length;
  if (statStale)    statStale.textContent    = '—';

  // Hide cleanup banner in static view (we don't have AI missions to compare against)
  const cleanupBanner = document.getElementById('cleanupBanner');
  if (cleanupBanner) cleanupBanner.style.display = 'none';

  // Hide nudge banner
  const nudgeBanner = document.getElementById('nudgeBanner');
  if (nudgeBanner) nudgeBanner.style.display = 'none';
}


/**
 * renderAIDashboard(options)
 *
 * The AI-powered view. Called when the user clicks "Organize with AI"
 * (or instantly on load if the cache already has results for these tabs).
 *
 * options.cachedMissions — if provided, use these missions instead of calling the API.
 *                          This is how we use the cache hit path.
 *
 * What it does:
 * 1. Show loading state on the button
 * 2. Call POST /api/cluster-tabs (or use cached missions)
 * 3. Replace domain cards with AI mission cards
 * 4. Hide "Most visited" and "Organize with AI" button
 * 5. Update scatter bar + footer stats
 */
async function renderAIDashboard(options = {}) {
  isAIView = true;

  // Ensure we have fresh open tabs
  if (openTabs.length === 0) {
    await fetchOpenTabs();
  }
  const realTabs = getRealTabs();

  // ── Show loading state on the AI button ───────────────────────────────────
  const aiBar          = document.getElementById('aiOrganizeBar');
  const aiBtnTextEl    = document.getElementById('aiOrganizeBtnText');
  if (aiBtnTextEl) aiBtnTextEl.textContent = 'Organizing…';
  const aiBtn = document.getElementById('aiOrganizeBtn');
  if (aiBtn) {
    aiBtn.disabled = true;
    aiBtn.classList.add('loading');
  }

  openTabMissions        = []; // reset in-memory store
  duplicateTabs          = [];
  currentPersonalMessage = null;

  // ── Fetch or reuse missions ───────────────────────────────────────────────
  if (options.cachedMissions) {
    // Cache hit path — no API call needed
    openTabMissions = options.cachedMissions.map((m, i) => ({
      ...m,
      _stableId: m.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40) || `mission-${i}`,
    }));
    // Cache hit also passes personalMessage if the server had it cached
    currentPersonalMessage = options.personalMessage || null;
  } else if (extensionAvailable && realTabs.length > 0) {
    // Call DeepSeek via our server
    try {
      const clusterRes = await fetch('/api/cluster-tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabs: realTabs }),
      });

      if (clusterRes.ok) {
        const clusterData = await clusterRes.json();
        openTabMissions = (clusterData.missions || []).map((m, i) => ({
          ...m,
          _stableId: m.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40) || `mission-${i}`,
        }));
        duplicateTabs          = clusterData.duplicates || [];
        currentPersonalMessage = clusterData.personalMessage || null;
      }
    } catch (err) {
      console.warn('[TMC] Could not cluster open tabs:', err);
    }
  }

  // Build dupe URL map for the card renderer
  const dupeUrlMap = {};
  duplicateTabs.forEach(d => { dupeUrlMap[d.url] = d.count; });
  window._dupeUrlMap = dupeUrlMap;

  // ── Render the AI mission cards ───────────────────────────────────────────
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (openTabMissions.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Right now';
    openTabsSectionCount.textContent = `${openTabMissions.length} mission${openTabMissions.length !== 1 ? 's' : ''}`;
    openTabsMissionsEl.innerHTML = openTabMissions
      .map((m, idx) => renderOpenTabsMissionCard(m, idx))
      .join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // ── Render the personal message above the mission cards ───────────────────
  // This is the AI's witty one-liner based on the tab contents.
  // We inject it into a dedicated element that sits just above the missions grid.
  // If there's no message (e.g. an older cache entry), we hide it gracefully.
  renderPersonalMessage(currentPersonalMessage);

  // ── Hide static-only UI elements ─────────────────────────────────────────
  if (aiBar) aiBar.style.display = 'none';
  const topSitesSection = document.getElementById('topSitesSection');
  if (topSitesSection) topSitesSection.style.display = 'none';

  // ── Stale tabs ─────────────────────────────────────────────────────────────
  const clusteredTabUrls = new Set(
    openTabMissions.flatMap(m => (m.tabs || []).map(t => t.url))
  );
  const staleTabs = realTabs.filter(t => !clusteredTabUrls.has(t.url));

  const cleanupBanner = document.getElementById('cleanupBanner');
  if (staleTabs.length > 0 && cleanupBanner) {
    document.getElementById('staleTabCount').textContent =
      `${staleTabs.length} stale tab${staleTabs.length !== 1 ? 's' : ''}`;
    cleanupBanner.style.display = 'flex';
  } else if (cleanupBanner) {
    cleanupBanner.style.display = 'none';
  }

  // Hide nudge banner
  const nudgeBanner = document.getElementById('nudgeBanner');
  if (nudgeBanner) nudgeBanner.style.display = 'none';

  // ── Footer stats ───────────────────────────────────────────────────────────
  const statMissions = document.getElementById('statMissions');
  const statTabs     = document.getElementById('statTabs');
  const statStale    = document.getElementById('statStale');
  if (statMissions) statMissions.textContent = openTabMissions.length;
  if (statTabs)     statTabs.textContent     = openTabs.length;
  if (statStale)    statStale.textContent    = staleTabs.length;

  // Last refresh time
  const lastRefreshEl = document.getElementById('lastRefreshTime');
  if (lastRefreshEl) {
    try {
      const statsRes = await fetch('/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        lastRefreshEl.textContent = stats.lastAnalysis
          ? `History last analyzed ${timeAgo(stats.lastAnalysis)}`
          : 'History not yet analyzed';
      } else {
        lastRefreshEl.textContent = 'History not yet analyzed';
      }
    } catch {
      lastRefreshEl.textContent = 'History not yet analyzed';
    }
  }
}


/**
 * renderDashboard()
 *
 * Legacy entry point — now just calls renderStaticDashboard().
 * Keeping this name so any existing references (e.g. handleRefresh) still work.
 */
async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS (using event delegation)

   Instead of attaching a listener to every button, we attach ONE
   listener to the whole document and check what was clicked.
   This is more efficient and works even after we re-render cards.

   Think of it like one security guard watching the whole building
   instead of one guard per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM from the clicked element to find the nearest
  // element with a data-action attribute
  const actionEl = e.target.closest('[data-action]');

  // --- "Organize with AI" button ---
  if (e.target.closest('#aiOrganizeBtn')) {
    e.preventDefault();
    await renderAIDashboard();
    return;
  }

  // --- Close all stale tabs button (in the cleanup banner) ---
  if (e.target.closest('#closeAllStaleBtn')) {
    e.preventDefault();
    await handleCloseAllStale();
    return;
  }

  // --- Refresh button (in the footer) ---
  if (e.target.closest('#refreshBtn')) {
    e.preventDefault();
    await handleRefresh();
    return;
  }

  if (!actionEl) return; // click wasn't on an action button

  const action    = actionEl.dataset.action;
  const missionId = actionEl.dataset.missionId;

  // Find the card element so we can animate it
  const card = actionEl.closest('.mission-card');

  // ---- focus-tab: switch to a specific open tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) {
      await sendToExtension('focusTab', { url: tabUrl });
    }
    return;
  }

  // ---- close-domain-tabs: close all tabs in a static domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    // Find the group by its stable ID
    const group = domainGroups.find(g => {
      const id = 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-');
      return id === domainId;
    });
    if (!group) return;

    const urls = group.tabs.map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory domain groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${group.domain}`);

    // Update footer tab count
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- close-all-dupes: close every duplicate tab ----

  // ---- dedup-keep-one: close extras but keep one copy of each ----
  if (action === 'dedup-keep-one') {
    // URLs come from the button's data attribute (per-mission duplicates)
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await sendToExtension('closeDuplicates', { urls, keepOne: true });
    playCloseSound();
    await fetchOpenTabs();

    // Remove the dupe button since they're cleaned up
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity = '0';
    setTimeout(() => actionEl.remove(), 200);

    showToast(`Closed duplicates, kept one copy each`);
    return;
  }

  // ---- close-open-tabs: close all tabs for an open-tab-clustered mission ----
  // These missions use a stable ID (based on name) so closing one doesn't
  // break buttons on others.
  if (action === 'close-open-tabs') {
    const stableId = actionEl.dataset.openMissionId;
    const mission = openTabMissions.find(m => m._stableId === stableId);
    if (!mission) return;

    const urls = (mission.tabs || []).map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate the card out — the mission is "done" once all tabs are closed
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory store so stale count stays accurate
    const idx = openTabMissions.indexOf(mission);
    if (idx !== -1) openTabMissions.splice(idx, 1);

    await updateStaleCount();
    showToast(`Closed tabs for "${mission.name}"`);
  }

  // ---- close-tabs: close all tabs belonging to a history mission ----
  else if (action === 'close-tabs') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Remove the badge from the card (no tabs left open)
    if (card) {
      const badge = card.querySelector('.open-tabs-badge');
      if (badge) {
        badge.style.transition = 'opacity 0.3s, transform 0.3s';
        badge.style.opacity = '0';
        badge.style.transform = 'scale(0.8)';
        setTimeout(() => badge.remove(), 300);
      }
      // Remove this specific close-tabs button
      actionEl.style.transition = 'opacity 0.2s';
      actionEl.style.opacity = '0';
      setTimeout(() => actionEl.remove(), 200);
    }

    // Update footer stale count
    await updateStaleCount();
    showToast(`Closed tabs for "${mission.name}"`);
  }

  // ---- archive: close tabs + mark mission as archived, then remove card ----
  else if (action === 'archive') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Tell the server to archive this mission
    try {
      await fetch(`/api/missions/${missionId}/archive`, { method: 'POST' });
    } catch (err) {
      console.warn('[TMC] Could not archive mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Archived "${mission.name}"`);
    await updateStaleCount();
  }

  // ---- dismiss: close tabs (if any), mark as dismissed, remove card ----
  else if (action === 'dismiss') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    // If tabs are open, close them first
    const tabCount = card
      ? (card.querySelector('.open-tabs-badge')?.textContent.match(/\d+/)?.[0] || 0)
      : 0;

    if (parseInt(tabCount) > 0) {
      const urls = (mission.urls || []).map(u => u.url);
      await closeTabsByUrls(urls);
    }

    // Tell the server this mission is dismissed
    try {
      await fetch(`/api/missions/${missionId}/dismiss`, { method: 'POST' });
    } catch (err) {
      console.warn('[TMC] Could not dismiss mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Let go of "${mission.name}"`);
    await updateStaleCount();
  }

  // ---- focus: bring the mission's tabs to the front ----
  else if (action === 'focus') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await focusTabsByUrls(urls);
    showToast(`Focused on "${mission.name}"`);
  }

  // ---- close-uncat: close uncategorized tabs by domain ----
  else if (action === 'close-uncat') {
    const domain = actionEl.dataset.domain;
    if (!domain) return;

    // Find all open tabs matching this domain and close them
    const tabsToClose = openTabs.filter(t => {
      try { return new URL(t.url).hostname === domain; }
      catch { return false; }
    });
    const urls = tabsToClose.map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate card removal
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }
    showToast(`Closed ${tabsToClose.length} tab${tabsToClose.length !== 1 ? 's' : ''} from ${domain}`);
    await updateStaleCount();
  }
});


/* ----------------------------------------------------------------
   ACTION HELPERS
   ---------------------------------------------------------------- */

/**
 * handleCloseAllStale()
 *
 * Closes all tabs that weren't assigned to any open-tab mission.
 * With the new architecture, "stale" means tabs that somehow slipped
 * through the AI clustering (shouldn't happen, but could with edge cases).
 */
async function handleCloseAllStale() {
  const realTabs = getRealTabs();

  // Stale tabs = open real tabs not in any clustered mission (AI view only).
  // In static view there's no AI grouping, so we fall back to no-op.
  const clusteredTabUrls = new Set(
    openTabMissions.flatMap(m => (m.tabs || []).map(t => t.url))
  );

  const staleUrls = realTabs
    .filter(t => !clusteredTabUrls.has(t.url))
    .map(t => t.url);

  if (staleUrls.length > 0) {
    await closeTabsByUrls(staleUrls);
  }

  playCloseSound();

  // Hide the cleanup banner
  const banner = document.getElementById('cleanupBanner');
  if (banner) {
    banner.style.transition = 'opacity 0.4s';
    banner.style.opacity = '0';
    setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
  }

  // Update footer stats
  const statStale = document.getElementById('statStale');
  const statTabs  = document.getElementById('statTabs');
  if (statStale) statStale.textContent = '0';
  if (statTabs)  statTabs.textContent  = openTabs.length;

  showToast('Closed all stale tabs. Breathing room restored.');
}

/**
 * handleRefresh()
 *
 * Triggers a fresh AI analysis of the browser history,
 * then re-renders the dashboard with the new data.
 */
async function handleRefresh() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.textContent = 'Refreshing…';
    refreshBtn.style.opacity = '0.5';
  }

  try {
    // Ask the server to re-read history + re-cluster missions
    await fetch('/api/missions/refresh', { method: 'POST' });
  } catch (err) {
    console.warn('[TMC] Refresh failed:', err);
  }

  // Re-render the full dashboard
  await renderDashboard();

  if (refreshBtn) {
    refreshBtn.textContent = 'Refresh now';
    refreshBtn.style.opacity = '1';
  }
}

/**
 * fetchMissionById(missionId)
 *
 * Fetches a single mission object by ID from the server.
 * We need this when handling button clicks, so we have the mission's
 * page URLs and name ready.
 *
 * Returns null if the fetch fails.
 */
async function fetchMissionById(missionId) {
  try {
    const res = await fetch('/api/missions');
    if (!res.ok) return null;
    const missions = await res.json();
    return missions.find(m => String(m.id) === String(missionId)) || null;
  } catch {
    return null;
  }
}

/**
 * updateStaleCount()
 *
 * Recalculates stale tabs after a close action and updates the footer + banner.
 * In the new architecture, stale = open real tabs not covered by any clustered mission.
 */
async function updateStaleCount() {
  await fetchOpenTabs(); // refresh our live tab list first

  const realTabs = getRealTabs();

  // Recalculate which tabs are "stale" (not in any open-tab mission)
  const clusteredTabUrls = new Set(
    openTabMissions.flatMap(m => (m.tabs || []).map(t => t.url))
  );

  const staleTabs = realTabs.filter(t => !clusteredTabUrls.has(t.url));

  // Update footer numbers
  const statStale = document.getElementById('statStale');
  const statTabs  = document.getElementById('statTabs');
  if (statStale) statStale.textContent = staleTabs.length;
  if (statTabs)  statTabs.textContent  = openTabs.length;

  // Update or hide the cleanup banner
  const staleTabCountEl = document.getElementById('staleTabCount');
  const cleanupBanner   = document.getElementById('cleanupBanner');
  if (staleTabs.length > 0) {
    if (staleTabCountEl) staleTabCountEl.textContent = `${staleTabs.length} stale tab${staleTabs.length !== 1 ? 's' : ''}`;
    if (cleanupBanner)   cleanupBanner.style.display = 'flex';
  } else {
    if (cleanupBanner) {
      cleanupBanner.style.transition = 'opacity 0.4s';
      cleanupBanner.style.opacity = '0';
      setTimeout(() => { cleanupBanner.style.display = 'none'; cleanupBanner.style.opacity = '1'; }, 400);
    }
  }
}


/* ----------------------------------------------------------------
   INITIALIZE

   When the page loads, paint the dashboard immediately.
   ---------------------------------------------------------------- */
renderDashboard();
