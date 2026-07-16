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
 * UPDATED for SOURCE 2.0: points at the new Supabase project and the new
 * `inventory` table (was `date_tracker`). Authenticates via two narrow
 * Postgres views — cal_feed_users and cal_feed_inventory — instead of the
 * old settings.users blob (deleted for security). This app uses the ANON
 * key only, never service_role: app_users/inventory are locked down by
 * RLS to real logged-in app sessions, so the views expose just the columns
 * this feed needs (no password hashes, no other user data) and are
 * separately grantable to the anon role. A previous version of this file
 * had a service_role key committed here in plaintext — that key has since
 * been rotated, and this version is designed so that mistake can't repeat:
 * there is no key in this file capable of bypassing row-level security.
 *
 * This app only READS from Supabase. It never writes anything.
 * -----------------------------------------------------------------
 */

// ── CONFIG: SOURCE 2.0 Supabase project ──────────────────────────
const SB_URL = 'https://isevkzikqhdgnoloqbad.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlzZXZremlrcWhkZ25vbG9xYmFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM4NjU1MDYsImV4cCI6MjA5OTQ0MTUwNn0.sLHw1rhj6oMVeMeQECV_m1-6-lCN9Y7ZuV9ImROgTZA';
// This is the anon/public key — safe to embed, same one the SOURCE app
// itself ships in its client code. If you ever change your Supabase
// project, update these two lines to match the values shown in your app's
// Admin Panel > Supabase Connection.

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

async function sbRpc(name, args) {
  try {
    const res = await fetch(SB_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
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

  // ── 1. Authenticate via token, against the safe cal_feed_users view ──
  var matches = await sbGet('cal_feed_users?cal_token=eq.' + encodeURIComponent(token) + '&select=username,role,location_ids');
  var matchedUser = matches[0];
  if (!matchedUser) {
    res.status(403).type('text/plain').send(
      'This calendar link is invalid.\nGenerate a new one from the app: My Account > Calendar Sync.'
    );
    return;
  }

  // ── 2. Resolve which kitchens this user can see — same logic (and the
  //      same shared RPC) the app's own ics-feed Edge Function uses, so
  //      both feeds stay consistent with each other ──
  var scopedLocationIds = await sbRpc('rpc_internal_locations_in_scope', {
    p_role: matchedUser.role,
    p_location_ids: matchedUser.location_ids
  });

  var lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//SOURCE//Expiring Inventory//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:SOURCE - Expiring Inventory');
  lines.push('REFRESH-INTERVAL;VALUE=DURATION:PT6H');
  lines.push('X-PUBLISHED-TTL:PT6H');

  if (scopedLocationIds && scopedLocationIds.length > 0) {
    // ── 3. Active inventory items in scope, expiring within 14 days
    //      (plus anything already expired but still marked active) ──
    var windowEnd = new Date();
    windowEnd.setDate(windowEnd.getDate() + 14);
    var windowEndStr = windowEnd.toISOString().slice(0, 10);

    var itemsPath = 'cal_feed_inventory?select=id,product_name,expiry_date'
      + '&expiry_date=lte.' + windowEndStr
      + '&location_id=in.(' + scopedLocationIds.map(encodeURIComponent).join(',') + ')';
    var items = await sbGet(itemsPath);

    var now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    items.forEach(function (it) {
      var expiry = icsDate(it.expiry_date);
      if (!/^\d{8}$/.test(expiry)) return; // skip malformed dates defensively

      lines.push('BEGIN:VEVENT');
      lines.push(icsFold('UID:inv-' + it.id + '@source.souslabs.com'));
      lines.push('DTSTAMP:' + now);
      lines.push('DTSTART;VALUE=DATE:' + expiry);
      lines.push(icsFold('SUMMARY:' + icsEscape(it.product_name) + ' expires'));
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(icsFold('DESCRIPTION:' + icsEscape(it.product_name) + ' expires tomorrow'));
      lines.push('TRIGGER:-P1D');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    });
  }

  lines.push('END:VCALENDAR');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'inline; filename="source-inventory.ics"');
  res.send(lines.join('\r\n') + '\r\n');
});

app.get('/', function (req, res) {
  res.type('text/plain').send('SOURCE calendar feed is running. Use /calendar-feed?token=YOUR_TOKEN');
});

app.listen(PORT, function () {
  console.log('Calendar feed server running on port ' + PORT);
});
