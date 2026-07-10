const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

/**
 * SOURCE Inventory — Calendar Feed (Express app)
 * -----------------------------------------------------------------
 * Deploy this to Hostinger's Node.js Web Apps Hosting (Websites > Add
 * Website > Node.js Apps > Import Git Repository).
 *
 * Each user gets their own link from the app (My Account > Calendar Sync),
 * shaped like:  https://yourdomain.com/calendar-feed?token=abc123...
 *
 * That link can be subscribed to in Apple Calendar, Google Calendar, or
 * Outlook. Their calendar app re-checks this URL automatically every few
 * hours and pulls in new/updated dates — no further action needed.
 *
 * This app only READS from Supabase. It never writes anything.
 *
 * UPDATED for multi-kitchen support: a user assigned to specific
 * kitchen(s) now only sees expiry dates for THOSE kitchens in their
 * calendar feed, instead of every kitchen mixed together. Someone
 * with no kitchen restriction (all-access, e.g. most admins) still
 * sees everything, same as before this update.
 *
 * Only expiry dates are included — production dates are intentionally
 * left off the calendar.
 * -----------------------------------------------------------------
 */

// ── CONFIG: same Supabase project your SOURCE app already uses ──────
const SB_URL = 'https://oamwiaisjmltpihjbgiw.supabase.co';
// IMPORTANT: this must be the SERVICE ROLE key, not the anon key. This
// service has no user session at all (it's a background feed, not
// something a browser visits), so it needs to bypass row-level security
// entirely rather than depend on RLS treating "no session" as unrestricted
// — that behavior was removed when kitchen-scoping was tightened to apply
// to every role except Super Admin. The service role key always bypasses
// RLS regardless of any future RLS changes, so this fix won't break again.
//
// Find it in: Supabase Dashboard -> Settings -> API -> service_role key
// (NOT the anon/public key). Keep this secret — this file should never be
// exposed publicly or committed somewhere public, since this key has full
// access to your database.
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hbXdpYWlzam1sdHBpaGpiZ2l3Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MjY2ODkzMCwiZXhwIjoyMDk4MjQ0OTMwfQ.cyAk-6IK_3aDUlERp5ZIjT2ain8sy4rgpW6itd2-5Vs';
// If you ever change your Supabase project, update these two lines to
// match the values shown in your app's Admin Panel > Supabase Connection
// (for the URL) and Settings > API (for the service_role key).

