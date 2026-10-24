// The published opt-in record must match what the worker actually says and
// sends. onezerobackspace.com/texting/ quotes OZB's greeting and texts "word for
// word", and Twilio's reviewer compares it with the verification samples. This
// reads the site's page (the sibling repo, ../site) and checks each quote.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { OZB_FILE } from "./helpers.mjs";
import { wording } from "../scripts/wording.mjs";

const PAGE = new URL("../../site/public/texting/index.html", import.meta.url);
const ENTITIES = { amp: "&", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", nbsp: " ", quot: '"', apos: "'", "#39": "'" };

/** The page's visible text: tags out, entities decoded, spaces collapsed. */
function pageText() {
  const html = readFileSync(PAGE, "utf8");
  return html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m).replace(/\s+/g, " ");
}

/** Each <blockquote> on the page, as text. */
function quotes() {
  const html = readFileSync(PAGE, "utf8");
  return [...html.matchAll(/<blockquote>([\s\S]*?)<\/blockquote>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/&(#?\w+);/g, (x, e) => ENTITIES[e] ?? x).replace(/\s+/g, " ").trim());
}

const skip = existsSync(PAGE) ? false : "the site repo isn't next to this one";

test("/texting/ quotes OZB's greeting, first text and HELP/START/STOP replies exactly as the worker uses them", { skip }, () => {
  const w = wording({ ...OZB_FILE, number: "+18335550100" });
  const text = pageText();
  for (const k of ["greeting", "first_text", "help", "start", "stop_plain_language"]) {
    assert.ok(text.includes(w[k]), `${k} not on /texting/ word for word:\n  ${w[k]}`);
  }
});

test("every quote on /texting/ is something the worker says or sends (no stale wording)", { skip }, () => {
  const w = wording({ ...OZB_FILE, number: "+18335550100" });
  const known = [w.greeting, w.first_text, w.help, w.start, w.stop_plain_language];
  for (const q of quotes()) {
    const bare = q.replace(/^“|”$/g, "");
    assert.ok(known.includes(bare), `quoted on /texting/ but not used by the worker:\n  ${bare}`);
  }
});

test("the texts are plain GSM characters, so they match the page and stay one segment each where they can", () => {
  const w = wording({ ...OZB_FILE, number: "+18335550100" });
  for (const k of ["first_text", "help", "start", "stop_plain_language"]) {
    assert.doesNotMatch(w[k], /[‘’“”–—]/, `${k} has a curly quote or dash, which makes it a 70-character UCS-2 text`);
  }
  assert.ok(w.first_text.length <= 160, `first text is one segment: ${w.first_text.length}`);
});
