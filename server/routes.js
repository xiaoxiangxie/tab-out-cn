// server/routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Express API routes for Mission Control.
//
// Think of this file as the "front desk" of the app's backend. The browser
// sends requests here, and these routes figure out what data to fetch or what
// action to take, then send back a JSON response.
//
// Every endpoint path starts with /api/, so:
//   - The browser asks  →  GET /api/missions
//   - This file handles →  router.get('/missions', ...)
//   - The main server (index.js) mounts this router at /api
//
// All "prepared statements" from db.js follow the better-sqlite3 pattern:
//   - .all()    → returns an array of rows (for SELECT queries)
//   - .run()    → executes a write (INSERT / UPDATE / DELETE)
//   - .get()    → returns a single row or undefined
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

// Pull in the database prepared statements we need
const {
  getMissions,
  getMissionUrls,
  dismissMission,
  archiveMission,
  getMeta,
  db,
} = require('./db');

// Pull in the AI clustering functions
// analyzeBrowsingHistory() — reads Chrome history and creates missions for the DB
// clusterOpenTabs()        — clusters currently open tabs ephemerally (no DB)
const { analyzeBrowsingHistory, clusterOpenTabs } = require('./clustering');

// Pull in the history reader — we reuse its DB-reading pattern to query top sites
const { readRecentHistory } = require('./history-reader');

