// server/clustering.js
// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek AI clustering for browsing history.
//
// This is the "brain" of Mission Control. It takes your recent browsing
// history, sends it to DeepSeek (an AI model), and asks it to group the URLs
// into meaningful "missions" — clusters of intent like "researching AI tools"
// or "planning Tokyo trip".
//
// Think of it like asking a smart assistant to look at a pile of papers on
// your desk and organize them into labeled folders.
//
// The module uses the `openai` npm package pointed at DeepSeek's API, because
// DeepSeek is compatible with OpenAI's API format — same client, different URL.
// ─────────────────────────────────────────────────────────────────────────────

const OpenAI = require('openai');
const crypto = require('crypto'); // Built into Node.js — no install needed

const config      = require('./config');
const { readRecentHistory }          = require('./history-reader');
const { filterUrls, deduplicateUrls } = require('./url-filter');
const {
  db,
  clearAllMissions,
  upsertMission,
  insertMissionUrl,
  setMeta,
} = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
// getClient()
//
// Creates and returns an OpenAI SDK client configured to talk to DeepSeek.
// DeepSeek's API is "OpenAI-compatible" — they copied the same API format
// exactly, so we can reuse the OpenAI client just by swapping the baseURL.
//
// Think of it like plugging a different cable into the same port.
// ─────────────────────────────────────────────────────────────────────────────
function getClient() {
  return new OpenAI({
    apiKey:  config.deepseekApiKey,
    baseURL: config.deepseekBaseUrl,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPrompt(entries)
//
// Takes the array of filtered URL entries and constructs a text prompt that
// DeepSeek will understand. The prompt is carefully worded to get back clean,
// structured JSON clusters.
//
// Each entry is formatted as:
//   N. [Title of the page] https://example.com (visited 3x, last: 2024-03-15 14:30:00)
//
// We tell DeepSeek exactly what format to respond in so parseResponse() can
// reliably extract the data.
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(entries) {
  // Format each URL entry as a numbered list item with key metadata.
  // The 1-based index (i + 1) is what DeepSeek will reference back in url_indices.
  const entryLines = entries.map((entry, i) => {
    const n = i + 1;
    const title = entry.title || '(no title)';
    const url   = entry.url;
    const visits = entry.visit_count || 1;
    const last   = entry.last_visit  || 'unknown';
    return `${n}. [${title}] ${url} (visited ${visits}x, last: ${last})`;
  }).join('\n');

  // The full prompt. The rules section is critical — it steers DeepSeek away
  // from superficial grouping (by website domain) toward meaningful intent-based
  // clustering (what the user was actually trying to accomplish).
  return `You are an AI assistant that analyzes browsing history and groups URLs into meaningful "missions" — coherent clusters of intent and purpose.

Here is a list of recently visited URLs:

${entryLines}

Group these URLs into missions. Each mission represents a coherent goal or area of focus.

Rules:
- Group by INTENT, not by domain. A research project might span GitHub, Stack Overflow, and blog posts — they belong in the same mission.
- Ignore social media noise (Twitter/X feeds, Reddit front page, YouTube home) unless they're clearly part of a specific research task.
- Be SPECIFIC and descriptive in mission names. "Learning about Next.js Server Components" is better than "Web Development".
- Each URL should appear in at most one mission. Discard URLs that don't fit any meaningful mission.
- Status meanings:
  - "active"    = visited recently (within last 1-2 days), clearly in progress
  - "cooling"   = visited 3-7 days ago or slowing down, still relevant
  - "abandoned" = not visited in a while or appears incomplete/dropped

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "missions": [
    {
      "name": "Short, specific mission name",
      "summary": "One sentence describing what this mission is about",
      "status": "active",
      "url_indices": [1, 3, 5]
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseResponse(responseText, entries)
//
// Takes DeepSeek's raw text response and the original entries array, and
// returns a clean array of mission objects ready to be stored in the database.
//
// Steps:
//   1. Strip markdown code fences (DeepSeek sometimes wraps JSON in ```json ```)
//   2. Parse the JSON
//   3. Generate a stable ID for each mission (md5 hash of its lowercase name)
//   4. Resolve url_indices (1-based numbers) back to actual entry objects
//   5. Calculate the most recent last_visit among a mission's URLs
// ─────────────────────────────────────────────────────────────────────────────
function parseResponse(responseText, entries) {
  // ── 1. Strip markdown code fences ────────────────────────────────────────
  // DeepSeek sometimes wraps its JSON in ```json ... ``` even when told not to.
  // This regex removes those fences if present. The 's' flag makes . match newlines.
  let cleaned = responseText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // ── 2. Parse JSON ─────────────────────────────────────────────────────────
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`[clustering] Failed to parse DeepSeek response as JSON: ${err.message}\nRaw response:\n${responseText.slice(0, 500)}`);
  }

  // Validate that the response has the expected structure
  if (!parsed || !Array.isArray(parsed.missions)) {
    throw new Error(`[clustering] DeepSeek response missing "missions" array. Got: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  const now = new Date().toISOString();

  // ── 3–5. Process each mission ─────────────────────────────────────────────
  return parsed.missions.map(mission => {
    // ── 3. Generate a stable mission ID ──────────────────────────────────────
    // We hash the mission name (lowercased) with MD5 and take the first 12 chars.
    // This gives us a short, consistent ID that won't change if we re-run the
    // analysis with a similar clustering result.
    // md5 isn't available as a package, so we use Node's built-in crypto module.
    const nameKey = (mission.name || '').toLowerCase().trim();
    const missionId = crypto
      .createHash('md5')
      .update(nameKey)
      .digest('hex')
      .slice(0, 12);

    // ── 4. Resolve url_indices to actual entry objects ────────────────────────
    // url_indices is a 1-based array like [1, 3, 7]. We convert to 0-based to
    // look up into the entries array. Skip any out-of-range indices gracefully.
    const urlIndices = Array.isArray(mission.url_indices) ? mission.url_indices : [];
    const resolvedUrls = urlIndices
      .map(idx => entries[idx - 1])       // convert 1-based → 0-based
      .filter(Boolean);                    // drop undefined if index was out of range

    // ── 5. Find most recent last_visit among this mission's URLs ──────────────
    // last_visit_raw is the raw Chrome microsecond timestamp — higher = more recent.
    // We use it to sort, then format the winner as a readable string.
    let lastActivity = null;
    if (resolvedUrls.length > 0) {
      const mostRecent = resolvedUrls.reduce((best, entry) => {
        const t = entry.last_visit_raw || 0;
        return t > (best.last_visit_raw || 0) ? entry : best;
      }, resolvedUrls[0]);
      lastActivity = mostRecent.last_visit || null;
    }

    // Validate status — only allow the three permitted values
    const validStatuses = ['active', 'cooling', 'abandoned'];
    const status = validStatuses.includes(mission.status) ? mission.status : 'cooling';

    return {
      id:           missionId,
      name:         mission.name    || 'Unnamed Mission',
      summary:      mission.summary || '',
      status,
      last_activity: lastActivity,
      created_at:   now,
      updated_at:   now,
      dismissed:    0,
      urls:         resolvedUrls,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// analyzeBrowsingHistory()
//
// The main orchestration function. This is what the rest of the app calls.
//
// Pipeline:
//   1. Read Chrome history          (history-reader)
//   2. Filter noise URLs            (url-filter)
//   3. Deduplicate URLs             (url-filter)
//   4. Limit to batchSize entries
//   5. Build prompt and call DeepSeek
//   6. Parse the AI response
//   7. Clear old missions in DB and insert the new ones (transaction)
//   8. Record the timestamp of this analysis
//   9. Return the missions array
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeBrowsingHistory() {
  console.log('[clustering] Starting browsing history analysis...');

  // ── 1. Read Chrome history ────────────────────────────────────────────────
  const rawEntries = readRecentHistory();
  console.log(`[clustering] Raw history entries: ${rawEntries.length}`);

  if (rawEntries.length === 0) {
    console.warn('[clustering] No history entries found. Aborting analysis.');
    return [];
  }

  // ── 2. Filter noise URLs ──────────────────────────────────────────────────
  const filtered = filterUrls(rawEntries);
  console.log(`[clustering] After filtering: ${filtered.length} entries`);

  // ── 3. Deduplicate URLs ───────────────────────────────────────────────────
  const deduplicated = deduplicateUrls(filtered);
  console.log(`[clustering] After deduplication: ${deduplicated.length} entries`);

  // ── 4. Limit to batchSize ─────────────────────────────────────────────────
  // We don't want to send thousands of URLs to the AI — it gets expensive and
  // slower. config.batchSize (default 200) is the sweet spot.
  const batch = deduplicated.slice(0, config.batchSize);
  console.log(`[clustering] Sending ${batch.length} entries to DeepSeek...`);

  // ── 5. Call DeepSeek API ──────────────────────────────────────────────────
  const client = getClient();
  const prompt = buildPrompt(batch);

  let responseText;
  try {
    const completion = await client.chat.completions.create({
      model:       config.deepseekModel,
      temperature: 0.3,   // Low temperature = more consistent, less creative output
      max_tokens:  4000,  // Enough for ~20 missions with summaries
      messages: [
        {
          role:    'user',
          content: prompt,
        },
      ],
    });

    // The actual text response is nested inside the API's response object.
    // This is the OpenAI response format: response.choices[0].message.content
    responseText = completion.choices?.[0]?.message?.content;

    if (!responseText) {
      throw new Error('DeepSeek returned an empty response');
    }

    console.log(`[clustering] DeepSeek responded (${responseText.length} chars)`);

  } catch (err) {
    console.error(`[clustering] DeepSeek API call failed: ${err.message}`);
    throw err;
  }

  // ── 6. Parse the response ─────────────────────────────────────────────────
  let missions;
  try {
    missions = parseResponse(responseText, batch);
    console.log(`[clustering] Parsed ${missions.length} missions from response`);
  } catch (err) {
    console.error(`[clustering] Failed to parse AI response: ${err.message}`);
    throw err;
  }

  // ── 7. Clear old missions and insert new ones (in a transaction) ──────────
  // A "transaction" means all the inserts succeed together, or none do.
  // Like a bank transfer: both the debit and credit must succeed, or neither happens.
  const insertAll = db.transaction(() => {
    // Wipe all existing missions + their URLs so we start fresh
    clearAllMissions();

    // Insert each new mission and its associated URLs
    for (const mission of missions) {
      // Insert the mission row itself.
      // upsertMission is a better-sqlite3 "prepared statement" object, so we
      // call .run() on it to execute it with the given parameters.
      upsertMission.run({
        id:            mission.id,
        name:          mission.name,
        summary:       mission.summary,
        status:        mission.status,
        last_activity: mission.last_activity,
        created_at:    mission.created_at,
        updated_at:    mission.updated_at,
        dismissed:     mission.dismissed,
      });

      // Insert each URL row linked to this mission
      for (const urlEntry of mission.urls) {
        insertMissionUrl.run({
          mission_id:  mission.id,
          url:         urlEntry.url,
          title:       urlEntry.title         || '',
          visit_count: urlEntry.visit_count   || 1,
          last_visit:  urlEntry.last_visit    || null,
        });
      }
    }
  });

  // Execute the transaction
  insertAll();
  console.log(`[clustering] Saved ${missions.length} missions to database`);

  // ── 8. Record the timestamp of this analysis ──────────────────────────────
  // This lets the UI show "Last updated: 5 minutes ago"
  setMeta.run({ key: 'last_analysis', value: new Date().toISOString() });

  // ── 9. Return the missions array ──────────────────────────────────────────
  return missions;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildOpenTabsPrompt(tabs)
//
// Builds a simpler prompt specifically for clustering currently open tabs.
// Unlike buildPrompt() which works with history data and visit counts, this
// one just gets raw tab titles and URLs — because open tabs don't have
// visit-count metadata.
//
// The key instruction to the AI: every single tab must be assigned to a mission.
// No orphans allowed. This is the core contract of the new architecture.
// ─────────────────────────────────────────────────────────────────────────────
function buildOpenTabsPrompt(tabs) {
  // Format each tab as a numbered list item
  const tabLines = tabs.map((tab, i) => {
    const n = i + 1;
    const title = tab.title || '(no title)';
    const url   = tab.url   || '';
    return `${n}. [${title}] ${url}`;
  }).join('\n');

  return `You are an AI assistant that organizes currently open browser tabs into meaningful "missions" — clusters of intent and purpose.

Here are the user's currently open browser tabs:

${tabLines}

Group ALL of these tabs into missions. Every single tab must appear in exactly one mission.

Rules:
- Group by INTENT, not by domain. Researching a topic might span GitHub, docs, and blog posts — they all belong together.
- Be SPECIFIC and descriptive in mission names. "Debugging Next.js Hydration Error" is better than "Web Dev".
- Every tab must appear in exactly one mission — no tab should be left out. If a tab is genuinely miscellaneous, create a "Miscellaneous" mission for it.
- Write a concise 1-sentence summary for each mission. The summary should sound like a casual human note to yourself — never say "the user" or "the reader." Just describe the activity directly. Examples: "Digging into how Anthropic's constitutional AI actually works." or "Setting up Stripe billing for the new project." Keep it conversational and natural.

Also write a "personalMessage" — a single witty, slightly humorous observation about this person based on their open tabs. Write it as if you're a friend glancing at their screen. Keep it warm, specific to their actual tabs (reference real things you see), and under 20 words. Examples:
- "12 AI tools open and counting. You're either building the future or procrastinating on it."
- "Three localhost projects, two research rabbit holes, and a recipe. Classic."
- "The USCIS tab has been there for weeks, hasn't it? Hang in there."

IMPORTANT — granularity rules:
- **Individual content pieces get their own mission.** Each YouTube video, blog post, article, or podcast is its own mission — named after the content (e.g., "Watching: Building Is the Easy Part Now | Mike Knoop"). Do NOT lump unrelated content tabs together under a generic name like "Watching AI Videos."
- **localhost tabs are vibe coding project previews.** Group localhost tabs by PORT number — each port is a different project. Name the mission after the page title or what the project appears to be (e.g., "Brand DNA Tool (localhost:5173)"). If multiple localhost tabs share the same port, they're the same project.
- **Tools and platforms that are clearly separate activities should not be lumped together.** "OpenClaw" and "Claude Code docs" and "Paperclip hiring platform" are three different things — give each its own mission unless the user clearly opened them as part of the same research session.
- Prefer MORE granular missions over fewer broad ones. 15 specific missions is better than 5 vague ones.

Respond ONLY with valid JSON in this exact format (no markdown, no explanation):
{
  "personalMessage": "Your witty one-liner about this person's tabs goes here.",
  "missions": [
    {
      "name": "Short, specific mission name",
      "summary": "One sentence describing what this mission is about",
      "tab_indices": [1, 2, 5]
    }
  ]
}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseOpenTabsResponse(responseText, tabs)
//
// Parses DeepSeek's response for open-tab clustering.
// Similar to parseResponse() but simpler — no last_visit, no status, no DB IDs.
// Returns an array of mission objects shaped for the dashboard's "Right now" view.
//
// Each returned mission looks like:
//   { name, summary, tabs: [{ url, title, tabId }] }
// ─────────────────────────────────────────────────────────────────────────────
function parseOpenTabsResponse(responseText, tabs) {
  // Strip markdown code fences if DeepSeek wraps the JSON
  let cleaned = responseText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`[clustering] Failed to parse open-tabs response as JSON: ${err.message}\nRaw: ${responseText.slice(0, 500)}`);
  }

  if (!parsed || !Array.isArray(parsed.missions)) {
    throw new Error(`[clustering] Open-tabs response missing "missions" array. Got: ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  // Extract the personalMessage from the top level of the response.
  // This is the witty one-liner DeepSeek writes after glancing at all the tabs.
  const personalMessage = parsed.personalMessage || null;

  const missions = parsed.missions.map(mission => {
    // tab_indices are 1-based (matching our numbered list in the prompt)
    const tabIndices = Array.isArray(mission.tab_indices) ? mission.tab_indices : [];
    const resolvedTabs = tabIndices
      .map(idx => tabs[idx - 1])   // convert 1-based to 0-based array index
      .filter(Boolean);             // drop any out-of-range indices

    return {
      name:    mission.name    || 'Unnamed Mission',
      summary: mission.summary || '',
      // Preserve the original tab object (which may include tabId from the extension)
      tabs:    resolvedTabs,
    };
  });

  // Return both the missions array and the personalMessage together.
  // The caller (clusterOpenTabs) will pass both through to the route handler.
  return { missions, personalMessage };
}

// ─────────────────────────────────────────────────────────────────────────────
// clusterOpenTabs(tabs)
//
// Takes an array of currently open tab objects { url, title, tabId } and
// asks DeepSeek to group them into missions. This is ephemeral — results
// are NOT stored in the database. They're recalculated fresh every page load.
//
// Returns: [ { name, summary, tabs: [{ url, title, tabId }] }, ... ]
// ─────────────────────────────────────────────────────────────────────────────
async function clusterOpenTabs(tabs) {
  if (!tabs || tabs.length === 0) {
    console.log('[clustering] clusterOpenTabs: no tabs provided, returning empty array');
    return [];
  }

  console.log(`[clustering] Clustering ${tabs.length} open tabs...`);

  const client = getClient();
  const prompt = buildOpenTabsPrompt(tabs);

  let responseText;
  try {
    const completion = await client.chat.completions.create({
      model:       config.deepseekModel,
      temperature: 0.3,   // Low temperature = consistent, predictable output
      max_tokens:  3000,  // Enough for up to ~15 missions
      messages: [{ role: 'user', content: prompt }],
    });

    responseText = completion.choices?.[0]?.message?.content;

    if (!responseText) {
      throw new Error('DeepSeek returned an empty response for open-tabs clustering');
    }

    console.log(`[clustering] Open-tabs DeepSeek response: ${responseText.length} chars`);
  } catch (err) {
    console.error(`[clustering] Open-tabs DeepSeek API call failed: ${err.message}`);
    throw err;
  }

  const { missions, personalMessage } = parseOpenTabsResponse(responseText, tabs);
  console.log(`[clustering] clusterOpenTabs: got ${missions.length} missions`);
  // Return both missions and the personalMessage so the route can pass it to the client
  return { missions, personalMessage };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────
module.exports = { analyzeBrowsingHistory, clusterOpenTabs };
