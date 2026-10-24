# ozb-textback

Missed-call text-back. When a call to a business goes unanswered, the
caller's carrier forwards it to the business's Twilio number. The caller hears
a short greeting that says a text is coming and can leave a voicemail. The
caller then gets one text, and the owner gets the voicemail as a link.
Replies go both ways through the business's number, so the owner's cell
number never reaches the customer.

One Zero Backspace is client #1. The design is multi-client from the start:
each later client gets its own Twilio subaccount, its own toll-free number
and its own toll-free verification. Clients never share a number.

```
Caller ──▶ business cell (no answer) ──forward──▶ client's toll-free number (Twilio)
                                                        │
       ┌───────────────── textback.onezerobackspace.com ┘
       │  /voice         greeting up to the end of the texting disclosure + <Redirect>
       │  /voice/heard   the disclosure played: rest of the greeting + <Record>
       │  /voice/done    voicemail ended          ──┐ first text to the caller, only if
       │  /voice/status  call over (always comes) ──┘ /voice/heard came (whichever is first; once)
       │  /recording     voicemail ready ─▶ owner, by email AND text: "Voicemail from (412) 555-0123, 0:42: <link>"
       │  /sms           caller's text  ─▶ owner: "From (412) 555-0123: ..."
       │                 owner's text   ─▶ "One Zero Backspace: ..." to the last person the owner heard
       │                                   from, or "To 4125550123: ..." (someone who called/texted);
       │                                   owner gets "Sent to (412) ..."
       │                 STOP/START/HELP and plain-language opt-outs
       │  /status        delivery status of every text this worker sends
       │  /vm/<id>       the owner's voicemail link (signed, 7 days), proxied from Twilio
       │  /admin/*       JSON for the CRM, behind ADMIN_SECRET
       └▶ D1 ozb_textback: clients, calls, messages, opt_outs, usage
```

## Security

The worker is public, with no Cloudflare Access in front, because Twilio
has to reach it. Each kind of request is guarded instead:

- **Every webhook is checked against `X-Twilio-Signature`.** The signature is
  HMAC-SHA1 over `PUBLIC_ORIGIN` + path + query + the sorted form fields. The
  key is the auth token of the account named in `AccountSid`. Anything else
  gets a 403: a missing or wrong signature, a body changed after signing, a
  signature made for another host or path, or an account we hold no token for.
  After that check, the number must belong to a client on that same account,
  so one subaccount's token can't drive another client's number.
- **Auth tokens: one secret per account.** Twilio signs with the auth token
  of the account that owns the number, and an API key can't stand in for it.
  The tokens are stored as follows:
  - OZB's main account: `TWILIO_AUTH_TOKEN`.
  - A client on a subaccount: `TWILIO_AUTH_TOKEN_<subaccount SID>`, e.g.
    `TWILIO_AUTH_TOKEN_AC0123...`. Set it when the client is added. A worker
    can hold 128 variables and secrets, which is plenty for now. Past that,
    the plan is to keep the tokens encrypted in D1 under a single key. The
    lookup is in one place, `authTokenFor` in `src/twilio.js`.
- **All REST calls use one API key** (`TWILIO_API_KEY_SID`/`SECRET`, created
  on the main account). The account in the URL picks the subaccount. Twilio
  lets a main account's credentials act on its subaccounts. Check that a
  Standard key can do this once the first subaccount exists. If it can't, give
  each subaccount its own key, stored the same way as its auth token.
- **Voicemail links** are `/vm/<call id>?e=<expiry>&s=<HMAC-SHA256 with
  VM_LINK_KEY>`. They last 7 days, and a link can't be minted for longer. The
  worker fetches the MP3 from Twilio with the API key, so the owner never
  needs a Twilio login, and the Twilio URL never leaves the worker.
- **`/admin/*`** needs the `x-admin-secret` header to equal `ADMIN_SECRET`,
  compared in constant time. If `ADMIN_SECRET` is unset, nothing matches.

## The rules

**Greeting.** It must say that a text is coming, that rates may apply, and
"Reply STOP" (see `hasDisclosure` in `src/rules.js`). `add-client` refuses a
greeting without them, and `/voice` adds the standard sentence if a greeting in
the database lacks it: *"We'll text you at this number about your call. Message
and data rates may apply. Reply STOP to opt out."* The disclosure always plays
before the beep. Carriers' implied consent covers people who text first, not
people who call, so this disclosure is the opt-in. It is published at
https://onezerobackspace.com/texting/ as the proof of opt-in. **Get legal review
before selling this to clients.**

