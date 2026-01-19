"use strict";

const { normalizeString } = require("../../infra/util");

function summarizeToolDefs(toolDefs, { maxNames = 12 } = {}) {
  const defs = Array.isArray(toolDefs) ? toolDefs : [];
  const names = [];
  const seen = new Set();
  for (const d of defs) {
    if (!d || typeof d !== "object") continue;
    const n = normalizeString(d.name);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    names.push(n);
    if (names.length >= Math.max(1, Number(maxNames) || 12)) break;
  }
  return { count: defs.length, names, namesTruncated: defs.length > names.length };
}

function dedupeToolDefsByName(toolDefs) {
  const defs = Array.isArray(toolDefs) ? toolDefs : [];
  const out = [];
  const seen = new Set();
  for (const d of defs) {
    if (!d || typeof d !== "object") continue;
    const name = normalizeString(d.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(d);
  }
  return out;
}

module.exports = { summarizeToolDefs, dedupeToolDefsByName };

