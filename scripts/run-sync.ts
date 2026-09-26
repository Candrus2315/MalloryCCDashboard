/**
 * Server-side SYNC NOW — invokes the exact routine the syncNow server function
 * uses (runDemoSync), bypassing the UI + passphrase gate. Logs progress.
 */
import { runDemoSync } from "../src/server/sync/run";
const t0 = Date.now();
const res = await runDemoSync();
console.log("SYNC RESULT", JSON.stringify(res, null, 1));
console.log("duration_s", Math.round((Date.now() - t0) / 1000));
process.exit(0);
