// Brevo account helpers for the dashboard. Read-only status, plus a one-click setup that registers
// our sender address and asks Brevo to report deliveries, bounces and complaints back to this platform.
// Neither sends any email.
const API = 'https://api.brevo.com/v3';

async function call(env, method, path, body) {
  const res = await fetch(API + path, { method, headers: { 'api-key': env.BREVO_API_KEY, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* some answers have no body */ }
  return { ok: res.ok, status: res.status, data };
}

const hookUrl = (site, env) => `${site.url}/api/hooks/brevo?key=${env.WEBHOOK_SECRET}`;
const sameHook = (w, site) => String(w.url || '').startsWith(`${site.url}/api/hooks/brevo`);
const domainOf = (email) => String(email || '').split('@')[1] || null;

export async function brevoStatus(env, site) {
  const from = env.FROM_EMAIL || null;
  if (!env.BREVO_API_KEY) return { configured: false, from, next: 'Store the Brevo API key in Cloudflare as the Worker secret BREVO_API_KEY.' };
  const [account, domains, senders, hooks] = await Promise.all([call(env, 'GET', '/account'), call(env, 'GET', '/senders/domains'), call(env, 'GET', '/senders'), call(env, 'GET', '/webhooks?type=transactional')]);
  if (account.status === 401) return { configured: true, key_valid: false, from, next: 'Brevo rejected the API key. Create a new key in Brevo and store it again.' };
  const d = (domains.data?.domains || []).find((x) => (x.domain_name || x.domain) === domainOf(from)) || null;
  const sender = (senders.data?.senders || []).find((s) => String(s.email).toLowerCase() === String(from).toLowerCase()) || null;
  const out = {
    configured: true, key_valid: account.ok, from,
    plan: (account.data?.plan || []).map((p) => ({ type: p.type, credits: p.credits ?? null })),
    api_sending_enabled: account.data?.relay?.enabled ?? null,
    domain: d ? { name: d.domain_name || d.domain, authenticated: !!d.authenticated, verified: !!d.verified } : null,
    sender: sender ? { email: sender.email, active: !!sender.active } : null,
    delivery_reports: (hooks.data?.webhooks || []).some((w) => sameHook(w, site)),
  };
  out.next = !from ? 'Set the sender address (FROM_EMAIL).'
    : !out.domain ? `Add ${domainOf(from)} as a sending domain in Brevo.`
    : !out.domain.authenticated ? 'In Brevo, open the domain and click Authenticate.'
    : !out.sender || !out.delivery_reports ? 'Click "Finish Brevo setup" below.'
    : out.api_sending_enabled === false ? 'Ask Brevo support to enable sending through the API for this account.'
    : 'Ready for an approved test send.';
  out.ready = out.next === 'Ready for an approved test send.';
  return out;
}

/** Create the sender address and the delivery-report webhook if they are missing. Sends no email. */
export async function brevoSetup(env, site) {
  if (!env.BREVO_API_KEY) return { ok: false, message: 'No Brevo API key is stored yet.' };
  if (!env.FROM_EMAIL) return { ok: false, message: 'No sender address (FROM_EMAIL) is set yet.' };
  if (!env.WEBHOOK_SECRET) return { ok: false, message: 'WEBHOOK_SECRET is not set.' };
  const done = [];
  const senders = await call(env, 'GET', '/senders');
  if (!(senders.data?.senders || []).some((s) => String(s.email).toLowerCase() === env.FROM_EMAIL.toLowerCase())) {
    const r = await call(env, 'POST', '/senders', { name: env.FROM_NAME || 'Prompted', email: env.FROM_EMAIL });
    if (!r.ok) return { ok: false, message: `Brevo would not add the sender (${r.status}): ${r.data?.message || 'no reason given'}` };
    done.push('sender added');
  } else done.push('sender already present');
  const hooks = await call(env, 'GET', '/webhooks?type=transactional');
  if (!(hooks.data?.webhooks || []).some((w) => sameHook(w, site))) {
    const r = await call(env, 'POST', '/webhooks', { url: hookUrl(site, env), description: 'Prompted platform: delivery, bounce and complaint reports', type: 'transactional',
      events: ['delivered', 'hardBounce', 'softBounce', 'blocked', 'spam', 'invalid', 'unsubscribed'] });
    if (!r.ok) return { ok: false, message: `Brevo would not register delivery reports (${r.status}): ${r.data?.message || 'no reason given'}`, done };
    done.push('delivery reports registered');
  } else done.push('delivery reports already registered');
  return { ok: true, done };
}
