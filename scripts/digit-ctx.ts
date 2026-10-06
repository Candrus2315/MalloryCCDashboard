/** Context probe: where does a digit token appear in each capture? */
import { readFileSync } from "node:fs";
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ").replace(/&rarr;|&#8594;/g, "→");
}
const [path, needle] = process.argv.slice(2);
const text = visibleText(readFileSync(path, "utf8"));
let idx = 0, n = 0;
while ((idx = text.indexOf(needle, idx)) !== -1 && n < 12) {
  console.log("  …" + text.slice(Math.max(0, idx - 60), idx + needle.length + 40).replace(/\n/g, "⏎") + "…");
  idx += needle.length; n++;
}
console.log(`(${needle}: ${n} shown)`);
