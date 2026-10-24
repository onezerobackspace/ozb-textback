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
       │  /voice         greeting (with texting disclosure) + <Record>
       │  /voice/done    voicemail ended          ──┐ first text to the caller
       │  /voice/status  call over (always comes) ──┘ (whichever is first; sent once)
       │  /recording     voicemail ready ─▶ owner: "Voicemail from (412) 555-0123, 0:42: <link>"
       │  /sms           caller's text  ─▶ owner: "From (412) 555-0123: ..."
       │                 owner's text   ─▶ last caller/texter, or "To 4125550123: ..."
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

**When the first text goes.** It isn't sent at `/voice`, because the caller
hasn't heard the disclosure yet. Two webhooks can send it, and whichever comes
first does:

- `/voice/done`, Record's `action`, which comes when the voicemail ends or
  times out. A caller who gets there heard the whole greeting.
- `/voice/status`, the number's call status callback, which comes when the call
  completes, however it ends. A hang-up during the greeting still triggers it.
  So does a caller who hangs up at the beep, which Record's `action` may not
  report. This one is the reliable trigger.

The claim `UPDATE calls SET texted = 1 WHERE texted = 0` makes sure only one
text goes out. A caller whose call lasted less than `min_call_seconds` (3 by
default) is not texted, because they couldn't have heard the disclosure.

**Who never gets the first text** (the reason is recorded in
`calls.why_not_texted`):

- `paused`: the client is paused.
- `anonymous`: a blocked or hidden number (Twilio's +266696687 and its
  relatives).
- `short-code`: a 5- or 6-digit sender.
- `invalid-number`: anything that isn't US/Canada E.164.
- `owner`: the owner's own cell.
- `own-number`: the client's own number.
- `opted-out`: the number opted out with this client.
- `recent`: the caller already got a first text from this client in the last 24
  hours. A first text that failed or went undelivered doesn't count, so the
  caller's next call tries again.
- `daily-cap`: the client already sent `daily_text_cap` first texts (50) in the
  last 24 hours. This is a brake on a robocall flood.
- `landline`: only when `lookup_landlines` = 1. It's off by default because each
  Twilio Lookup costs $0.008.
- `hung-up-early`: the call was shorter than `min_call_seconds`.

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
- **Plain-language opt-outs**, such as "stop texting me", "opt out", "don't
  text me", "remove me from your list", "wrong number" or "Stop!". Twilio
  doesn't recognise these, so the worker records the opt-out, sends one
  confirmation, and refuses every later send to that number. That includes the
  owner's replies, and the owner is told why. The patterns are kept narrow, so
  "can you stop by and text me the quote" is not an opt-out.
- **Twilio's keywords, when `twilio_opt_out` = 0.** If someone turns Twilio's
  handling off, the worker sends the confirmations and the HELP text itself.

