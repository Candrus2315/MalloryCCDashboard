const j = JSON.parse(await Bun.file("scratch/s5-attrib-results.json").text());
const r = (j._allResults as unknown[])[0] as Record<string, unknown>;
console.log("allResults row keys:", Object.keys(r));
console.log("row:", JSON.stringify(r).slice(0, 420));
console.log("amb4:", JSON.stringify(j.fourCurrentlyAmbiguousBecome).slice(0, 320));
try {
  const rep = JSON.parse(await Bun.file("scratch/s5-report.json").text());
  console.log("s5-report keys:", Object.keys(rep));
} catch (e) { console.log("s5-report parse fail:", String(e).slice(0, 80)); }
