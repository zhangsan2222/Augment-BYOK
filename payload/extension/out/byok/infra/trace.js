"use strict";

const { debug } = require("./log");

function nowMs() {
  return Date.now();
}

function formatMs(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n >= 0 ? `${Math.floor(n)}ms` : "n/a";
}

async function withTiming(label, fn) {
  const lab = typeof label === "string" ? label : String(label ?? "");
  const t0 = nowMs();
  try {
    const res = await fn();
    debug(`${lab} ok (${formatMs(nowMs() - t0)})`);
    return res;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    debug(`${lab} FAIL (${formatMs(nowMs() - t0)}): ${m}`);
    throw err;
  }
}

async function* traceAsyncGenerator(label, src) {
  const lab = typeof label === "string" ? label : String(label ?? "");
  const t0 = nowMs();
  let items = 0;
  let ok = false;
  let errMsg = "";
  try {
    for await (const item of src) {
      items += 1;
      yield item;
    }
    ok = true;
  } catch (err) {
    errMsg = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const tail = errMsg ? ` err=${String(errMsg)}` : "";
    debug(`${lab} ${ok ? "done" : "closed"} (items=${items} ${formatMs(nowMs() - t0)})${tail}`);
  }
}

module.exports = { nowMs, withTiming, traceAsyncGenerator };

