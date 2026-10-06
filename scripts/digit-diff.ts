/**
 * Digit-identity gate (wave 3): SSR number-multiset diff old-vs-new.
 * Usage: bun scripts/digit-diff.ts <old.html> <new.html> <label>
 * Extracts visible text from SSR HTML, tokenizes digit runs, compares bags.
 * Also prints the largest additive/removed TEXT tokens (for the PR body).
 */
import { readFileSync } from "node:fs";

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&rarr;|&#8594;/g, "→");
}

function digits(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of text.match(/\d+/g) ?? []) m.set(d, (m.get(d) ?? 0) + 1);
  return m;
}

function words(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of text.match(/[A-Za-z][A-Za-z'’\-]{2,}/g) ?? []) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

function bagDiff(oldM: Map<string, number>, newM: Map<string, number>) {
  const added: [string, number][] = [];
  const removed: [string, number][] = [];
  for (const [k, v] of newM) if ((oldM.get(k) ?? 0) < v) added.push([k, v - (oldM.get(k) ?? 0)]);
  for (const [k, v] of oldM) if ((newM.get(k) ?? 0) < v) removed.push([k, v - (newM.get(k) ?? 0)]);
  added.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  removed.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { added, removed };
}

const [oldPath, newPath, label] = process.argv.slice(2);
const oldText = visibleText(readFileSync(oldPath, "utf8"));
const newText = visibleText(readFileSync(newPath, "utf8"));

// exclude the live-drift "Last synced Xh Ym ago" clock (per gate instruction)
const stripClock = (t: string) => t.replace(/Last synced \d+h \d+m ago/g, " ");
const o = stripClock(oldText), n = stripClock(newText);

const dd = bagDiff(digits(o), digits(n));
const wd = bagDiff(words(o), words(n));

console.log(`=== ${label} ===`);
console.log(`digit tokens: old=${[...digits(o).values()].reduce((a, b) => a + b, 0)} new=${[...digits(n).values()].reduce((a, b) => a + b, 0)}`);
console.log(`\n-- ADDED digit tokens (+count) --`);
for (const [k, v] of dd.added) console.log(`  +${v} "${k}"`);
console.log(`\n-- REMOVED digit tokens (-count) --`);
for (const [k, v] of dd.removed) console.log(`  -${v} "${k}"`);
console.log(`\n-- ADDED word tokens with count>=2 (top 60) --`);
for (const [k, v] of wd.added.filter(([, v]) => v >= 2).slice(0, 60)) console.log(`  +${v} "${k}"`);
console.log(`\n-- REMOVED word tokens with count>=2 (top 60) --`);
for (const [k, v] of wd.removed.filter(([, v]) => v >= 2).slice(0, 60)) console.log(`  -${v} "${k}"`);
