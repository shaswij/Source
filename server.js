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
 * -----------------------------------------------------------------
 */

// ── CONFIG: same Supabase project your SOURCE app already uses ──────
const SB_URL = 'https://oamwiaisjmltpihjbgiw.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hbXdpYWlzam1sdHBpaGpiZ2l3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2Njg5MzAsImV4cCI6MjA5ODI0NDkzMH0.QzuoDSDCQqfIZYQHY2sbTpCbVYl7xYzjyQGtNcXMDhs';
// If you ever change your Supabase project, update these two lines to
// match the values shown in your app's Admin Panel > Supabase Connection.

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

async function sbRpc(fnName, params) {
  try {
    const res = await fetch(SB_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + fnName, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(params || {})
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
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
  var username = await sbRpc('rpc_lookup_user_by_cal_token', { p_token: token });
  if (!username) {
    res.status(403).type('text/plain').send(
      'This calendar link is invalid.\nGenerate a new one from the app: My Account > Calendar Sync.'
    );
    return;
  }

  // ── 2. This user's storage-area preferences (empty/missing = show all) ──
  var prefs = await getSettingValue('calendar_prefs_' + username, {});
  var prefStorages = (prefs && Array.isArray(prefs.storageTypes) && prefs.storageTypes.length > 0)
    ? prefs.storageTypes
    : null;

  // ── 3. Active inventory items ──
  var items = await sbGet('date_tracker?status=eq.active&order=expiry_date.asc');

  // ── 4. Build the .ics feed ──
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

  var catLabels = {
    fruits_veg: 'fruits/veg',
    nuts: 'dry fruits & nuts',
    dry: 'dry stores',
    direct_cold: 'cold cuts',
    direct_puree: 'puree',
    direct_asian: 'asian',
    direct_dairy: 'dairy',
    direct_other: 'other',
    micro_greens: 'micro greens',
    operation_supply: 'operation supply'
  };
  var storageLabels = { freezer: 'frozen', chiller: 'chilled', dry: 'dry' };

  (items || []).forEach(function (it) {
    var storageCode = it.storage_type || '';
    if (prefStorages !== null && prefStorages.indexOf(storageCode) === -1) return;

    var name = it.product_name || 'Item';
    var cat = catLabels[it.category] || (it.category ? String(it.category).toLowerCase() : '');
    var storage = storageLabels[storageCode] || storageCode.toLowerCase();
    var expiry = it.expiry_date || null;
    var uidBase = it.id || (name + expiry);

    if (!expiry) return; // only expiry dates are synced — no production/received dates

    var tag = cat ? (cat + '/' + storage) : storage;
    var summary = 'Expires: ' + name + (tag ? ' (' + tag + ')' : '');
    var desc = cat ? icsEscape('Category: ' + cat) : '';

    lines.push('BEGIN:VEVENT');
    lines.push(icsFold('UID:expiry-' + uidBase + '@source-inventory'));
    lines.push('DTSTAMP:' + now);
    lines.push('DTSTART;VALUE=DATE:' + icsDate(expiry));
    lines.push(icsFold('SUMMARY:' + icsEscape(summary)));
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
