/** Sentinel extractors: pull drift-immune, testid-anchored lines from settings SSR. */
import { readFileSync } from "node:fs";

function extract(html: string, testid: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`data-testid="${testid}"[\\s\\S]{0,400}?</p>`, "g");
  for (const m of html.matchAll(re)) {
    out.push(
      m[0]
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&mdash;/g, "—").replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}

function inputValues(html: string): string[] {
  return (html.match(/<input[^>]*value="[^"]*"[^>]*>/g) ?? [])
    .map((t) => (t.match(/type="([a-z]+)"/)?.[1] ?? "?") + ":" + (t.match(/value="([^"]*)"/)?.[1] ?? ""))
    .sort();
}

const [oldP, newP] = process.argv.slice(2);
const oldH = readFileSync(oldP, "utf8");
const newH = readFileSync(newP, "utf8");

for (const id of ["booking-attribution-split", "queue-reason-breakdown"]) {
  const a = extract(oldH, id).sort();
  const b = extract(newH, id).sort();
  console.log(`\n== ${id} ==`);
  console.log("old:", JSON.stringify(a));
  console.log("new:", JSON.stringify(b));
  console.log(a.join("|") === b.join("|") ? "IDENTICAL" : "*** DIFFERS ***");
}

const av = inputValues(oldH);
const bv = inputValues(newH);
const same = av.join("\n") === bv.join("\n");
console.log(`\n== input value attributes == old=${av.length} new=${bv.length} -> ${same ? "IDENTICAL" : "DIFFERS"}`);
if (!same) {
  const setA = new Set(av), setB = new Set(bv);
  console.log("only-old:", av.filter((x) => !setB.has(x)).slice(0, 20));
  console.log("only-new:", bv.filter((x) => !setA.has(x)).slice(0, 20));
}