// ── Helpers ───────────────────────────────────────────────────────
async function sbGet(path) {
  try {
    const res = await fetch(SB_URL.replace(/\/$/, '') + '/rest/v1/' + path, {
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getSettingValue(key, def) {
  const rows = await sbGet('settings?key=eq.' + encodeURIComponent(key));
  const row = rows.find(function (r) { return r.key === key; });
  return row && row.value !== undefined ? row.value : def;
}

// Reads a user's assigned kitchens, supporting both the current
// 'location_ids' array field and the older single 'location_id' field
// (from before multi-kitchen support), same fallback logic the app's
// own rpc_login uses. Returns [] for "all kitchens" access.
function getUserLocationIds(user) {
  if (Array.isArray(user.location_ids)) return user.location_ids.filter(Boolean);
  if (user.location_id) return [user.location_id];
  return [];
}

function icsEscape(text) {
  return String(text == null ? '' : text)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\n|\r/g, '\\n');
}

// Fold long lines to 75 octets as required by the iCalendar spec (RFC 5545)
function icsFold(line) {
  if (line.length <= 75) return line;
  var out = '', first = true, rest = line;
  while (rest.length > 0) {
    var chunkLen = first ? 75 : 74; // continuation lines get a leading space
    out += (first ? '' : '\r\n ') + rest.slice(0, chunkLen);
    rest = rest.slice(chunkLen);
    first = false;
  }
  return out;
}

function icsDate(ymd) {
  // "YYYY-MM-DD" -> "YYYYMMDD" (all-day event date format)
  return String(ymd || '').slice(0, 10).replace(/-/g, '');
}

// ── The feed endpoint ────────────────────────────────────────────
app.get('/calendar-feed', async function (req, res) {
  var token = (req.query.token || '').toString().trim();
  if (!token || !/^[a-z0-9]{10,64}$/i.test(token)) {
    res.status(400).type('text/plain').send(
      'Missing or invalid token.\nGet your personal link from the app: My Account > Calendar Sync.'
    );
    return;
  }

  // ── 1. Authenticate via token ──
  var users = await getSettingValue('users', []);
  var matchedUser = (users || []).find(function (u) { return u.calToken && u.calToken === token; });
  if (!matchedUser) {
    res.status(403).type('text/plain').send(
      'This calendar link is invalid.\nGenerate a new one from the app: My Account > Calendar Sync.'
    );
    return;
  }
  var username = matchedUser.username;

  // ── 2. This user's storage-area preferences (empty/missing = show all) ──
  var prefs = await getSettingValue('calendar_prefs_' + username, {});
  var prefStorages = (prefs && Array.isArray(prefs.storageTypes) && prefs.storageTypes.length > 0)
    ? prefs.storageTypes
    : null;

  // ── 3. This user's kitchen access (empty = all kitchens) ──
  var myLocationIds = getUserLocationIds(matchedUser);

  // ── 4. Active inventory items, filtered to their kitchen(s) if restricted ──
  var itemsPath = 'date_tracker?status=eq.active&order=expiry_date.asc';
  if (myLocationIds.length > 0) {
    itemsPath += '&location_id=in.(' + myLocationIds.map(encodeURIComponent).join(',') + ')';
  }
  var items = await sbGet(itemsPath);

  // ── 5. Kitchen names, for labeling events when more than one kitchen exists ──
  var allLocations = await sbGet('locations?select=id,name');
  var locationNameById = {};
  (allLocations || []).forEach(function (l) { locationNameById[l.id] = l.name; });
  var showKitchenLabel = (allLocations || []).length > 1;

  // ── 6. Build the .ics feed ──
  var now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  var lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//SOURCE//Inventory Feed//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push(icsFold('X-WR-CALNAME:SOURCE Inventory (' + icsEscape(username) + ')'));
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT4H');
  lines.push('X-PUBLISHED-TTL:PT4H');

  var storageLabels = { freezer: 'Frozen', chiller: 'Chilled', dry: 'Dry' };

  (items || []).forEach(function (it) {
    var storage = it.storage_type || '';
    if (prefStorages !== null && prefStorages.indexOf(storage) === -1) return;

    var name = it.product_name || 'Item';
    var cat = it.category || '';
    var expiry = it.expiry_date || null;
    var uidBase = it.id || (name + expiry);
    var kitchenName = it.location_id ? locationNameById[it.location_id] : null;

    if (!expiry) return; // nothing to put on the calendar without an expiry date

    var descParts = [];
    if (showKitchenLabel && kitchenName) descParts.push('Kitchen: ' + kitchenName);
    if (storage) descParts.push('Storage: ' + (storageLabels[storage] || storage));
    if (cat) descParts.push('Category: ' + cat);
    var desc = descParts.map(icsEscape).join('\\n');

    var summarySuffix = (showKitchenLabel && kitchenName) ? ' (' + kitchenName + ')' : '';

    lines.push('BEGIN:VEVENT');
    lines.push(icsFold('UID:expiry-' + uidBase + '@source-inventory'));
    lines.push('DTSTAMP:' + now);
    lines.push('DTSTART;VALUE=DATE:' + icsDate(expiry));
    lines.push(icsFold('SUMMARY:' + icsEscape('Expires: ' + name + summarySuffix)));
    if (desc) lines.push(icsFold('DESCRIPTION:' + desc));
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="source-inventory.ics"');
  res.send(lines.join('\r\n'));
});

app.get('/', function (req, res) {
  res.type('text/plain').send('SOURCE calendar feed is running. Use /calendar-feed?token=YOUR_TOKEN');
});

app.listen(PORT, function () {
  console.log('Calendar feed server running on port ' + PORT);
});