The owner is told about every opt-out ("From (412) 555-0123: stop texting me
(opted out of texts)"), so they know to call instead. A send that Twilio refuses
with **21610**, either straight away or on a status callback, is also recorded
as an opt-out. Opt-outs are kept per client: an opt-out from one client's number
doesn't stop another client's texts.

There is one Twilio quirk to know. Twilio's default handling treats a bare "YES"
as an opt-in keyword and may send its own resubscribe reply. The worker passes
"Yes" on to the owner as an ordinary answer unless the person had opted out. To
stop Twilio's reply, put the number in a Messaging Service with Advanced
Opt-Out and remove YES from its opt-in keywords. That is an open choice.

**The owner's texts.** Anything the owner texts to the business number goes to
the latest person they heard from: the most recent caller, texter, or person
they wrote to with "To ...". Hidden numbers are skipped. To pick someone else,
the owner writes `To 412-555-0199: your estimate is ready`. Later replies then
follow that person. If a reply can't be sent, the owner gets a text from the
business number starting "Not sent: ...". From the owner, only an exact keyword
(STOP, HELP, or START after a STOP) counts as a keyword. Anything else is a
reply, including "Yes". Pictures a caller sends are mentioned in the text to
the owner but not forwarded.

**Usage.** The `usage` table counts each client's texts out, texts in and voice
minutes by Eastern calendar month. Minutes are each call's duration rounded up.
`/admin/usage` compares the total texts (out plus in) with `PLAN_TEXTS` (300)
and the minutes with `PLAN_MINUTES` (60). Going over the allowance only gets
reported; nothing is cut off.

**Retention.** A daily cron at 07:15 UTC deletes calls and texts older than 90
days. Before deleting a call row, it deletes the call's recording at Twilio
through the API. A recording Twilio won't delete keeps its row, so the next day's
run tries again. The cron deletes only recordings whose SIDs are in `calls`,
never "everything on the account", so nothing else that uses the account loses
its recordings. Opt-outs are kept forever. Usage counters, which hold no phone
numbers, are kept too. Twilio's own logs (message bodies, call records) are
separate: they follow Twilio's retention unless they're redacted or deleted
there. The privacy policy should be worded with that in mind.

## Admin API

All of these need the `x-admin-secret` header.

- `GET /admin/clients`: every client row.
- `GET /admin/usage?month=2026-10`: each client's counts, the allowance,
  `over_texts` and `over_minutes`. The current Eastern month is the default.
- `POST /admin/clients/<id>/status` with `{"status":"paused"|"active"}`. A paused
  client's callers hear "Sorry, we can't take your call right now. Please try
  again later." and get no text. Their opt-outs are still honoured, but nothing
  is passed on to the owner.

## Adding a client

`scripts/add-client.mjs <client.json>` checks the client and prints the INSERT.
It is a **dry run by default**. `--local` writes to the local D1, and `--remote`
writes to the real database (with `--env-file ../.env`). Before it builds the
INSERT, the script checks that:

- the numbers are E.164,
- the greeting has the disclosure,
- the first text starts with "<name>:", includes "Reply STOP", carries no link,
  makes no offer, and is no longer than 320 characters.

`scripts/clients/ozb.json` is OZB's own row. Its `number` stays empty until the
number is bought, and the script refuses it until then.

## Going live (OZB's own number)

The worker isn't deployed yet. Each step below changes something real, so each
one needs Ryan's go-ahead. Run the steps from this folder.

1. `npm install`, then `npm test`. The tests use no network.
2. `npm run whoami`. It must name hey.its.rlo@gmail.com's account.
3. Create the database with `npm run db:create`. Paste the `database_id` it
   prints into `wrangler.toml`, replacing the placeholder.
4. Apply the schema with `npm run db:migrate`.
5. Set the secrets: `npx wrangler secret put <NAME> --env-file ../.env` for each
   of these:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_API_KEY_SID`
   - `TWILIO_API_KEY_SECRET`
   - `TWILIO_AUTH_TOKEN`: the main account's token, from the Console. It isn't
     in `.env` yet.
   - `ADMIN_SECRET`: a new random value.
   - `VM_LINK_KEY`: a new random value.
6. Deploy with `npm run deploy`. Then check that
   https://textback.onezerobackspace.com/health answers `{"ok":true}`, and that
   an unsigned `POST /voice` gets a 403.
7. **Buy the toll-free number** on OZB's main account. OZB's own number lives
   on the main account; clients get subaccounts.
8. Point the number at the worker. In the Console, under the number's
   configuration:
   - Voice, "A call comes in": `POST https://textback.onezerobackspace.com/voice`
   - Voice, "Call status changes": `POST https://textback.onezerobackspace.com/voice/status`
   - Messaging, "A message comes in": `POST https://textback.onezerobackspace.com/sms`

   Message status callbacks are set on each send, so the number needs no
   setting for them.
9. **File the toll-free verification.** The submission is written out field by
   field, for review first. Texts fail with 30032 until it's approved; calls
   and voicemail work straight away.
10. Put the number in `scripts/clients/ozb.json`. Run
    `node scripts/add-client.mjs scripts/clients/ozb.json` to check it, then run
    it again with `--remote`.
11. On the Tello cell, dial `**61*1<toll-free number, 10 digits>#` (forward when
    unanswered). Test the flow from another phone:
    1. Call and let it ring out.
    2. Hear the greeting, leave a voicemail and hang up.
    3. Check that the voicemail link arrives on the cell.
    4. Once verification is approved, check the first text, reply from the
       cell, text STOP, then START.

Until the toll-free verification is approved, `/admin/usage` and the
`messages` table show the 30032 failures. A call whose text failed doesn't count
as texted, so once the number is approved, the caller's next call gets a text.

## Clients later: subaccounts and the business profile

The plan for each new client:

1. Create a subaccount named after the client.
2. Buy a toll-free number in the subaccount.
3. Set `TWILIO_AUTH_TOKEN_<sub SID>` from the subaccount's token.
4. File a toll-free verification with **the client's** legal name, EIN,
   address, website, privacy and terms pages, and the client's own greeting
   and first text as the opt-in proof and samples.
5. Add the client row with `twilio_subaccount_sid` set.
6. The client sets up conditional forwarding on their cell.

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
- `src/voice.js`: `/voice`, `/voice/done`, `/voice/status` and `/recording`.
- `src/sms.js`: `/sms` and `/status`.
- `src/send.js`: sending and the first-text rules.
- `src/rules.js`: wording, keywords and the owner's commands.
- `src/vm.js`: voicemail links.
- `src/admin.js`: the admin API.
- `src/retention.js`: the 90-day clean-up.
- `src/store.js`: database helpers.
- `src/phone.js`: phone number helpers.
- `migrations/0001_init.sql`: the schema.
- `test/`: node:test tests, with D1 over node:sqlite and a fake Twilio behind
  `fetch`.

For a local run, put made-up values in `.dev.vars`. Run
`npm run db:migrate:local`, then `npm run dev`. Never pass `--env-file` to a
local run.
