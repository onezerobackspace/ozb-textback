#!/usr/bin/env node
// Prints, word for word, everything a client's callers hear and get: the
// greeting (and where the call splits at /voice/heard), the first text, and
// the HELP, START and plain-language STOP replies. Use it to fill in the
// client's texting page, the toll-free verification samples, and the
// Messaging Service's custom HELP and START replies, so all of them match
// what the worker says and sends. Reads nothing but the client file.
//
//   node scripts/wording.mjs scripts/clients/ozb.json

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { spokenGreeting, splitGreeting, helpText, startText, stopText } from "../src/rules.js";

/** The client's published wording, by name. */
export function wording(c) {
  const [disclosed, rest] = splitGreeting(c.greeting);
  return {
    greeting: spokenGreeting(c.greeting),
    greeting_until_disclosure: disclosed,
    greeting_after_disclosure: rest,
    first_text: c.first_text,
    help: helpText(c),
    start: startText(c),
    stop_plain_language: stopText(c),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error("usage: node scripts/wording.mjs <client.json>"); process.exit(2); }
  const w = wording(JSON.parse(readFileSync(file, "utf8")));
  for (const [k, v] of Object.entries(w)) console.log(`${k}:\n  ${v}\n`);
}
