// Prompted owner dashboard. Plain JavaScript, no build step. All data comes from /api/admin/*,
// which requires the session cookie; this file contains no data and no secrets.
(function () {
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var view = $('#view');
  var esc = function (s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fmt = function (n) { return n === null || n === undefined ? '—' : Number(n).toLocaleString(); };
  var pct = function (a, b) { return a === null || a === undefined || !b ? '—' : (100 * a / b).toFixed(1) + '%'; };
  var when = function (iso) { return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };
  var day = function (iso) { return iso ? String(iso).slice(0, 10) : '—'; };
  var st = function (s) { return '<span class="tag st-' + esc(s) + '">' + esc(s) + '</span>'; };

  function gmailWarning(h) {
    if (!h) return '';
    if (!h.ok) return '<div class="panel alert"><b>Gmail is not connected properly.</b> ' + esc(h.error || '') + ' Open Tools and click Connect Gmail before the next send.</div>';
    if (h.expires_at) {
      var days = Math.floor((new Date(h.expires_at) - Date.now()) / 864e5);
      return '<div class="panel alert' + (days > 3 ? ' soft' : '') + '"><b>The Gmail sign-in expires on ' + new Date(h.expires_at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + '</b> (in ' + days + ' day' + (days === 1 ? '' : 's') + '). This happens because the Google Cloud app is still in “Testing” mode. Publish the app in Google Cloud, then reconnect Gmail once, and the sign-in will no longer expire weekly.</div>';
    }
    return '';
  }
  function toast(msg, ms) { var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, ms || 3500); }
  function api(method, path, body) {
    var init = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch('/api/admin/' + path, init).then(function (r) {
      if (r.status === 401 && path !== 'login') { showLogin(); throw new Error('Please sign in.'); }
      return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || 'Request failed'); return j; });
    });
  }
  var get = function (p) { return api('GET', p); }, post = function (p, b) { return api('POST', p, b || {}); };
  function guard(promise) { return promise.catch(function (e) { toast(e.message, 6000); throw e; }); }

  // ---------- session ----------
  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#pw').focus(); }
  $('#login-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    api('POST', 'login', { password: $('#pw').value }).then(function () { $('#pw').value = ''; $('#login-msg').textContent = ''; start(); }).catch(function (e) { $('#login-msg').textContent = e.message; });
  });
  $('#logout').addEventListener('click', function () { post('logout').then(showLogin); });
  function start() {
    get('me').then(function (me) {
      $('#login').hidden = true; $('#app').hidden = false;
      var m = $('#mode'); m.textContent = me.env + ' · sending: ' + (me.send_mode === 'live' ? 'LIVE' : 'dry run'); m.className = 'pill' + (me.send_mode === 'live' ? ' live' : '');
      go(location.hash.slice(1) || 'dashboard');
    }).catch(function () {});
  }
  var TABS = { dashboard: dashboard, audience: audience, import: importer, publish: publish, links: links, tools: tools };
  function go(tab) {
    if (!TABS[tab]) tab = 'dashboard';
    history.replaceState(null, '', '#' + tab);
    document.querySelectorAll('#tabs button').forEach(function (b) { b.setAttribute('aria-current', b.dataset.tab === tab); });
    view.innerHTML = '<p class="muted">Loading…</p>';
    TABS[tab]();
  }
  $('#tabs').addEventListener('click', function (e) { if (e.target.dataset.tab) go(e.target.dataset.tab); });

  // ---------- dashboard ----------
  function dashboard() {
    guard(get('dashboard')).then(function (d) {
      var a = d.audience, issues = d.issues.slice().reverse();
      var rate = function (i) { var m = i.platform || (i.beehiiv && i.beehiiv.recipients ? i.beehiiv : null); return m && m.recipients ? 100 * (m.unique_opens || 0) / (m.delivered || m.recipients) : 0; };
      var bars = issues.map(function (i) { var r = rate(i); return '<i class="' + (i.platform ? '' : 'b') + '" style="height:' + Math.max(1, r) + '%" data-t="No. ' + i.number + ': ' + (r ? r.toFixed(1) + '% opened' : 'no email data') + '"></i>'; }).join('');
      var growth = d.growth_series.filter(function (g) { return g.active !== null; });
      var gmax = Math.max.apply(null, growth.map(function (g) { return g.active; }).concat([1]));
      view.innerHTML = gmailWarning(d.gmail_health) +
        '<div class="grid g4">' +
        [['Active subscribers', a.active], ['Pending confirmation', a.pending], ['Prospective (not subscribed)', a.prospective], ['Unsubscribed / bounced / complained', (a.unsubscribed || 0) + (a.bounced || 0) + (a.complained || 0) + (a.suppressed || 0)]]
          .map(function (s) { return '<div class="panel stat"><b>' + fmt(s[1] || 0) + '</b><span>' + s[0] + '</span></div>'; }).join('') + '</div>' +
        '<div class="grid g2"><div class="panel"><h2>Open rate by issue</h2><div class="bars">' + bars + '</div><p class="legend"><i style="background:#8a8880"></i>beehiiv era (imported)<i style="background:var(--red)"></i>this platform</p><p class="note">' + esc(d.notes.opens) + '</p></div>' +
        '<div class="panel"><h2>Active subscribers over time</h2>' + (growth.length ? '<div class="bars">' + growth.map(function (g) { return '<i class="' + (g.era === 'beehiiv' ? 'b' : '') + '" style="height:' + (100 * g.active / gmax) + '%" data-t="' + g.day + ': ' + g.active + '"></i>'; }).join('') + '</div>' : '<p class="muted">No growth series imported yet. Import one under Tools.</p>') +
        '<p class="note">' + esc(d.notes.eras) + '</p></div></div>' +
        '<div class="grid g2"><div class="panel"><h2>Where subscribers came from</h2><div class="scroll"><table><tr><th>Source</th><th class="n">People</th><th class="n">Active</th></tr>' + d.sources.map(function (s) { return '<tr><td>' + esc(s.source) + '</td><td class="n">' + fmt(s.n) + '</td><td class="n">' + fmt(s.active) + '</td></tr>'; }).join('') + '</table></div>' +
        (d.campaigns.length ? '<h3 style="margin-top:14px">Campaigns</h3><table><tr><th>Campaign</th><th>Source / medium</th><th class="n">People</th><th class="n">Active</th></tr>' + d.campaigns.map(function (c) { return '<tr><td>' + esc(c.campaign) + '</td><td>' + esc(c.source) + ' / ' + esc(c.medium) + '</td><td class="n">' + fmt(c.n) + '</td><td class="n">' + fmt(c.active) + '</td></tr>'; }).join('') + '</table>' : '') + '</div>' +
        '<div class="panel"><h2>Organizations</h2>' + (d.organizations.length ? '<table><tr><th>Organization</th><th class="n">People</th><th class="n">Active</th><th class="n">Prospective</th></tr>' + d.organizations.map(function (o) { return '<tr><td>' + esc(o.org) + '</td><td class="n">' + fmt(o.n) + '</td><td class="n">' + fmt(o.active) + '</td><td class="n">' + fmt(o.prospective) + '</td></tr>'; }).join('') + '</table>' : '<p class="muted">No organization memberships recorded yet.</p>') +
        '<h3 style="margin-top:14px">Sending quota today</h3><table><tr><th>Provider</th><th class="n">Used</th><th class="n">Daily limit</th><th class="n">Left</th></tr>' + d.quotas.map(function (q) { return '<tr><td>' + esc(q.name) + '</td><td class="n">' + fmt(q.used) + '</td><td class="n">' + fmt(q.limit) + '</td><td class="n">' + fmt(q.remaining) + '</td></tr>'; }).join('') + '</table>' +
        (d.send_mode !== 'live' ? '<p class="note">Sending is in dry-run mode: nothing is emailed to anyone.</p>' : '') + '</div></div>' +
        '<div class="panel"><h2>Issues</h2><div class="scroll"><table><tr><th>No.</th><th>Week</th><th>Era</th><th class="n">Recipients</th><th class="n">Delivered</th><th class="n">Unique opens</th><th class="n">Open rate</th><th class="n">Unique clicks</th><th class="n">Unsubs</th><th class="n">Web views</th></tr>' +
        d.issues.map(function (i) {
          var m = i.platform, b = i.beehiiv, x = m || b;
          return '<tr><td>' + i.number + '</td><td><a href="/issues/' + esc(i.slug) + '/">' + esc(i.week) + '</a></td><td>' + (m ? 'platform' : b ? 'beehiiv' : '<span class="muted">no data</span>') + '</td>' +
            (x ? '<td class="n">' + fmt(x.recipients) + '</td><td class="n">' + fmt(x.delivered) + '</td><td class="n">' + fmt(x.unique_opens) + '</td><td class="n">' + (x.recipients ? pct(x.unique_opens, x.delivered || x.recipients) : '—') + '</td><td class="n">' + fmt(x.unique_clicks) + '</td><td class="n">' + fmt(x.unsubscribes) + '</td><td class="n">' + fmt(b ? b.web_views : null) + '</td>' : '<td colspan="7" class="muted">not recorded</td>') + '</tr>';
        }).join('') + '</table></div><p class="note">' + esc(d.notes.clicks) + '</p></div>' +
        (d.imports.length ? '<div class="panel"><h2>Recent imports</h2><table><tr><th>When</th><th>File</th><th>Source label</th><th>Added as</th><th>Result</th></tr>' + d.imports.map(function (b) { return '<tr><td>' + when(b.created_at) + '</td><td>' + esc(b.filename || '—') + '</td><td>' + esc(b.source_label) + '</td><td>' + esc(b.target_status) + '</td><td>' + esc(Object.keys(b.totals).map(function (k) { return k + ': ' + b.totals[k]; }).join(', ')) + '</td></tr>'; }).join('') + '</table></div>' : '');
    });
  }

  // ---------- audience ----------
  var filters = { q: '', status: '', org: '', tag: '', source: '', offset: 0 };
  function audience() {
    guard(get('people/facets')).then(function (f) {
      var opt = function (list, cur) { return '<option value="">All</option>' + list.map(function (x) { return '<option' + (x === cur ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); };
      view.innerHTML = '<div class="panel"><div class="row">' +
        '<div><label for="f-q">Search</label><input id="f-q" type="search" placeholder="email, name, ID, notes" value="' + esc(filters.q) + '"></div>' +
        '<div><label for="f-status">Status</label><select id="f-status">' + opt(f.statuses, filters.status) + '</select></div>' +
        '<div><label for="f-org">Organization</label><select id="f-org">' + opt(f.organizations, filters.org) + '</select></div>' +
        '<div><label for="f-tag">Tag</label><select id="f-tag">' + opt(f.tags, filters.tag) + '</select></div>' +
        '<div><label for="f-source">Source</label><select id="f-source">' + opt(f.sources, filters.source) + '</select></div>' +
        '<div><button class="btn ghost" id="f-export">Export CSV</button> <button class="btn" id="f-add">Add person</button></div></div></div>' +
        '<div class="panel"><div id="people"></div></div>';
      ['q', 'status', 'org', 'tag', 'source'].forEach(function (k) { $('#f-' + k).addEventListener(k === 'q' ? 'input' : 'change', function (e) { filters[k] = e.target.value; filters.offset = 0; clearTimeout(audience.t); audience.t = setTimeout(loadPeople, k === 'q' ? 250 : 0); }); });
      $('#f-export').addEventListener('click', function () { location.href = '/api/admin/export/people.csv?' + qs(); });
      $('#f-add').addEventListener('click', addPerson);
      loadPeople();
    });
  }
  function qs() { var p = new URLSearchParams(); Object.keys(filters).forEach(function (k) { if (filters[k] && k !== 'offset') p.set(k, filters[k]); }); return p.toString(); }
  function loadPeople() {
    guard(get('people?limit=50&offset=' + filters.offset + '&' + qs())).then(function (r) {
      var el = $('#people'); if (!el) return;
      el.innerHTML = '<p class="muted">' + fmt(r.total) + ' people' + (r.total > 50 ? ' · showing ' + (filters.offset + 1) + '–' + Math.min(r.total, filters.offset + 50) : '') + '</p><div class="scroll"><table><tr><th>Email</th><th>Name</th><th>Status</th><th>Organizations</th><th>Source</th><th>Subscribed</th></tr>' +
        r.rows.map(function (p) { return '<tr class="click" data-id="' + p.id + '"><td>' + esc(p.email) + (p.email_verification === 'inferred' ? ' <span class="tag">inferred</span>' : '') + '</td><td>' + esc([p.first_name, p.last_name].filter(Boolean).join(' ')) + '</td><td>' + st(p.status) + (p.member_loa ? '<span class="tag">LOA</span>' : '') + '</td><td>' + esc(p.organizations || '') + '</td><td>' + esc(p.source || '') + '</td><td>' + day(p.subscribed_at) + '</td></tr>'; }).join('') +
        '</table></div><p style="margin-top:10px">' + (filters.offset ? '<button class="btn ghost" id="prev">Previous</button> ' : '') + (filters.offset + 50 < r.total ? '<button class="btn ghost" id="next">Next</button>' : '') + '</p>';
      el.querySelectorAll('tr.click').forEach(function (tr) { tr.addEventListener('click', function () { person(tr.dataset.id); }); });
      if ($('#prev')) $('#prev').addEventListener('click', function () { filters.offset -= 50; loadPeople(); });
      if ($('#next')) $('#next').addEventListener('click', function () { filters.offset += 50; loadPeople(); });
    });
  }
  function drawer(html) { $('#drawer-body').innerHTML = '<p><button class="link" id="d-close">Close</button></p>' + html; $('#drawer').hidden = false; $('#d-close').addEventListener('click', closeDrawer); }
  function closeDrawer() { $('#drawer').hidden = true; }
  $('#drawer').addEventListener('click', function (e) { if (e.target.id === 'drawer') closeDrawer(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  function addPerson() {
    drawer('<h2>Add a person</h2><label for="n-email">Email</label><input id="n-email" type="email" style="width:100%"><div class="row"><div><label for="n-first">First name</label><input id="n-first"></div><div><label for="n-last">Last name</label><input id="n-last"></div></div>' +
      '<label for="n-status">Add as</label><select id="n-status"><option value="prospective">Prospective (not emailed)</option><option value="active">Active subscriber</option></select>' +
      '<p id="n-consent" hidden><label style="color:inherit"><input type="checkbox" id="n-attest"> I confirm this person agreed to receive Prompted.</label></p><p style="margin-top:14px"><button class="btn" id="n-save">Add</button></p>');
    $('#n-status').addEventListener('change', function (e) { $('#n-consent').hidden = e.target.value !== 'active'; });
    $('#n-save').addEventListener('click', function () {
      guard(post('people', { email: $('#n-email').value, first_name: $('#n-first').value, last_name: $('#n-last').value, status: $('#n-status').value, consent_attested: $('#n-attest').checked })).then(function (p) { toast('Added.'); loadPeople(); person(p.id); });
    });
  }
  function person(id) {
    guard(get('people/' + id)).then(function (p) {
      drawer('<h2>' + esc(p.email) + '</h2><p>' + st(p.status) + (p.member_loa ? '<span class="tag">Member LOA</span>' : '') + '<span class="tag">email ' + esc(p.email_verification) + '</span>' + p.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</p>' +
        '<div class="row"><div><label for="p-first">First name</label><input id="p-first" value="' + esc(p.first_name) + '"></div><div><label for="p-last">Last name</label><input id="p-last" value="' + esc(p.last_name) + '"></div></div>' +
        '<label for="p-email">Email (changing it marks the address unverified)</label><input id="p-email" style="width:100%" value="' + esc(p.email) + '">' +
        '<div class="row"><div><label for="p-inst">Institution ID</label><input id="p-inst" value="' + esc(p.institution_id) + '"></div><div><label for="p-ver">Email verification</label><select id="p-ver">' + ['verified', 'inferred', 'unverified'].map(function (v) { return '<option' + (v === p.email_verification ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select></div><div><label><input type="checkbox" id="p-loa"' + (p.member_loa ? ' checked' : '') + '> Member LOA</label></div></div>' +
        '<label for="p-tags">Tags (separate with ;)</label><input id="p-tags" style="width:100%" value="' + esc(p.tags.join('; ')) + '">' +
        '<label for="p-orgs">Organizations, one per line as “Organization | Role”</label><textarea id="p-orgs">' + esc(p.memberships.map(function (m) { return m.org + (m.role ? ' | ' + m.role : ''); }).join('\n')) + '</textarea>' +
        '<label for="p-notes">Notes</label><textarea id="p-notes">' + esc(p.notes) + '</textarea><p><button class="btn" id="p-save">Save changes</button></p>' +
        '<h3>Subscription</h3><p class="muted">Source: ' + esc(p.source || '—') + (p.utm_campaign ? ' · campaign ' + esc(p.utm_campaign) : '') + '<br>Subscribed ' + when(p.subscribed_at) + (p.unsubscribed_at ? ' · unsubscribed ' + when(p.unsubscribed_at) : '') + '</p>' +
        '<div class="row"><div><select id="p-status">' + ['prospective', 'active', 'unsubscribed', 'bounced', 'suppressed'].map(function (s) { return '<option' + (s === p.status ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div><div><input id="p-reason" placeholder="Reason"></div><div><button class="btn ghost" id="p-setstatus">Change status</button></div></div>' +
        '<p><label style="color:inherit"><input type="checkbox" id="p-attest"> Needed to make someone active: I confirm this person agreed to receive Prompted.</label></p>' +
        '<h3>History</h3><table>' + p.history.map(function (h) { return '<tr><td>' + when(h.at) + '</td><td>' + esc(h.from_status || '—') + ' → ' + esc(h.to_status) + '</td><td>' + esc(h.reason || '') + '</td><td class="muted">' + esc(h.actor) + '</td></tr>'; }).join('') + '</table>' +
        '<h3 style="margin-top:14px">Relationship notes</h3><div class="row"><div><select id="i-kind"><option>note</option><option>email</option><option>meeting</option><option>call</option></select></div><div style="flex:1"><input id="i-body" style="width:100%" placeholder="What happened?"></div><div><button class="btn ghost" id="i-add">Add</button></div></div>' +
        '<table>' + p.interactions.map(function (i) { return '<tr><td>' + when(i.at) + '</td><td>' + esc(i.kind) + '</td><td>' + esc(i.body) + '</td></tr>'; }).join('') + '</table>' +
        (p.deliveries.length ? '<h3 style="margin-top:14px">Issues received</h3><table><tr><th>Issue</th><th>Status</th><th class="n">Opens</th><th class="n">Clicks</th></tr>' + p.deliveries.map(function (d) { return '<tr><td>' + esc(d.issue_slug) + '</td><td>' + st(d.status) + '</td><td class="n">' + d.opens + '</td><td class="n">' + d.clicks + '</td></tr>'; }).join('') + '</table>' : ''));
      $('#p-save').addEventListener('click', function () {
        guard(api('PATCH', 'people/' + id, { first_name: $('#p-first').value || null, last_name: $('#p-last').value || null, email: $('#p-email').value, institution_id: $('#p-inst').value || null, email_verification: $('#p-ver').value, member_loa: $('#p-loa').checked, notes: $('#p-notes').value || null,
          tags: $('#p-tags').value.split(';'), memberships: $('#p-orgs').value.split('\n').map(function (l) { var x = l.split('|'); return { org: (x[0] || '').trim(), role: (x[1] || '').trim() || null }; }).filter(function (m) { return m.org; }) })).then(function () { toast('Saved.'); loadPeople(); person(id); });
      });
      $('#p-setstatus').addEventListener('click', function () { guard(post('people/' + id + '/status', { status: $('#p-status').value, reason: $('#p-reason').value, consent_attested: $('#p-attest').checked })).then(function () { toast('Status changed.'); loadPeople(); person(id); }); });
      $('#i-add').addEventListener('click', function () { guard(post('people/' + id + '/interactions', { kind: $('#i-kind').value, body: $('#i-body').value })).then(function () { person(id); }); });
    });
  }

  // ---------- import ----------
  function importer() {
    view.innerHTML = '<div class="panel"><h2>Import people from a CSV file</h2><p class="muted">Nothing is saved until you review the preview. People who unsubscribed, bounced or complained are never re-added.</p>' +
      '<div class="row"><div><label for="im-file">CSV file</label><input id="im-file" type="file" accept=".csv,text/csv"></div><div><label for="im-label">Source label</label><input id="im-label" placeholder="e.g. roster: Founders"></div>' +
      '<div><label for="im-mode">Kind of file</label><select id="im-mode"><option value="audience">New contacts</option><option value="migration">Full ledger from another system (keeps each status)</option></select></div>' +
      '<div id="im-target-wrap"><label for="im-target">Add new people as</label><select id="im-target"><option value="prospective">Prospective (not emailed)</option><option value="pending">Pending (must confirm by email)</option><option value="active">Active subscribers</option></select></div>' +
      '<div><button class="btn" id="im-preview">Preview</button> <button class="btn ghost" id="im-recon" title="Compare this file with the database without changing anything">Compare only</button></div></div>' +
      '<p id="im-consent" hidden><label style="color:inherit"><input type="checkbox" id="im-attest"> I confirm every person in this file agreed to receive Prompted.</label></p></div><div id="im-out"></div>';
    var csv = '', name = '', mapping = null;
    $('#im-file').addEventListener('change', function (e) { var f = e.target.files[0]; if (!f) return; name = f.name; mapping = null; f.text().then(function (t) { csv = t; }); });
    $('#im-mode').addEventListener('change', function (e) { $('#im-target-wrap').hidden = e.target.value === 'migration'; });
    $('#im-target').addEventListener('change', function (e) { $('#im-consent').hidden = e.target.value !== 'active'; });
    var payload = function () { return { csv: csv, filename: name, source_label: $('#im-label').value || ('import: ' + name), mode: $('#im-mode').value, target_status: $('#im-target').value, consent_attested: $('#im-attest').checked, mapping: mapping || undefined }; };
    $('#im-preview').addEventListener('click', function () {
      if (!csv) return toast('Choose a CSV file first.');
      guard(post('imports/preview', payload())).then(function (p) { renderPlan(p, false); });
    });
    $('#im-recon').addEventListener('click', function () {
      if (!csv) return toast('Choose a CSV file first.');
      guard(post('imports/reconcile', payload())).then(function (r) {
        var cnt = function (o) { return Object.keys(o).map(function (k) { return '<span class="tag st-' + k + '">' + k + ': ' + o[k] + '</span>'; }).join('') || '<span class="muted">none</span>'; };
        var tbl = function (title, rows, cols) { return rows.length ? '<h3 style="margin-top:14px">' + title + ' (' + rows.length + ')</h3><div class="scroll" style="max-height:240px;overflow:auto"><table>' + rows.slice(0, 300).map(function (x) { return '<tr>' + cols.map(function (c) { return '<td>' + esc(x[c]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table></div>' : ''; };
        $('#im-out').innerHTML = '<div class="panel"><h2>Comparison: ' + (r.in_agreement ? '<span class="ok">file and database agree</span>' : '<span class="warn">differences found</span>') + '</h2><p class="muted">Nothing was changed.</p>' +
          '<p>In the file (' + r.unique_addresses + ' addresses): ' + cnt(r.source_counts) + '</p><p>In the database: ' + cnt(r.database_counts) + '</p><p>' + r.matching + ' addresses match exactly.</p>' +
          (r.dangerous.length ? '<p class="err"><b>' + r.dangerous.length + ' address(es) are active here but opted out or bounced in the file. Fix these before any send.</b></p>' : '') +
          tbl('In the file but not in the database', r.missing_from_database, ['email', 'source_status']) + tbl('In the database but not in the file', r.only_in_database, ['email', 'status']) +
          tbl('Status differs', r.status_differs, ['email', 'source_status', 'status']) + tbl('Invalid addresses in the file', r.invalid, ['row', 'email']) + '</div>';
      });
    });
    function renderPlan(p, done) {
      var t = p.totals;
      $('#im-out').innerHTML = '<div class="panel"><h2>' + (done ? (p.already_imported ? 'This exact file was already imported' : 'Import complete') : 'Preview') + '</h2>' +
        '<p>' + Object.keys(t).map(function (k) { return '<span class="tag">' + esc(k.replace(/_/g, ' ')) + ': ' + t[k] + '</span>'; }).join('') + '</p>' +
        (p.headers && !done ? '<details' + (Object.values(p.mapping).indexOf('email') < 0 ? ' open' : '') + '><summary>How each column is read (' + Object.keys(p.mapping).length + ' of ' + p.headers.length + ' matched; the rest are kept as custom fields)</summary><div class="row" id="im-map">' +
          p.headers.map(function (h) { return '<div><label>' + esc(h) + '</label><select data-h="' + esc(h) + '"><option value="">keep as custom field</option>' + p.fields.map(function (f) { return '<option' + (p.mapping[h] === f ? ' selected' : '') + '>' + f + '</option>'; }).join('') + '</select></div>'; }).join('') + '</div><p><button class="btn ghost" id="im-remap">Apply column choices</button></p></details>' : '') +
        (p.needs_mapping ? '<p class="warn">This file has no column the importer recognises as the email address. Choose it below, then click “Apply column choices”.</p>' : !done ? '<p><button class="btn" id="im-commit">Import ' + ((t.new || 0) + (t.existing || 0)) + ' rows</button></p>' : '') +
        (p.rows ? '<div class="scroll" style="max-height:480px;overflow:auto"><table><tr><th>Row</th><th>Email</th><th>Outcome</th><th>Detail</th></tr>' + p.rows.map(function (r) { return '<tr><td>' + r.row + '</td><td>' + esc(r.email) + '</td><td>' + st(r.outcome) + '</td><td>' + esc(r.detail) + '</td></tr>'; }).join('') + '</table></div>' : '') + '</div>';
      if ($('#im-remap')) $('#im-remap').addEventListener('click', function () { mapping = {}; document.querySelectorAll('#im-map select').forEach(function (s) { if (s.value) mapping[s.dataset.h] = s.value; }); guard(post('imports/preview', payload())).then(function (np) { renderPlan(np, false); }); });
      if (!done && $('#im-commit')) $('#im-commit').addEventListener('click', function () { this.disabled = true; guard(post('imports/commit', payload())).then(function (r) { renderPlan(r, true); toast('Import recorded.'); }); });
    }
  }

  // ---------- publish ----------
  function publish() {
    guard(get('issues')).then(function (r) {
      view.innerHTML = '<div class="panel"><h2>Publish an issue</h2><ol class="steps"><li>Approved issue</li><li>Preview</li><li>QA</li><li>Test email</li><li>Owner approval</li><li>Schedule</li><li>Send</li><li>Verify</li></ol>' +
        '<label for="pub-issue">Issue</label><select id="pub-issue">' + r.issues.map(function (i) { return '<option value="' + esc(i.slug) + '">No. ' + i.number + ' · Week of ' + esc(i.week.label) + (i.sends.some(function (s) { return s.kind === 'issue'; }) ? ' · ' + i.sends.filter(function (s) { return s.kind === 'issue'; })[0].status : '') + '</option>'; }).join('') + '</select></div><div id="pub-out"></div>';
      var sel = $('#pub-issue');
      sel.addEventListener('change', function () { showIssue(r, sel.value); });
      showIssue(r, sel.value);
    });
  }
  function showIssue(r, slug) {
    var issue = r.issues.filter(function (i) { return i.slug === slug; })[0];
    var live = issue.sends.filter(function (s) { return s.kind === 'issue'; })[0];
    Promise.all([guard(get('issues/' + slug + '/qa')), live ? guard(get('sends/' + live.id)) : Promise.resolve(null)]).then(function (res) {
      var qa = res[0], send = res[1];
      $('#pub-out').innerHTML = '<div class="grid g2"><div><div class="panel"><h2>Checks</h2><p>' + (qa.ok ? '<span class="ok">Ready: no blocking problems.</span>' : '<span class="err">' + qa.errors + ' blocking problem(s).</span>') + ' ' + qa.warnings + ' item(s) to review. ' + fmt(qa.stats.words) + ' words, ' + qa.stats.email_kb + ' KB email.</p>' +
        '<ul class="qa">' + qa.findings.map(function (f) { return '<li class="' + f.level + '">' + (f.level === 'error' ? 'Blocking: ' : 'Review: ') + esc(f.message) + '</li>'; }).join('') + '</ul>' +
        '<p class="muted">Planned send: ' + when(issue.send.utc) + ' your time (' + esc(issue.send.local.replace('T', ' ')) + ' Eastern).</p></div>' +
        '<div class="panel"><h2>Test email</h2><p class="muted">Goes only to authorised test inboxes: ' + (r.test_recipients.length ? r.test_recipients.map(esc).join(', ') : 'none configured (set TEST_RECIPIENTS)') + '.</p><div class="row"><div style="flex:1"><input id="t-emails" style="width:100%" value="' + esc(r.test_recipients.join(', ')) + '"></div><div><button class="btn ghost" id="t-send">Send test</button></div></div><p class="muted" style="margin:10px 0 0">Not arriving? <button class="link" id="t-diag">Send a plain delivery check</button> (no links or images) to see whether the sending account itself is being filtered.</p></div>' +
        '<div class="panel"><h2>Send to subscribers</h2><div id="send-box"></div></div></div>' +
        '<div class="panel"><h2>Email preview</h2><p class="muted"><a href="/issues/' + esc(slug) + '/" target="_blank" rel="noopener">Open the web version</a></p><iframe class="preview" title="Email preview" src="/api/admin/issues/' + esc(slug) + '/email"></iframe></div></div>';
      $('#t-diag').addEventListener('click', function () { guard(post('sends/diagnostic', { email: $('#t-emails').value.split(',')[0].trim() })).then(function (d) { toast(d.ok ? 'Plain check sent via ' + d.provider + '. Look in the inbox and in Spam.' : 'Could not send: ' + d.error, 8000); }); });
      $('#t-send').addEventListener('click', function () { guard(post('sends/test', { issue_slug: slug, emails: $('#t-emails').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean) })).then(function (s) { var real = s.providers.length && s.providers[0] !== 'dryrun'; toast('Test ' + s.status + ' via ' + (s.providers.join(', ') || 'no provider') + ': ' + JSON.stringify(s.recipients) + (real ? '. Check the inbox.' : '. Dry run: no email was actually sent. Connect Gmail under Tools first.'), 9000); }); });
      sendBox(r, slug, send, qa);
    });
  }
  function sendBox(r, slug, send, qa) {
    var box = $('#send-box'), again = function () { guard(get('issues')).then(function (nr) { showIssue(nr, slug); }); };
    if (!send) {
      box.innerHTML = '<p>No send has been prepared for this issue.</p><button class="btn" id="s-prepare"' + (qa.ok ? '' : ' disabled') + '>Prepare send</button>';
      $('#s-prepare').addEventListener('click', function () { guard(post('sends', { issue_slug: slug })).then(again); });
      return;
    }
    var rc = send.recipients, total = Object.keys(rc).reduce(function (a, k) { return a + rc[k]; }, 0);
    box.innerHTML = '<p>' + st(send.status) + ' Subject: <b>' + esc(send.subject) + '</b></p>' +
      (send.scheduled_at ? '<p>Scheduled for ' + when(send.scheduled_at) + (send.audience && send.audience.tag ? ', only to people tagged <b>' + esc(send.audience.tag) + '</b>' : '') + '.</p>' : '') +
      (total ? '<p>' + Object.keys(rc).map(function (k) { return '<span class="tag st-' + k + '">' + k + ': ' + rc[k] + '</span>'; }).join('') + ' · opened by ' + fmt(send.opened) + ' · clicked by ' + fmt(send.clicked) + '</p>' : '') +
      (send.failures && send.failures.length ? '<details><summary>' + send.failures.length + ' not delivered</summary><table>' + send.failures.map(function (f) { return '<tr><td>' + esc(f.email_norm) + '</td><td>' + st(f.status) + '</td><td>' + esc(f.last_error || '') + '</td></tr>'; }).join('') + '</table></details>' : '') +
      (send.links && send.links.some(function (l) { return l.clicks; }) ? '<h3>Most clicked links</h3><table>' + send.links.filter(function (l) { return l.clicks; }).slice(0, 8).map(function (l) { return '<tr><td class="n">' + l.clicks + '</td><td>' + esc(l.url) + '</td></tr>'; }).join('') + '</table>' : '') +
      '<p style="margin-top:12px">' +
      (send.status === 'draft' ? '<button class="btn" id="s-approve">I approve this issue for sending</button> ' : '') +
      (send.status === 'approved' || send.status === 'scheduled' ? '<input id="s-at" type="datetime-local"> <input id="s-tag" placeholder="only people tagged… (optional)" value="' + esc((send.audience && send.audience.tag) || '') + '"> <button class="btn" id="s-schedule">' + (send.status === 'scheduled' ? 'Reschedule' : 'Schedule') + '</button> <span class="muted">Leave the time empty for the next Monday 8:45 a.m. Eastern slot. A tag sends to that group first; everyone else can be added afterwards.</span> ' : '') +
      ((send.status === 'sent' || send.status === 'sending') && send.not_yet_included ? '<button class="btn" id="s-extend">Send to the ' + send.not_yet_included + ' subscriber(s) not yet included</button> ' : '') +
      (['draft', 'approved', 'scheduled'].indexOf(send.status) >= 0 ? '<button class="btn ghost" id="s-cancel">Cancel</button>' : '') +
      (rc.failed ? '<button class="btn ghost" id="s-retry">Retry failed (check the provider log first)</button>' : '') + '</p>';
    var act = function (id, path, body) { var b = $(id); if (b) b.addEventListener('click', function () { guard(post('sends/' + send.id + '/' + path, body ? body() : {})).then(again); }); };
    act('#s-approve', 'approve'); act('#s-cancel', 'cancel'); act('#s-retry', 'retry-failed');
    act('#s-schedule', 'schedule', function () { var v = $('#s-at').value; return { at: v ? new Date(v).toISOString() : null, audience_tag: $('#s-tag').value.trim() || null }; });
    act('#s-extend', 'extend');
  }

  // ---------- links ----------
  function links() {
    fetch('/data/site.json').then(function (r) { return r.json(); }).then(function (site) {
      view.innerHTML = '<div class="panel"><h2>Ready-made signup links</h2><p class="muted">Short links are stable and safe to print as QR codes. Each one records where the subscriber came from.</p><table><tr><th>For</th><th>Short link</th><th>Records</th></tr>' +
        site.campaigns.map(function (c) { return '<tr><td>' + esc(c.label) + '</td><td><code>' + esc(site.url + '/s/' + c.code + '/') + '</code></td><td class="muted">' + esc(c.utm_source + ' / ' + c.utm_medium + ' / ' + c.utm_campaign) + '</td></tr>'; }).join('') + '</table></div>' +
        '<div class="panel"><h2>Make a tracked link</h2><div class="row"><div><label for="l-page">Page</label><select id="l-page"><option value="/subscribe/">Subscribe page</option><option value="/">Home page</option><option value="/issues/">Archive</option></select></div>' +
        '<div><label for="l-source">Source (utm_source)</label><input id="l-source" placeholder="linkedin"></div><div><label for="l-medium">Medium (utm_medium)</label><input id="l-medium" placeholder="social"></div><div><label for="l-campaign">Campaign (utm_campaign)</label><input id="l-campaign" placeholder="prompted_written_2026_11_16"></div></div>' +
        '<p style="margin-top:14px"><code id="l-out"></code> <button class="btn ghost" id="l-copy">Copy</button></p><p class="note">To add a permanent short link, add an entry to <code>platform/content/site.json</code> and rebuild.</p></div>';
      var upd = function () { var p = new URLSearchParams(); [['utm_source', '#l-source'], ['utm_medium', '#l-medium'], ['utm_campaign', '#l-campaign']].forEach(function (x) { var v = $(x[1]).value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_'); if (v) p.set(x[0], v); }); $('#l-out').textContent = site.url + $('#l-page').value + (p.toString() ? '?' + p.toString() : ''); };
      ['#l-page', '#l-source', '#l-medium', '#l-campaign'].forEach(function (s) { $(s).addEventListener('input', upd); });
      $('#l-copy').addEventListener('click', function () { navigator.clipboard.writeText($('#l-out').textContent).then(function () { toast('Copied.'); }); });
      upd();
    });
  }

  // ---------- tools ----------
  function tools() {
    Promise.all([guard(get('audit?limit=60')), guard(get('providers')), guard(get('suppressions')), guard(get('placement'))]).then(function (res) {
      var pl = res[3];
      var p = res[1];
      view.innerHTML = '<div class="grid g2"><div class="panel"><h2>Backup and export</h2><p class="muted">Backups contain private subscriber data. Keep them in private storage only.</p><p><a class="btn ghost" href="/api/admin/export/backup.json">Download full backup (JSON)</a> <a class="btn ghost" href="/api/admin/export/people.csv">Download everyone (CSV)</a></p>' +
        '<h3 style="margin-top:14px">Restore</h3><p class="muted">Only works on an empty database.</p><input type="file" id="r-file" accept="application/json"> <button class="btn ghost" id="r-go">Restore</button></div>' +
        '<div class="panel"><h2>Email delivery</h2><p>Mode: <b>' + (p.send_mode === 'live' ? 'LIVE' : 'dry run (nothing is emailed)') + '</b><br>From address: ' + esc(p.from || 'not set') + '<br>Test emails go out through: <b>' + esc(p.test_quotas.map(function (q) { return q.name; }).join(', ')) + '</b>' + (p.test_quotas[0] && p.test_quotas[0].name === 'dryrun' ? ' (nothing is really sent until Gmail is connected)' : ' (real email, test inboxes only)') + '<br>Authorised test inboxes: ' + p.test_recipients + '<br>Footer postal address: ' + (p.configured.postal_address ? 'set' : '<span class="warn">placeholder (not a real address yet)</span>') + '</p>' +
        (p.last_problem ? '<p class="err">Last delivery problem (' + when(p.last_problem.at) + ', ' + esc(p.last_problem.provider) + '): ' + esc(p.last_problem.message) + '</p>' : '') + '<h3>Gmail sending account</h3>' + gmailWarning(p.gmail_health) + (p.gmail_health && p.gmail_health.ok && !p.gmail_health.expires_at ? '<p class="ok">Sign-in checked ' + when(p.gmail_health.checked_at) + ': working, no expiry date reported.</p>' : '') + '<p>' + (p.gmail.connected ? '<span class="ok">Connected</span> as <b>' + esc(p.gmail.account || 'unknown account') + '</b>. <button class="link" id="g-check">Check connection now</button> · <a href="/api/admin/gmail/connect">Reconnect</a> · <button class="link" id="g-off">Disconnect</button>' : p.gmail.client_configured ? 'Not connected. <a class="btn" href="/api/admin/gmail/connect">Connect Gmail</a>' : '<span class="muted">Waiting for GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to be added as Worker secrets.</span>') + '</p><p class="muted">Redirect address to register at Google: <code>' + esc(p.gmail.redirect_uri) + '</code></p><p style="margin:0"><table><tr><th>Provider</th><th class="n">Used today</th><th class="n">Daily limit</th></tr>' + p.quotas.concat(p.test_quotas.filter(function (t) { return !p.quotas.some(function (q) { return q.name === t.name; }); })).map(function (q) { return '<tr><td>' + esc(q.name) + '</td><td class="n">' + q.used + '</td><td class="n">' + q.limit + (q.warmup_cap !== null && q.warmup_cap !== undefined ? ' <span class="muted">(warm-up cap ' + q.warmup_cap + ')</span>' : '') + '</td></tr>'; }).join('') + '</table></div></div>' +
        '<div class="panel"><h2>Where test emails landed</h2><p class="muted">A provider accepting a message is not the same as a reader seeing it. Record each test here. The cutover gate is three inbox results in a row for each kind of inbox.</p>' +
        (pl.streaks.length ? '<table><tr><th>Sender → inbox</th><th>Latest</th><th class="n">Inbox results in a row</th><th>Gate</th></tr>' + pl.streaks.map(function (s) { return '<tr><td>' + esc(s.sender) + ' → ' + esc(s.inbox) + '</td><td>' + st(s.last === 'inbox' ? 'active' : s.last === 'spam' || s.last === 'missing' ? 'failed' : 'pending').replace(/>[a-z]+</, '>' + esc(s.last) + '<') + ' <span class="muted">' + esc(s.last_on) + '</span></td><td class="n">' + s.streak + '</td><td>' + (s.passes ? '<span class="ok">passes</span>' : '<span class="warn">not yet</span>') + '</td></tr>'; }).join('') + '</table>' : '<p class="muted">Nothing recorded yet.</p>') +
        '<div class="row" style="margin-top:12px"><div><label for="pl-date">Date</label><input id="pl-date" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></div><div><label for="pl-sender">Sent from</label><input id="pl-sender" placeholder="e.g. readprompted@gmail.com" value="' + esc((p.gmail && p.gmail.account) || '') + '"></div><div><label for="pl-inbox">Inbox</label><select id="pl-inbox"><option>Gmail</option><option>Outlook</option><option>iCloud</option><option>University</option><option>Other</option></select></div><div><label for="pl-result">Landed in</label><select id="pl-result"><option value="inbox">Inbox</option><option value="promotions">Promotions tab</option><option value="spam">Spam</option><option value="missing">Never arrived</option></select></div><div><label for="pl-note">Note</label><input id="pl-note" placeholder="optional"></div><div><button class="btn ghost" id="pl-add">Record</button></div></div></div>' +
        '<div class="panel"><h2>Check a sending domain</h2><p class="muted">Looks up the public DNS records that let mail from a domain prove it is genuine (SPF, DKIM, DMARC). Use this after adding a domain and before sending from it. Nothing is changed.</p><div class="row"><div><input id="dc-domain" placeholder="e.g. prompted.eu.org"></div><div><button class="btn ghost" id="dc-go">Check</button></div></div><div id="dc-out"></div></div>' +
        '<div class="grid g2"><div class="panel"><h2>Import historical metrics</h2><p class="muted">Paste beehiiv post statistics (JSON with a "posts" list) or a growth series (JSON with a "series" list). Figures are stored exactly as given and labelled as beehiiv-era.</p><textarea id="m-json" placeholder=\'{"posts":[...]}\'></textarea><p><button class="btn ghost" id="m-go">Import</button></p></div>' +
        '<div class="panel"><h2>Suppression list (' + res[2].rows.length + ')</h2><div class="row"><div style="flex:1"><input id="sup-email" type="email" placeholder="address to never email" style="width:100%"></div><div><input id="sup-detail" placeholder="why"></div><div><button class="btn ghost" id="sup-add">Suppress</button></div></div>' +
        '<div class="scroll" style="max-height:260px;overflow:auto"><table>' + res[2].rows.map(function (s) { return '<tr><td>' + esc(s.email_norm) + '</td><td>' + st(s.reason) + '</td><td class="muted">' + esc(s.source) + '</td><td>' + day(s.created_at) + '</td></tr>'; }).join('') + '</table></div></div></div>' +
        '<div class="panel"><h2>Audit log</h2><div class="scroll"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr>' + res[0].rows.map(function (a) { return '<tr><td>' + when(a.at) + '</td><td>' + esc(a.actor) + '</td><td>' + esc(a.action) + (a.entity_id ? ' #' + esc(a.entity_id) : '') + '</td><td class="muted">' + esc(a.detail || '') + '</td></tr>'; }).join('') + '</table></div></div>';
      $('#r-go').addEventListener('click', function () { var f = $('#r-file').files[0]; if (!f) return toast('Choose a backup file.'); f.text().then(function (t) { return guard(post('restore', JSON.parse(t))); }).then(function (r) { toast('Restored ' + r.restored_rows + ' rows.'); }); });
      $('#m-go').addEventListener('click', function () { var j; try { j = JSON.parse($('#m-json').value); } catch (e) { return toast('That is not valid JSON.'); } guard(post(j.series ? 'metrics/growth' : 'metrics/beehiiv', j)).then(function (r) { toast('Imported ' + r.imported + ' row(s).' + (r.unmatched && r.unmatched.length ? ' Unmatched: ' + r.unmatched.length : '')); }); });
      $('#pl-add').addEventListener('click', function () { guard(post('placement', { tested_on: $('#pl-date').value, sender: $('#pl-sender').value, inbox: $('#pl-inbox').value, result: $('#pl-result').value, note: $('#pl-note').value })).then(function () { toast('Recorded.'); tools(); }); });
      $('#dc-go').addEventListener('click', function () { guard(get('deliverability/domain?domain=' + encodeURIComponent($('#dc-domain').value))).then(function (r) { $('#dc-out').innerHTML = '<p style="margin-top:12px">' + (r.ready ? '<span class="ok"><b>Ready:</b> mail from this domain should authenticate.</span>' : '<span class="err"><b>Not ready.</b></span>') + '</p><ul class="qa">' + r.findings.map(function (f) { return '<li class="' + (f.level === 'error' ? 'error' : f.level === 'warn' ? 'warn' : '') + '"><b>' + esc(f.item) + ':</b> ' + esc(f.message) + '</li>'; }).join('') + '</ul>'; }); });
      if ($('#g-check')) $('#g-check').addEventListener('click', function () { guard(post('gmail/check')).then(function (r) { toast(r.health && r.health.ok ? 'Gmail connection is working.' : 'Problem: ' + ((r.health && r.health.error) || 'not connected'), 7000); tools(); }); });
      if ($('#g-off')) $('#g-off').addEventListener('click', function () { guard(post('gmail/disconnect')).then(function () { toast('Gmail disconnected.'); tools(); }); });
      $('#sup-add').addEventListener('click', function () { guard(post('suppressions', { email: $('#sup-email').value, reason: 'manual', detail: $('#sup-detail').value })).then(function () { toast('Suppressed.'); tools(); }); });
    });
  }

  start();
})();
