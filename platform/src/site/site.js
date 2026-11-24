// Prompted site behaviour: attribution capture, signup forms, soft reading gate, archive search.
(function () {
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  var store = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} } };
  var local = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  // First-touch attribution for this visit: UTM parameters, referrer and landing page.
  var attr = {};
  try { attr = JSON.parse(store.get('prompted_attr') || '{}'); } catch (e) {}
  var q = new URLSearchParams(location.search), fresh = false;
  KEYS.forEach(function (k) { if (q.get(k)) { if (!fresh) { attr = {}; fresh = true; } attr[k] = q.get(k).slice(0, 120); } });
  if (!attr.landing_path) attr.landing_path = location.pathname;
  if (!attr.referrer && document.referrer && document.referrer.indexOf(location.origin) !== 0) attr.referrer = document.referrer.slice(0, 300);
  store.set('prompted_attr', JSON.stringify(attr));

  var loadedAt = Date.now();
  document.querySelectorAll('form[data-signup]').forEach(function (form) {
    var msg = form.querySelector('.signup-msg');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var body = { email: form.email.value, website: form.website ? form.website.value : '', elapsed_ms: Date.now() - loadedAt, form: form.dataset.signup || 'site', page: location.pathname };
      Object.keys(attr).forEach(function (k) { body[k] = attr[k]; });
      var btn = form.querySelector('button');
      btn.disabled = true; msg.className = 'signup-msg'; msg.textContent = 'Subscribing…';
      fetch(form.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          btn.disabled = false;
          msg.className = 'signup-msg ' + (res.ok ? 'ok' : 'err');
          msg.textContent = res.j.message || (res.ok ? 'Thanks. You are subscribed.' : 'Something went wrong. Please try again.');
          if (res.ok) { local.set('prompted_reader', '1'); form.email.value = ''; document.dispatchEvent(new Event('prompted:subscribed')); }
        })
        .catch(function () { btn.disabled = false; msg.className = 'signup-msg err'; msg.textContent = 'Could not reach the server. Please try again.'; });
    });
  });

  // Reading gate. Before launch the rest of the issue is only a preview behind a subscribe box (no way past it).
  // From launch (data-slug present) the rest is not in the page at all: signed-in subscribers fetch it from the server.
  var gate = document.querySelector('[data-gate]');
  if (gate && gate.dataset.slug) {
    var slot = document.querySelector('[data-gated]'), slug = gate.dataset.slug;
    var unlock = function () {
      return fetch('/api/reader/rest/' + slug, { credentials: 'same-origin' }).then(function (r) { if (!r.ok) throw 0; return r.text(); })
        .then(function (h) { slot.innerHTML = h; slot.hidden = false; gate.hidden = true; if (location.hash && location.hash !== '#keep-reading') { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); } });
    };
    fetch('/api/reader/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { if (j.signedIn) unlock().catch(function () {}); }).catch(function () {});
    var rf = gate.querySelector('[data-reader-form]');
    if (rf) rf.addEventListener('submit', function (ev) {
      ev.preventDefault(); var msg = rf.querySelector('.signup-msg'), btn = rf.querySelector('button'); btn.disabled = true; msg.className = 'signup-msg'; msg.textContent = 'Sending…';
      fetch('/api/reader/link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: rf.email.value, next: location.pathname }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) { btn.disabled = false; msg.className = 'signup-msg ' + (res.ok ? 'ok' : 'err'); msg.textContent = res.j.message || 'Something went wrong. Please try again.'; })
        .catch(function () { btn.disabled = false; msg.className = 'signup-msg err'; msg.textContent = 'Could not reach the server. Please try again.'; });
    });
  }

  // Reading progress bar and "you are here" in the side contents list.
  var bar = document.querySelector('.progress i'), art = document.querySelector('article.issue');
  if (bar && art) {
    var links = [].slice.call(document.querySelectorAll('.toc-side a')), heads = links.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
    var tick = false, update = function () {
      tick = false;
      var r = art.getBoundingClientRect(), total = r.height - window.innerHeight * 0.6;
      bar.style.width = Math.max(0, Math.min(100, (-r.top / (total > 0 ? total : 1)) * 100)) + '%';
      var cur = -1;
      for (var i = 0; i < heads.length; i++) if (heads[i] && heads[i].getBoundingClientRect().top < 120) cur = i;
      links.forEach(function (a, i) { a.classList.toggle('on', i === cur); });
    };
    window.addEventListener('scroll', function () { if (!tick) { tick = true; requestAnimationFrame(update); } }, { passive: true });
    update();
  }

  // Archive search: titles and summaries instantly, full text after the index loads.
  var box = document.querySelector('[data-search]');
  if (box) {
    var items = [].slice.call(document.querySelectorAll('[data-issue]')), count = document.querySelector('[data-count]'), years = [].slice.call(document.querySelectorAll('[data-year]'));
    var full = null, loading = false;
    var run = function () {
      var term = box.value.trim().toLowerCase(), shown = 0;
      items.forEach(function (li) {
        var hay = li.dataset.hay + (full && full[li.dataset.issue] ? ' ' + full[li.dataset.issue] : '');
        var hit = !term || hay.indexOf(term) >= 0;
        li.hidden = !hit; if (hit) shown++;
      });
      years.forEach(function (y) { y.hidden = !!term; });
      count.textContent = term ? shown + ' of ' + items.length + ' issues match “' + box.value.trim() + '”' + (full ? '' : ' (titles and summaries; loading full text…)') : items.length + ' issues';
    };
    box.addEventListener('input', function () {
      var tq = box.value.trim().toLowerCase(); clearTimeout(box._t); box._t = setTimeout(function () { if (tq.length < 2) { full = null; run(); return; } fetch(box.dataset.search + '?q=' + encodeURIComponent(tq)).then(function (r) { return r.json(); }).then(function (j) { if (box.value.trim().toLowerCase() !== tq) return; full = {}; (j.slugs || []).forEach(function (s) { full[s] = tq; }); run(); }).catch(function () {}); }, 160);
      run();
    });
  }

  // Front-page Index lookup: jump straight to the matching entry (without JavaScript the form just opens the Index).
  var look = document.querySelector('form.search[action="/index/"]');
  if (look) look.addEventListener('submit', function (ev) {
    var term = (look.q.value || '').trim().toLowerCase();
    if (!term) return;
    ev.preventDefault();
    fetch('/index/data.json').then(function (r) { return r.json(); }).then(function (d) {
      var best = null, score = 0;
      (d.terms || []).forEach(function (t) {
        [t.term].concat(t.surfaces || []).forEach(function (s) {
          s = String(s).toLowerCase();
          var v = s === term ? 3 : s.indexOf(term) === 0 ? 2 : s.indexOf(term) >= 0 ? 1 : 0;
          if (v > score || (v === score && v && best && t.issues > best.issues)) { score = v; best = t; }
        });
      });
      location.href = '/index/' + (best ? '#' + encodeURIComponent(best.anchor) : '');
    }).catch(function () { location.href = '/index/'; });
  });

  // Archive search: press / to jump to the box.
  document.addEventListener('keydown', function (e) {
    var b = document.querySelector('[data-search]');
    if (b && e.key === '/' && document.activeElement !== b && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); b.focus(); }
  });

  // ---------- archive calendar: hover or tap a Monday to unfold that issue below its month ----------
  var cal = document.querySelector('[data-cal]');
  if (cal) {
    var data = {}; try { data = JSON.parse(document.getElementById('cal-data').textContent); } catch (e) {}
    var panel = cal.querySelector('.cal-panel'), months = [].slice.call(cal.querySelectorAll('.cal-m')), pinned = null, shown = null, hideT = null;
    var escH = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    // the unfolded issue floats above or below the chosen square, whichever side has more room, sized to fit
    var cur = null;
    var place = function (btn) {
      cur = btn || cur; if (!cur) return;
      if (panel.parentNode !== cal) cal.appendChild(panel);
      var c = cal.getBoundingClientRect(), r = cur.getBoundingClientRect(), vh = window.innerHeight, gap = 10, pad = 12;
      var below = vh - r.bottom - gap - pad, above = r.top - gap - pad;
      panel.style.maxHeight = ''; var h = panel.scrollHeight;
      var down = below >= Math.min(h, above) || below >= above;
      var room = Math.max(160, down ? below : above);
      panel.style.maxHeight = room + 'px';
      var hh = Math.min(h, room);
      panel.style.top = (down ? r.bottom - c.top + gap : r.top - c.top - gap - hh) + 'px';
      panel.classList.toggle('up', !down);
    };
    var onMove = function () { if (!panel.hidden) place(); };
    window.addEventListener('scroll', onMove, { passive: true });
    window.addEventListener('resize', onMove);
    var show = function (btn, pin) {
      clearTimeout(hideT);
      var n = btn.dataset.n, d = data[n]; if (!d) return;
      cal.querySelectorAll('.cd.iss.sel').forEach(function (b) { b.classList.remove('sel'); });
      btn.classList.add('sel'); btn.setAttribute('aria-expanded', 'true');
      if (shown !== n) {
        panel.innerHTML = '<button class="cp-x" type="button" aria-label="Close">×</button><p class="kicker">Issue No. ' + n + ' · Week of ' + escH(d.week) + ' · ' + escH(d.date) + '</p>' +
          '<h3><a href="' + d.url + '"><span class="u">' + escH(d.title) + '</span></a></h3>' +
          (d.stories.length ? '<ol>' + d.stories.map(function (s, i) { return '<li><a href="' + d.url + (s[0] ? '#' + s[0] : '') + '"><span class="rk">' + (i + 1) + '</span><span><span class="u">' + escH(s[1]) + '</span></span></a></li>'; }).join('') + '</ol>' : '') +
          '<a class="sub-btn" href="' + d.url + '">Read issue ' + n + ' →</a>';
        panel.querySelector('.cp-x').addEventListener('click', function () { close(true); });
        shown = n;
      }
      panel.hidden = false; place(btn);
      requestAnimationFrame(function () { panel.classList.add('open'); });
      if (pin) pinned = n;
    };
    var close = function (force) {
      if (pinned && !force) return;
      pinned = null; shown = null; panel.classList.remove('open'); panel.hidden = true;
      cal.querySelectorAll('.cd.iss.sel').forEach(function (b) { b.classList.remove('sel'); b.setAttribute('aria-expanded', 'false'); });
    };
    var fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    cal.querySelectorAll('.cd.iss').forEach(function (b) {
      b.setAttribute('aria-expanded', 'false');
      if (fine) {
        // mouse: hovering shows the issue, leaving hides it at once (a short grace lets you move into the box); a click opens the issue
        b.addEventListener('mouseenter', function () { show(b, false); });
        b.addEventListener('mouseleave', function () { hideT = setTimeout(function () { close(true); }, 120); });
        b.addEventListener('click', function () { var d = data[b.dataset.n]; if (d) location.href = d.url; });
      } else {
        b.addEventListener('click', function () { if (pinned === b.dataset.n) { close(true); } else { show(b, true); } });
      }
    });
    panel.addEventListener('mouseenter', function () { clearTimeout(hideT); });
    panel.addEventListener('mouseleave', function () { if (fine) close(true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) close(true); });
    // search: light up matching Mondays
    var qbox = document.querySelector('[data-search]'), fullText = null;
    if (qbox) qbox.addEventListener('input', function () {
      var t = qbox.value.trim().toLowerCase();
      var apply = function () {
        cal.querySelectorAll('.cd.iss').forEach(function (b) {
          var d = data[b.dataset.n] || {}, hay = (d.hay || '') + ' ' + ((fullText && fullText[d.slug]) || '');
          b.classList.toggle('dim', !!t && hay.indexOf(t) < 0); b.classList.toggle('hit', !!t && hay.indexOf(t) >= 0);
        });
      };
      apply();
      if (t.length > 1) fetch(qbox.dataset.search + '?q=' + encodeURIComponent(t)).then(function (r) { return r.json(); }).then(function (j) { if (qbox.value.trim().toLowerCase() !== t) return; fullText = {}; (j.slugs || []).forEach(function (s) { fullText[s] = t; }); apply(); }).catch(function () {});
    });
  }

  // ---------- scroll motion fallback (browsers without scroll-linked animation) ----------
  var sds = [].slice.call(document.querySelectorAll('.sd'));
  var noSD = !(window.CSS && CSS.supports && CSS.supports('animation-timeline', 'view()'));
  if (sds.length && noSD && 'IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('js-io');
    var io2 = new IntersectionObserver(function (es) { es.forEach(function (e) { e.target.classList.toggle('in', e.isIntersecting); }); }, { rootMargin: '0px 0px -8% 0px' });
    sds.forEach(function (r) { io2.observe(r); });
  }

  // ---------- front page: audience paragraphs unfold as they scroll into view ----------
  var reveals = [].slice.call(document.querySelectorAll('.reveal'));
  if (reveals.length && 'IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('js-reveal');
    var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }); }, { rootMargin: '0px 0px -12% 0px' });
    reveals.forEach(function (r) { io.observe(r); });
  }

  // ---------- front page: when the next issue arrives (next Monday 8:45 a.m. New York time) ----------
  var nx = document.querySelector('[data-next-issue]');
  if (nx) try {
    var now = new Date(), ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    var add = (8 - ny.getDay()) % 7; if (add === 0 && (ny.getHours() > 8 || (ny.getHours() === 8 && ny.getMinutes() >= 45))) add = 7;
    var next = new Date(ny); next.setDate(ny.getDate() + add);
    var label = add === 0 ? 'this morning' : add === 1 ? 'tomorrow' : 'Monday, ' + next.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    nx.textContent = 'The next issue arrives ' + label + ' at 8:45 a.m. Eastern' + (add > 1 ? ', in ' + add + ' days.' : '.');
  } catch (e) {}

  // ---------- front page: show more stories (button stays under the list) ----------
  var mb = document.querySelector('[data-more-btn]'), ml = document.querySelector('[data-more]');
  if (mb && ml && window.matchMedia('(max-width: 1000px)').matches) { ml.classList.add('collapsed'); mb.addEventListener('click', function () { var o = ml.classList.toggle('collapsed'); mb.setAttribute('aria-expanded', o ? 'false' : 'true'); }); }

  // ---------- front page: three random Index terms from the mid-frequency pool ----------
  var tw = document.querySelector('[data-terms]'), tp = document.getElementById('term-pool');
  if (tw && tp) try {
    var pool = JSON.parse(tp.textContent), out = [];
    while (pool.length && out.length < 3) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    var e2 = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    tw.innerHTML = out.map(function (x) { return '<a class="it" href="/index/#' + encodeURIComponent(x.a) + '"><b>' + e2(x.t) + '</b><span>' + e2(x.d) + '</span></a>'; }).join('');
  } catch (e) {}

})();