// An Express Router is like a mini-app: it holds a group of related routes.
// We export it and mount it on the main Express app in index.js.
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Refresh lock
//
// analyzeBrowsingHistory() can take 5-30 seconds (it calls an AI API).
// If the user clicks "Refresh" twice quickly, we don't want two simultaneous
// AI calls running at once — that would waste money and could corrupt the DB.
//
// This flag works like a "busy" sign on a bathroom door. If it's already
// flipped to true, new refresh requests get a 429 (Too Many Requests) response.
// ─────────────────────────────────────────────────────────────────────────────
let isRefreshing = false;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/missions
//
// Returns all non-dismissed missions, each with their URLs attached.
//
// The database stores missions and URLs in separate tables (a "one-to-many"
// relationship). This endpoint joins them together in JavaScript — we first
// fetch all missions, then for each mission, fetch its URLs and attach them
// as a `urls` property on the mission object.
//
// Response shape:
//   [
//     {
//       id: "abc123",
//       name: "Planning Tokyo Trip",
//       summary: "...",
//       status: "active",
//       last_activity: "2024-01-15T10:00:00Z",
//       urls: [
//         { id: 1, mission_id: "abc123", url: "https://...", title: "...", visit_count: 3 },
//         ...
//       ]
//     },
//     ...
//   ]
// ─────────────────────────────────────────────────────────────────────────────
router.get('/missions', (req, res) => {
  try {
    // Fetch all non-dismissed missions (ordered by status priority, then recency)
    const missions = getMissions.all();

    // For each mission, fetch its associated URLs and attach them
    const missionsWithUrls = missions.map(mission => ({
      ...mission,                                    // spread all mission fields
      urls: getMissionUrls.all({ id: mission.id }),  // attach urls array
    }));

    res.json(missionsWithUrls);
  } catch (err) {
    console.error('[routes] GET /missions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch missions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/refresh
//
// Triggers a fresh analysis of the user's Chrome browsing history.
// This calls DeepSeek AI and can take several seconds.
//
// Concurrency protection: if a refresh is already running (isRefreshing = true),
// we return HTTP 429 (Too Many Requests) immediately.
//
// Response: { success: true, count: <number of missions created> }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/refresh', async (req, res) => {
  // ── Concurrency guard ──────────────────────────────────────────────────────
  if (isRefreshing) {
    return res.status(429).json({
      error: 'A refresh is already in progress. Please wait.',
    });
  }

  // Flip the busy flag on before doing any async work
  isRefreshing = true;

  try {
    // Run the full analysis pipeline:
    //   1. Read Chrome history
    //   2. Filter + deduplicate URLs
    //   3. Call DeepSeek AI to cluster into missions
    //   4. Save missions + URLs to the SQLite database
    // Returns the array of mission objects that were saved
    const missions = await analyzeBrowsingHistory();

    res.json({ success: true, count: missions.length });
  } catch (err) {
    console.error('[routes] POST /missions/refresh failed:', err.message);
    res.status(500).json({ error: 'Refresh failed: ' + err.message });
  } finally {
    // Always flip the busy flag back off, even if an error occurred.
    // Without `finally`, a crash would leave isRefreshing = true forever,
    // blocking all future refreshes until the server restarts.
    isRefreshing = false;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/:id/dismiss
//
// Soft-deletes a mission by marking it dismissed = 1 in the database.
// The mission data is kept (for history) but it won't appear in the main list.
//
// :id is a URL parameter — e.g. POST /api/missions/abc123/dismiss
//
// Response: { success: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/:id/dismiss', (req, res) => {
  try {
    const { id } = req.params; // extract the mission ID from the URL

    // Run the UPDATE query: sets dismissed = 1 for this mission id
    dismissMission.run({ id });

    res.json({ success: true });
  } catch (err) {
    console.error('[routes] POST /missions/:id/dismiss failed:', err.message);
    res.status(500).json({ error: 'Failed to dismiss mission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/missions/:id/archive
//
// Saves a snapshot of the mission into the archives table, then dismisses it.
// Archiving is "dismiss + save a record". It's useful for reviewing what you
// worked on in the past — the archive keeps the name and URLs even after dismiss.
//
// Steps:
//   1. Find the mission by id (return 404 if not found)
//   2. Fetch its associated URLs
//   3. Insert a row into the archives table (mission + urls as JSON)
//   4. Dismiss the mission (soft-delete it from the active list)
//
// Response: { success: true }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/missions/:id/archive', (req, res) => {
  try {
    const { id } = req.params;

    // ── Step 1: Find the mission ───────────────────────────────────────────────
    // db.prepare().get() returns a single row object or undefined.
    // We need to check if the mission actually exists before archiving it.
    const mission = db
      .prepare('SELECT * FROM missions WHERE id = ? AND dismissed = 0')
      .get(id);

    if (!mission) {
      return res.status(404).json({ error: 'Mission not found or already dismissed' });
    }

    // ── Step 2: Fetch the mission's URLs ───────────────────────────────────────
    const urls = getMissionUrls.all({ id: mission.id });

    // ── Step 3: Insert into archives ───────────────────────────────────────────
    // We store the URLs as a JSON string (urls_json) because the archives table
    // only needs to display them as a list — we don't need to query individual
    // archived URLs. Storing as JSON keeps the archives table simple.
    archiveMission.run({
      mission_id:   mission.id,
      mission_name: mission.name,
      urls_json:    JSON.stringify(urls),      // array of URL objects → JSON string
      archived_at:  new Date().toISOString(),  // ISO timestamp of when archived
    });

    // ── Step 4: Dismiss the mission ────────────────────────────────────────────
    // This soft-deletes it from the active list (dismissed = 1).
    // We do this after archiving so we don't lose data if the archive insert fails.
    dismissMission.run({ id: mission.id });

    res.json({ success: true });
  } catch (err) {
    console.error('[routes] POST /missions/:id/archive failed:', err.message);
    res.status(500).json({ error: 'Failed to archive mission' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/stats
//
// Returns summary statistics about the current state of missions.
// Used by the dashboard header to show things like "14 missions, 3 abandoned".
//
// Response:
//   {
//     totalMissions:    14,   // non-dismissed missions
//     totalUrls:        87,   // total URLs across all active missions
//     abandonedMissions: 3,   // missions with status = 'abandoned'
//     lastAnalysis:     "2024-01-15T10:30:00Z"  // ISO timestamp (or null)
//   }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    // Count total non-dismissed missions
    // .get() returns a single row — here it's { count: 14 }
    const { count: totalMissions } = db
      .prepare('SELECT COUNT(*) as count FROM missions WHERE dismissed = 0')
      .get();

    // Count total URLs across all active (non-dismissed) missions
    // We join mission_urls to missions to only count URLs from active missions
    const { count: totalUrls } = db
      .prepare(`
        SELECT COUNT(*) as count
        FROM   mission_urls mu
        JOIN   missions m ON mu.mission_id = m.id
        WHERE  m.dismissed = 0
      `)
      .get();

    // Count missions with status = 'abandoned' (non-dismissed only)
    const { count: abandonedMissions } = db
      .prepare(`
        SELECT COUNT(*) as count
        FROM   missions
        WHERE  dismissed = 0
          AND  status    = 'abandoned'
      `)
      .get();

    // Get last_analysis timestamp from the meta key-value store
    // getMeta.get() returns { value: "2024-01-15T..." } or undefined if never run
    const metaRow = getMeta.get({ key: 'last_analysis' });
    const lastAnalysis = metaRow ? metaRow.value : null;

    // ── Top sites: 8 most-visited domains from Chrome history ─────────────────
    // We reuse the same "copy to temp, read readonly" pattern from history-reader.
    // This gives us a real-time snapshot of the user's most visited domains
    // without requiring any stored data in our own database.
    let topSites = [];
    try {
      const fs       = require('fs');
      const path     = require('path');
      const os       = require('os');
      const Database = require('better-sqlite3');

      const CHROME_HISTORY_PATH = path.join(
        os.homedir(),
        'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'History'
      );
      const TEMP_COPY_PATH = path.join(os.tmpdir(), 'mission-control-topsites-copy.db');

      if (fs.existsSync(CHROME_HISTORY_PATH)) {
        // Copy to temp to avoid Chrome's file lock
        fs.copyFileSync(CHROME_HISTORY_PATH, TEMP_COPY_PATH);

        let histDb = null;
        try {
          histDb = new Database(TEMP_COPY_PATH, { readonly: true, fileMustExist: true });

          // Pull every URL with its visit count, then aggregate by domain in JS.
          // We pull a reasonable cap (2000 rows) so the query stays fast.
          const rows = histDb.prepare(`
            SELECT url, title, visit_count
            FROM urls
            WHERE visit_count > 0
            ORDER BY visit_count DESC
            LIMIT 2000
          `).all();

          // Aggregate visit counts by hostname (domain)
          const domainMap = {};
          for (const row of rows) {
            try {
              const hostname = new URL(row.url).hostname;
              // Skip empty, chrome-internal, or extension pages
              if (!hostname || hostname.startsWith('chrome') || hostname === 'localhost') continue;

              if (!domainMap[hostname]) {
                domainMap[hostname] = { domain: hostname, visitCount: 0, title: '' };
              }
              domainMap[hostname].visitCount += row.visit_count;
              // Use the title from the highest-visit-count entry for this domain
              if (!domainMap[hostname].title && row.title) {
                domainMap[hostname].title = row.title;
              }
            } catch {
              // Skip malformed URLs
            }
          }

          // Sort by visit count descending, take top 8
          topSites = Object.values(domainMap)
            .sort((a, b) => b.visitCount - a.visitCount)
            .slice(0, 8);

        } finally {
          if (histDb) {
            try { histDb.close(); } catch { /* ignore */ }
          }
          try { fs.unlinkSync(TEMP_COPY_PATH); } catch { /* ignore */ }
        }
      }
    } catch (topSitesErr) {
      // Top sites is best-effort — don't fail the whole stats endpoint
      console.warn('[routes] GET /stats: could not read top sites:', topSitesErr.message);
    }

    res.json({
      totalMissions,
      totalUrls,
      abandonedMissions,
      lastAnalysis,
      topSites,
    });
  } catch (err) {
    console.error('[routes] GET /stats failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cluster-tabs
//
// NEW endpoint for the "Right now" section.
//
// Receives an array of currently open browser tabs from the dashboard,
// filters out chrome:// and extension pages, then asks DeepSeek to cluster
// them into missions. Results are NOT stored in the database — this is purely
// ephemeral, recalculated fresh on every page load.
//
// Request body:  { tabs: [{ url, title, tabId }] }
// Response body: { missions: [{ name, summary, tabs: [{ url, title, tabId }] }] }
// ─────────────────────────────────────────────────────────────────────────────
// Cache for tab clustering — avoids calling DeepSeek if tabs haven't changed.
// We also cache the personalMessage alongside the missions so a cache hit
// can still show the witty one-liner without an extra AI call.
let clusterCache = { urlKey: '', result: null, personalMessage: null };

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/cluster-tabs/cached
//
// Returns the cached clustering result WITHOUT triggering a new AI call.
// The dashboard sends the computed urlKey (sorted URLs joined by |) as a
// query parameter. If our cache matches, we return the result immediately.
// If there's no cache or the key doesn't match, we return { cached: false }.
//
// This lets the dashboard check "did we already organize these tabs?" on load
// without spending API credits.
//
// Query param: ?urlKey=<sorted-urls-joined-by-pipe>
// Response:    { cached: true, missions: [...], duplicates: [...] }
//           or { cached: false }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/cluster-tabs/cached', (req, res) => {
  const { urlKey } = req.query;

  // If we have a cached result AND it matches the current tab set, return it.
  // We pass personalMessage through too so the UI can show the AI's witty note.
  if (urlKey && clusterCache.urlKey === urlKey && clusterCache.result) {
    console.log('[routes] GET /cluster-tabs/cached — cache hit');
    return res.json({
      cached: true,
      missions: clusterCache.result,
      personalMessage: clusterCache.personalMessage || null,
    });
  }

  // No match — tell the dashboard it needs to call POST /cluster-tabs
  console.log('[routes] GET /cluster-tabs/cached — cache miss');
  res.json({ cached: false });
});

router.post('/cluster-tabs', async (req, res) => {
  const { tabs } = req.body;

  if (!Array.isArray(tabs) || tabs.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty tabs array.' });
  }

  // Filter out browser-internal pages
  const filteredTabs = tabs.filter(tab => {
    const url = tab.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://') &&
      url.length > 0
    );
  });

  if (filteredTabs.length === 0) {
    return res.json({ missions: [], duplicates: [] });
  }

  // Detect duplicate tabs (same URL open multiple times)
  const urlCounts = {};
  for (const tab of filteredTabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }
  const duplicates = Object.entries(urlCounts)
    .filter(([, count]) => count > 1)
    .map(([url, count]) => {
      const tab = filteredTabs.find(t => t.url === url);
      return { url, title: tab.title, count };
    });

  // Cache key: sorted URLs joined — if tabs haven't changed, skip the API call
  const urlKey = filteredTabs.map(t => t.url).sort().join('|');

  if (clusterCache.urlKey === urlKey && clusterCache.result) {
    console.log('[routes] Tab clustering cache hit — skipping DeepSeek call');
    return res.json({
      missions: clusterCache.result,
      duplicates,
      personalMessage: clusterCache.personalMessage || null,
    });
  }

  try {
    // clusterOpenTabs now returns { missions, personalMessage }
    const { missions, personalMessage } = await clusterOpenTabs(filteredTabs);
    // Cache both the missions and the personalMessage
    clusterCache = { urlKey, result: missions, personalMessage: personalMessage || null };
    res.json({ missions, duplicates, personalMessage: personalMessage || null });
  } catch (err) {
    console.error('[routes] POST /cluster-tabs failed:', err.message);
    res.status(500).json({ error: 'Failed to cluster tabs: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/history-missions
//
// NEW endpoint for the "Pick back up" section.
//
// Returns missions from the SQLite database (history-based ones created by
// analyzeBrowsingHistory()), but ONLY those where NONE of the mission's URLs
// match any currently open tab URL. This prevents showing a mission in both
// "Right now" AND "Pick back up" at the same time.
//
// Query param: ?openUrls=https://example.com,https://other.com (comma-separated)
// The dashboard passes the URLs of all currently open tabs so we can filter.
//
// Response: same shape as GET /api/missions (array of mission objects with urls)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history-missions', (req, res) => {
  try {
    // Parse the comma-separated openUrls query param into a Set for fast lookups.
    // A Set is like a list but with super-fast "does this exist?" checks.
    const rawOpenUrls = req.query.openUrls || '';
    const openUrlSet = new Set(
      rawOpenUrls
        .split(',')
        .map(u => u.trim())
        .filter(Boolean)
    );

    // Fetch all non-dismissed missions from the database
    const allMissions = getMissions.all();

    // For each mission, attach its URLs — then filter out any mission whose
    // URLs overlap with the currently open tabs.
    const historyMissions = allMissions
      .map(mission => ({
        ...mission,
        urls: getMissionUrls.all({ id: mission.id }),
      }))
      .filter(mission => {
        // Keep this mission ONLY if none of its URLs are currently open.
        // "Currently open" is checked by exact URL match and by domain match,
        // since open tabs and history URLs might differ slightly in path/params.
        const hasOpenTab = mission.urls.some(urlRow => {
          const missionUrl = urlRow.url || '';

          // First: exact URL match
          if (openUrlSet.has(missionUrl)) return true;

          // Second: domain match — if any open tab is from the same hostname,
          // consider this mission as "currently active" and exclude it from history.
          try {
            const missionHostname = new URL(missionUrl).hostname;
            for (const openUrl of openUrlSet) {
              try {
                const openHostname = new URL(openUrl).hostname;
                if (openHostname === missionHostname) return true;
              } catch { /* skip malformed URLs */ }
            }
          } catch { /* skip malformed mission URLs */ }

          return false;
        });

        // hasOpenTab = true means the mission IS open right now → exclude it
        return !hasOpenTab;
      });

    // Return at most 5 history missions (the "Pick back up" section is secondary)
    const limited = historyMissions.slice(0, 5);

    res.json(limited);
  } catch (err) {
    console.error('[routes] GET /history-missions failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch history missions' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Export
//
// The main Express app (index.js) does:
//   const routes = require('./routes');
//   app.use('/api', routes);
//
// That mounts all of our router.get('/missions') etc. at /api/missions.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = router;
