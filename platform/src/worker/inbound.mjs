// Cloudflare Email Routing hands mail for one address on our own domain (INBOUND_CHECK_ADDRESS) to this
// Worker. We keep the headers that show how a real receiving server judged our test email (SPF, DKIM,
// DMARC, ARC, List-Unsubscribe) so authentication can be verified without anyone's inbox. Mail to any
// other address is never handled here (it is forwarded by the catch-all rule as before).
const KEEP = /^(authentication-results|arc-authentication-results|received-spf|dkim-signature|from|to|subject|date|message-id|list-unsubscribe|list-unsubscribe-post|reply-to|return-path|feedback-id|x-ses-outgoing|mime-version|content-type)$/i;

export async function handleInbound(message, env) {
  const to = String(message.to || '').toLowerCase();
  if (!env.INBOUND_CHECK_ADDRESS || to !== env.INBOUND_CHECK_ADDRESS.toLowerCase()) { message.setReject('Unknown address'); return; }
  const headers = {};
  for (const [k, v] of message.headers) if (KEEP.test(k)) headers[k.toLowerCase()] = headers[k.toLowerCase()] ? headers[k.toLowerCase()] + '\n' + v : String(v).slice(0, 4000);
  // Only accept mail claiming to be from our own sender: this mailbox is for our tests, not the public.
  if (!/readprompted\.org/i.test(String(message.from || ''))) { message.setReject('Not accepted'); return; }
  await env.DB.prepare('INSERT INTO inbound_checks (received_at, mail_from, rcpt_to, subject, headers) VALUES (?, ?, ?, ?, ?)')
    .bind(new Date().toISOString(), String(message.from || '').slice(0, 200), to, String(message.headers.get('subject') || '').slice(0, 300), JSON.stringify(headers)).run();
  await env.DB.prepare('DELETE FROM inbound_checks WHERE id NOT IN (SELECT id FROM inbound_checks ORDER BY id DESC LIMIT 50)').run();
}

/** Plain reading of the receiving server's verdicts for the dashboard. */
export function authVerdicts(headers) {
  const ar = [headers['authentication-results'], headers['arc-authentication-results']].filter(Boolean).join('\n');
  const pick = (k) => (new RegExp(`\\b${k}=(\\w+)`, 'i').exec(ar) || [])[1] || null;
  // Received-SPF judges the envelope sender (Amazon's bounce address on our MAIL FROM domain): that is the SPF that DMARC can use.
  const rspf = (/^(\w+)/.exec(headers['received-spf'] || '') || [])[1] || null;
  return { spf: rspf || pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc'), list_unsubscribe: !!headers['list-unsubscribe'], one_click: /One-Click/i.test(headers['list-unsubscribe-post'] || '') };
}