**Only callers who heard the whole disclosure are texted.** The terms and the
/texting/ page promise that a caller who hangs up during the greeting gets no
text, so this can't be guessed from the call's length (OZB's disclosure ends
10-12 seconds in). Instead, `/voice` says the greeting only up to the end of
the disclosure sentence ("... Reply STOP to opt out."), then `<Redirect>`s to
`/voice/heard`. Twilio requests that only after the `<Say>` has finished; if
the caller hangs up first, the rest of the TwiML never runs. `/voice/heard`
sets `calls.heard_disclosure = 1`, says the rest of the greeting, and starts
the `<Record>`. (`splitGreeting` in `src/rules.js` finds the split, after the
sentence holding the last of "text", "rates may apply" and "Reply STOP".)

**When the first text goes.** It isn't sent during the call. Two webhooks can
send it, and whichever comes first does, but only for a call with
`heard_disclosure = 1`:

- `/voice/done`, Record's `action`, which comes when the voicemail ends or
  times out.
- `/voice/status`, the number's call status callback, which comes when the call
  completes, however it ends. It catches a caller who heard the disclosure and
  hung up at the beep, which Record's `action` may not report. For a caller
  who hung up during the greeting, it records `hung-up-in-greeting`.

`/voice/heard` always comes during the call, before either. The claim
`UPDATE calls SET texted = 1 WHERE texted = 0` makes sure only one text goes out.

**If the worker fails during a call** (a D1 error, say), the caller never
hears Twilio's "an application error has occurred". `/voice` answers with a
plain greeting that makes no texting promise ("Thanks for calling ... Sorry we
missed your call. Please leave a message after the tone.") and the beep, so
the voicemail is kept at Twilio (Console only: no row, so no notice and no
text). Other webhooks answer quietly and log the error. The number's "Primary
handler fails" URL (going-live step 8) covers the worker being unreachable.

**Who never gets the first text** (the reason is recorded in
`calls.why_not_texted`):

- `paused`: the client is paused.
- `anonymous`: a blocked or hidden number (Twilio's +266696687 and its
  relatives).
- `short-code`: a 5- or 6-digit sender.
- `invalid-number`: anything that isn't US/Canada E.164.
- `owner`: the owner's own cell.
- `own-number`: the client's own number.
- `hung-up-in-greeting`: the caller hung up before the disclosure finished.
- `caller-id-failed`: Twilio's STIR/SHAKEN result (`StirVerstat`, stored in
  `calls.stir_verstat`) starts with `TN-Validation-Failed`: the caller ID was
  probably spoofed, so the person at that number never called. A missing
  result, `No-TN-Validation` or a C attestation doesn't block: they're normal
  for forwarded calls and small carriers. `/admin/usage` shows what real
  forwarded calls carry, so this can be tightened once there's data.
- `opted-out`: the number opted out with this client.
- `recent`: the caller already got a first text from this client in the last 24
  hours. A first text that failed or went undelivered doesn't count, so the
  caller's next call tries again.
- `hourly-cap`: the client already sent `hourly_text_cap` first texts (8 by
  default; OZB 5) in the last hour. A spoofed-call run looks like a burst; real
  missed calls for a small trade don't. The owner is told once an hour.
- `daily-cap`: the client already sent `daily_text_cap` first texts (15 by
  default; OZB 10) in the last 24 hours. The owner is told too.
- `landline`: only when `lookup_landlines` = 1. It's off by default because each
  Twilio Lookup costs $0.008.

The text is `clients.first_text`, **sent exactly as written**: nothing is
appended, so it stays identical to the sample in the toll-free verification. It
names the business first, makes no offer, and ends with "Reply STOP to opt out."
It goes out immediately, as an informational reply to the caller's own call.
Pennsylvania's SB 992 limits telephone *solicitations* to 9am-7pm Mon-Sat, and
this text isn't one. Don't add offers to it.

**Opt-outs, without double confirmations.** Twilio's opt-out handling is on by
default for a toll-free number. It answers its own keywords, and after STOP it
blocks any further texts to that person. Its keywords are:

- STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPTOUT
- START, YES and UNSTOP
- HELP and INFO

The worker treats each kind of message like this:

