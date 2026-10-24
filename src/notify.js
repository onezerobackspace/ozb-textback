// Email to the owner: a second channel that doesn't depend on the toll-free
// number. Texts from an unverified (or pending) toll-free number fail with
// 30032, and Twilio's 201 hides that until the status callback, so a
// voicemail notice by text alone could be lost. Every voicemail is emailed as
// well as texted, and a forwarded text or notice that fails is emailed then.
//
// Sent through Cloudflare's send_email binding (EMAIL), the same way the CRM
// sends: env.EMAIL.send({ from, to, subject, text }). MAIL_FROM must be one of
// the binding's allowed_sender_addresses (wrangler.toml).

/** Emails the client's owner. True when it went; false when it couldn't (no binding, no address, or an error). */
export async function emailOwner(env, client, { subject, text }) {
  if (!env.EMAIL || !env.MAIL_FROM || !client?.owner_email) return false;
  const from = env.MAIL_FROM_NAME ? { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME } : env.MAIL_FROM;
  try {
    await env.EMAIL.send({ from, to: client.owner_email, subject: String(subject).slice(0, 200), text: String(text) });
    return true;
  } catch (e) {
    console.log("email to owner failed", client.id, String(e?.message || e).slice(0, 200));
    return false;
  }
}
