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

  // Soft reading gate. The full text is in the page; this is an invitation, not access control.
  var gate = document.querySelector('[data-gate]');
  if (gate) {
    var rest = document.querySelector('[data-gated]');
    var open = function () { rest.classList.remove('gate-fade'); gate.hidden = true; };
    if (!local.get('prompted_reader') && !/[?&]reader=1/.test(location.search)) {
      rest.classList.add('gate-fade'); gate.hidden = false;
      gate.querySelector('.skip-gate').addEventListener('click', function () { local.set('prompted_reader', '1'); open(); });
      document.addEventListener('prompted:subscribed', function () { setTimeout(open, 900); });
    }
    if (location.hash) { open(); }
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
      if (!full && !loading) { loading = true; fetch(box.dataset.search).then(function (r) { return r.json(); }).then(function (j) { full = j; run(); }).catch(function () {}); }
      run();
    });
  }
})();