- **Twilio's keywords, when `twilio_opt_out` = 1** (the default). The text must
  be exactly one keyword, ignoring case and spaces. The worker records the
  opt-out or opt-in and **sends nothing**, because Twilio already replied.
- **Any message with `OptOutType`.** Twilio sends this field with Advanced
  Opt-Out, which means it handled the message. The worker records it and sends
  nothing.
- **Plain-language opt-outs**, such as "stop texting me", "don't text me",
  "remove me from your list", or a whole message of "opt out", "wrong number"
  or "Stop!". Twilio doesn't recognise these, so the worker records the
  opt-out, sends one confirmation (`stopText`, published on /texting/), and
  refuses every later send to that number. That includes the owner's replies,
  and the owner is told why. The patterns are kept narrow: "can you stop by and
  text me the quote" is not an opt-out, and neither is "I called the wrong
  number earlier, I meant to book the roof job". Phrases like "wrong number",
  "opt out" or "unsubscribe" inside a longer message are passed to the owner
  with "(might be asking to stop texts: check before replying)", and nobody is
  opted out.
- **Twilio's keywords, when `twilio_opt_out` = 0.** If someone turns Twilio's
  handling off, the worker sends the confirmations and the HELP text itself.

The owner is told about every opt-out ("From (412) 555-0123: stop texting me
(opted out of texts)"), so they know to call instead. A send that Twilio refuses
with **21610**, either straight away or on a status callback, is also recorded
as an opt-out. Opt-outs are kept per client: an opt-out from one client's number
doesn't stop another client's texts.

**The HELP and START replies must be the published ones.** /texting/ quotes
the HELP and START replies word for word, and with `twilio_opt_out` = 1 Twilio
sends them, not this worker. So each client's number goes in a **Messaging
Service with Advanced Opt-Out**, with its custom HELP and START (opt-in)
replies set to exactly `helpText` and `startText` (`node scripts/wording.mjs
<client.json>` prints them), and YES removed from the opt-in keywords (Twilio's
default treats a bare "YES" as a resubscribe; the worker passes "Yes" on to the
owner as an answer). Twilio's docs say that on toll-free numbers STOP can't be
customised (the network answers it, which /texting/ says), and that a custom
START reply goes out alongside the carrier's own, which /texting/ also says.
They don't say whether a custom HELP reply works on toll-free: **test it by
texting HELP before filing.** If only a generic reply comes back, change the
HELP section of /texting/ and the draft's HelpMessageSample to describe it
before filing. `rules.js` sends the same wording itself when `twilio_opt_out`
= 0, and `test/wording.test.mjs` checks that every quote on /texting/ is what
the worker uses.

**The owner's texts.** Anything the owner texts to the business number goes to
the latest person the owner heard from: the newest caller whose voicemail
reached the owner, texter, or person the owner wrote to with "To ...". A call
the owner was never told about (a hang-up, a robocall, a call with no
voicemail) doesn't count, so it can't take over a reply meant for someone
else. Hidden numbers are skipped. To pick someone else, the owner writes
`To 412-555-0199: your estimate is ready`. That only reaches a number that
called or texted the line in the last 60 days: the owner's cell is public, an
SMS sender can be faked, and the verified number mustn't become a relay to
anyone. Later replies then follow that person.

Each reply goes out as "One Zero Backspace: <the owner's words>", so every text
from the line names the business, and the owner gets a receipt, "Sent to (412)
555-0123.", so a reply that went to someone unexpected (or one sent by someone
faking the owner's number) shows on the owner's phone. At most 30 replies an
hour are relayed. If a reply can't be sent, the owner gets a text from the
business number starting "Not sent: ...", including when the client is paused
(once a day). From the owner, only an exact keyword (STOP, HELP, or START after
a STOP) counts as a keyword. Anything else is a reply, including "Yes".
Pictures a caller sends are mentioned in the text to the owner but not
forwarded.

**Floods.** A caller's texts are passed to the owner at most 10 an hour per
sender and 60 an hour per client. Past that, the owner gets one "More texts
from (412) ... aren't being passed on for now" notice an hour; the texts are
still saved in `messages`.

**Email to the owner.** Every voicemail is emailed to `owner_email` as well as
texted (`src/notify.js`, Cloudflare's `send_email` binding, as the CRM uses).
Texts from a toll-free number fail with 30032 until its verification is
approved, and Twilio's 201 hides that until the status callback, so email is
the channel that works from day one. A forwarded text or notice to the owner
that fails (on its status callback) is emailed then. A failed text is taken
back off `texts_out`.

**Usage.** The `usage` table counts each client's texts out, texts in and voice
minutes by Eastern calendar month. Minutes are each call's duration rounded up.
`/admin/usage` compares the total texts (out plus in) with `PLAN_TEXTS` (300)
and the minutes with `PLAN_MINUTES` (60). Going over the allowance only gets
reported; nothing is cut off.

**Retention.** The privacy policy says call details, texts and voicemails are
deleted after 90 days, here and at Twilio. A daily cron at 07:15 UTC does
that, for rows older than 90 days:

- each text's Message resource at Twilio (`DELETE /Messages/<sid>`: its body
  and numbers), then the row;
- each call's recording (`DELETE /Recordings/<sid>`), and for a call with no
  recording on file, any recording Twilio has for it (`GET
  /Recordings.json?CallSid=`), which catches a voicemail whose `/recording`
  callback never arrived;
- then the call record itself (`DELETE /Calls/<sid>`), then the row.

A row is only deleted once Twilio confirms its copy is gone (204, or 404 for
already gone), so the SID is never lost and a failure is tried again the next
day. Each run makes at most 200 Twilio requests and works off a backlog over
several days. Only what this worker knows about is touched, never "everything
on the account". Opt-outs are kept forever. Usage counters, which hold no phone
numbers, are kept too. Emailed voicemail notices stay in the owner's mailbox;
their links stop working after 7 days and the recording is gone after 90.

## Admin API

All of these need the `x-admin-secret` header.

- `GET /admin/clients`: every client row.
- `GET /admin/usage?month=2026-10`: each client's counts, the allowance,
  `over_texts` and `over_minutes`. The current Eastern month is the default.
  Also, for the last 30 days, `calls_30_days` (texted, or each
  `why_not_texted` reason) and `caller_id_30_days` (each `StirVerstat` value),
  so a robocall wave shows up.
- `POST /admin/clients/<id>/status` with `{"status":"paused"|"active"}`. A paused
  client's callers hear "Sorry, we can't take your call right now. Please try
  again later." and get no text. Their opt-outs are still honoured, but nothing
  is passed on to the owner, and the owner's replies aren't relayed (the owner
  is told so, once a day).

## Adding a client

`scripts/add-client.mjs <client.json>` checks the client and prints the INSERT.
It is a **dry run by default**. `--local` writes to the local D1, and `--remote`
writes to the real database (with `--env-file ../.env`). Before it builds the
INSERT, the script checks that:

- the numbers are E.164,
- `owner_email` is set (voicemails are emailed there),
- `support_email` or `support_phone` is set (the HELP reply names it),
- `twilio_opt_out` is set explicitly, so it's a decision, not a default,
- the greeting has the disclosure,
- the first text starts with "<name>:", includes "Reply STOP", carries no link,
  makes no offer, and is no longer than 320 characters.

`scripts/clients/ozb.json` is OZB's own row. Its `number` stays empty until the
number is bought, and the script refuses it until then. The tests use it too.

`scripts/wording.mjs <client.json>` prints everything callers hear and get,
word for word: the greeting (and where it splits at `/voice/heard`), the first
text, and the HELP, START and plain-language STOP replies. Use it for the
client's texting page, the verification samples and the Messaging Service's
custom replies, so all of them match. For OZB, `test/wording.test.mjs` checks
the site's /texting/ page against it.

## Going live (OZB's own number)

The worker isn't deployed yet. Each step below changes something real, so each
one needs Ryan's go-ahead. Run the steps from this folder.

1. `npm install`, then `npm test`. The tests use no network.
2. `npm run whoami`. It must name hey.its.rlo@gmail.com's account.
3. Create the database with `npm run db:create`. Paste the `database_id` it
   prints into `wrangler.toml`, replacing the placeholder.
4. Apply the schema with `npm run db:migrate`.
5. Deploy with `npm run deploy`. Deploying before the secrets are set means
   `wrangler secret put` won't stop to ask whether to create the worker. Until
   step 6, every webhook gets a 403, which is harmless: no number points here yet.
6. Set the secrets. `wrangler secret put NAME` never takes the value from
   `.env`: `--env-file ../.env` only supplies the Cloudflare login, and the value
   comes from stdin, or from a prompt if nothing is piped in. So pipe each one
   in, which keeps it off the screen. In Git Bash, from this folder:

   ```bash
   put() { grep "^$1=" ../.env | head -1 | cut -d= -f2- | tr -d '\r\n' | sed 's/^"//; s/"$//' \
             | npx wrangler secret put "${2:-$1}" --env-file ../.env; }
   put TWILIO_ACCOUNT_SID
   put TWILIO_API_KEY_SID
   put TWILIO_API_KEY_SECRET
   put TWILIO_AUTH_TOKEN              # the main account's auth token (already in .env)
   # Two new random values, kept in ../.env so the admin secret can be used later:
   echo "TEXTBACK_ADMIN_SECRET=$(openssl rand -hex 32)" >> ../.env
   echo "TEXTBACK_VM_LINK_KEY=$(openssl rand -hex 32)" >> ../.env
   put TEXTBACK_ADMIN_SECRET ADMIN_SECRET
   put TEXTBACK_VM_LINK_KEY VM_LINK_KEY
   ```

   Then `npx wrangler secret list --env-file ../.env` must list all six names. An
   empty `TWILIO_AUTH_TOKEN` would make every webhook a 403, and an empty
   `VM_LINK_KEY` would stop voicemail notices.
7. Check that https://textback.onezerobackspace.com/health answers
   `{"ok":true}`, and that an unsigned `POST /voice` gets a 403. A signed one is
   checked in step 13, with a real call.
8. **Buy the toll-free number** on OZB's main account. OZB's own number lives
   on the main account; clients get subaccounts.
9. Point the number at the worker. In the Console, under the number's
   configuration:
   - Voice, "A call comes in": `POST https://textback.onezerobackspace.com/voice`
   - Voice, "Primary handler fails": a TwiML Bin, so a caller still gets the
     beep if the worker is unreachable. Make two Bins. The first, "textback
     fallback", holds
     `<Response><Say>Sorry we missed your call. Please leave a message after the tone.</Say><Record maxLength="120" action="<URL of the second Bin>"/></Response>`.
     Its greeting makes no texting promise, because no text will go. The
     second, "textback goodbye", holds
     `<Response><Say>Thank you. Goodbye.</Say><Hangup/></Response>`. Without
     the `action`, Record would post back to the first Bin and loop the
     greeting. Recordings made this way are only in the Console, with no
     notice, so also turn on a Twilio Alerts email for error 11200 (the worker
     didn't answer).
   - Voice, "Call status changes": `POST https://textback.onezerobackspace.com/voice/status`
   - Messaging, "A message comes in": `POST https://textback.onezerobackspace.com/sms`

   Message status callbacks are set on each send, so the number needs no
   setting for them. `/voice/heard` is reached by the TwiML's `<Redirect>`, so
   it needs no setting either.
10. **Messaging Service with Advanced Opt-Out.** Create a Messaging Service, add
    the number to it, and set "Incoming messages" to *Defer to sender's
    webhook*, so texts still reach `/sms`. Under Opt-Out Management, turn on
    Advanced Opt-Out:
    - Set the custom HELP and opt-in (START) replies to exactly what
      `node scripts/wording.mjs scripts/clients/ozb.json` prints as `help` and
      `start`. These are the replies /texting/ publishes word for word.
    - Remove YES from the opt-in keywords.

    STOP can't be customised on a toll-free number, because the network answers
    it, and /texting/ says so.
11. **File the toll-free verification** once the site's /privacy/, /terms/ and
    /texting/ pages are live (scratchpad draft, reviewed first). Texts from the
    number, including those to the owner, fail with 30032 until it's approved.
    Voicemails still reach the owner by email.
12. Put the number in `scripts/clients/ozb.json`. Run
    `node scripts/add-client.mjs scripts/clients/ozb.json` to check it, then run
    it again with `--remote`.
13. **Before approval, test by calling the toll-free number directly** from
    another phone. Don't forward the Tello cell yet, or real customers'
    voicemails would only go to email and the Console for the 3-5 days of
    review.
    1. Call, hear the whole greeting, leave a voicemail. The email with the
       voicemail link should arrive at ryan@onezerobackspace.com, and the link
       should play. The texts (to the caller and the cell) fail with 30032 for
       now. That's expected, and it's visible in `/admin/usage` and `messages`.
    2. Call again from a third phone and hang up halfway through the greeting.
       `calls.why_not_texted` should say `hung-up-in-greeting`.
    3. Look at `caller_id_30_days` in `/admin/usage` to see what `StirVerstat`
       real calls carry.
14. **Once the verification is approved:**
    1. Text HELP to the number and check that the reply is the /texting/ one
       word for word; do the same with STOP, then START. If HELP gets a generic
       reply instead, change /texting/ (see "The HELP and START replies").
    2. Call it directly: the first text should arrive. Reply to it, and answer
       from the cell. The reply should start "One Zero Backspace:", and the cell
       should get "Sent to ...".
15. **Then forward the Tello cell, for all three kinds of missed call**, not just
    no-answer. A declined call, a call while on another call, or Do Not Disturb
    counts as "busy" (**67), and a phone that's off, out of signal or in
    airplane mode counts as "unreachable" (**62). Each is set separately, and
    by default all three go to Tello voicemail. Dial
    `**004*1<toll-free number, 10 digits>#` (all conditional forwarding). If
    Tello rejects that, dial each one: `**61*1<n>#`, `**62*1<n>#`, `**67*1<n>#`.
    Optionally set the ring time with `**61*1<n>**20#`. Check each with
    `*#61#`, `*#62#` and `*#67#`. First, make sure Tello accepts a toll-free
    number as a forwarding destination. You can try forwarding to another
    phone first. Then test from another phone, and for each case confirm
    that the greeting plays and the voicemail email and text arrive:
    1. Let it ring out.
    2. Tap Decline.
    3. Call while the cell is on another call.
    4. Call with the cell in airplane mode.

A call whose text failed with 30032 doesn't count as texted, so once the number
is approved, the caller's next call gets a text.

## Clients later: subaccounts and the business profile

The plan for each new client:

1. Create a subaccount named after the client.
2. Buy a toll-free number in the subaccount.
3. Set `TWILIO_AUTH_TOKEN_<sub SID>` from the subaccount's token.
4. File a toll-free verification with **the client's** legal name, EIN,
   address, website, privacy and terms pages, and the client's own greeting
   and first text as the opt-in proof and samples.
5. Put the number in a Messaging Service with Advanced Opt-Out, with the
   client's own HELP and START replies (`scripts/wording.mjs`), as in going-live
   step 10. Publish the same wording on the client's own texting page.
6. Add the client row with `twilio_subaccount_sid` set.
7. Once the verification is approved, the client forwards all three kinds of
   missed call on their cell (no answer, busy, unreachable), as in going-live
   step 15. Their carrier's codes may differ.

The client's number, texts and recordings all live in their subaccount, which
keeps billing visible per client and lets a client leave cleanly.

OZB's Primary Business Profile was created as **Direct**, not ISV, and is still
pending approval (as of 2026-10-23). Direct is right for OZB's own number. To
file toll-free verifications for clients, Twilio may want an ISV profile or a
secondary profile per client. Ask Twilio support before client #2 whether the
Direct profile can be changed or needs a new one. Nothing in this worker depends
on the profile type.

A client's legal pages should be on the client's own domain, with the client's
address: a Starter site does this. A thin page hosted by OZB is likely to be
rejected.

## Files

- `src/index.js`: the router and the cron.
- `src/twilio.js`: signature checks, the REST client and TwiML helpers.
- `src/voice.js`: `/voice`, `/voice/heard`, `/voice/done`, `/voice/status` and `/recording`.
- `src/sms.js`: `/sms` and `/status`.
- `src/send.js`: sending and the first-text rules.
- `src/notify.js`: email to the owner.
- `src/rules.js`: wording, keywords and the owner's commands.
- `src/vm.js`: voicemail links.
- `src/admin.js`: the admin API.
- `src/retention.js`: the 90-day clean-up.
- `src/store.js`: database helpers.
- `src/phone.js`: phone number helpers.
- `migrations/0001_init.sql`: the schema. Nothing has been applied anywhere
  yet, so it was edited in place on 2026-10-24 rather than given a second
  migration.
- `scripts/add-client.mjs`, `scripts/wording.mjs`, `scripts/clients/ozb.json`.
- `test/`: node:test tests, with D1 over node:sqlite and a fake Twilio behind
  `fetch`.

For a local run, put made-up values in `.dev.vars`. Run
`npm run db:migrate:local`, then `npm run dev`. Never pass `--env-file` to a
local run.
