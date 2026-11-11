// Sender-domain authentication check. Read-only DNS lookups over HTTPS; nothing is changed anywhere.
// Answers one question before a domain is trusted for sending: would mail from it authenticate?
const DKIM_SELECTORS = { brevo: ['brevo1', 'brevo2', 'mail'], resend: ['resend'], google: ['google'] };

async function lookup(name, type) {
  const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' } });
  if (!res.ok) throw new Error(`DNS lookup failed (${res.status})`);
  const j = await res.json();
  return (j.Answer || []).map((a) => String(a.data).replace(/^"|"$/g, '').replace(/" "/g, ''));
}

export async function checkDomain(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new Error('That does not look like a domain name.');
  const out = { domain: d, checked_at: new Date().toISOString(), findings: [] };
  const add = (level, item, message) => out.findings.push({ level, item, message });
  const free = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'aol.com', 'proton.me'];
  if (free.includes(d)) { add('info', 'domain', 'This is a mailbox provider\'s own domain. Its mail authenticates as the provider, and its reputation is tied to the individual account, which you cannot build or monitor.'); out.ready = false; return out; }
  const [txt, dmarc, mx] = await Promise.all([lookup(d, 'TXT'), lookup('_dmarc.' + d, 'TXT'), lookup(d, 'MX')]);
  const spf = txt.filter((t) => /^v=spf1/i.test(t));
  out.spf = spf[0] || null;
  if (!spf.length) add('error', 'SPF', 'No SPF record. Add the TXT record your sending provider gives you.');
  else if (spf.length > 1) add('error', 'SPF', 'More than one SPF record. Mail servers treat that as a failure; merge them into one.');
  else if (/\+all/i.test(spf[0])) add('error', 'SPF', 'The SPF record ends in +all, which lets anyone send as this domain.');
  else add('ok', 'SPF', 'One SPF record found.');
  const dm = dmarc.find((t) => /^v=DMARC1/i.test(t));
  out.dmarc = dm || null;
  if (!dm) add('error', 'DMARC', 'No DMARC record at _dmarc.' + d + '. Gmail and Yahoo expect one. Start with: v=DMARC1; p=none; rua=mailto:<an address you read>');
  else {
    const policy = (/;\s*p=([a-z]+)/i.exec(dm) || [])[1];
    add(policy === 'none' ? 'warn' : 'ok', 'DMARC', policy === 'none' ? 'DMARC is present with p=none (monitoring only). Fine while warming up; move to quarantine once reports are clean.' : `DMARC is present with p=${policy}.`);
  }
  out.dkim = {};
  for (const [provider, selectors] of Object.entries(DKIM_SELECTORS)) {
    for (const sel of selectors) {
      const name = `${sel}._domainkey.${d}`;
      const found = [...(await lookup(name, 'TXT')), ...(await lookup(name, 'CNAME'))];
      if (found.length) { out.dkim[provider] = sel; break; }
    }
  }
  if (Object.keys(out.dkim).length) add('ok', 'DKIM', 'Signing key published for: ' + Object.entries(out.dkim).map(([p, s]) => `${p} (${s})`).join(', ') + '.');
  else add('error', 'DKIM', 'No DKIM key found for Brevo, Resend or Google. Add the DKIM records your sending provider gives you.');
  if (!mx.length) add('warn', 'MX', 'The domain cannot receive mail (no MX record). Replies and bounce notices to this domain will be lost; set up free forwarding.');
  else add('ok', 'MX', 'The domain can receive mail.');
  out.ready = !out.findings.some((f) => f.level === 'error');
  return out;
}
