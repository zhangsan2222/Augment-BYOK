"use strict";

const { normalizeString } = require("../../infra/util");

function sampleJsonFromSchema(schema, depth) {
  const d = Number.isFinite(Number(depth)) ? Number(depth) : 0;
  if (d > 8) return {};
  const s = schema && typeof schema === "object" && !Array.isArray(schema) ? schema : {};

  if (Object.prototype.hasOwnProperty.call(s, "const")) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Object.prototype.hasOwnProperty.call(s, "default")) return s.default;

  const pickFirst = (list) => (Array.isArray(list) && list.length ? list[0] : null);
  const union = pickFirst(s.oneOf) || pickFirst(s.anyOf) || pickFirst(s.allOf);
  if (union) return sampleJsonFromSchema(union, d + 1);

  const typeRaw = s.type;
  const types = Array.isArray(typeRaw) ? typeRaw.map((x) => normalizeString(x).toLowerCase()).filter(Boolean) : [normalizeString(typeRaw).toLowerCase()].filter(Boolean);
  const has = (t) => types.includes(t);

  const props = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties : null;
  if (has("object") || props) {
    const out = {};
    const required = Array.isArray(s.required) ? s.required.map((x) => normalizeString(x)).filter(Boolean) : [];
    const keys = props ? Object.keys(props) : [];
    const keysSet = keys.length ? new Set(keys) : null;
    const chosen = required.length ? required.filter((k) => (keysSet ? keysSet.has(k) : false)) : keys;
    const limit = 60;
    for (const k of chosen.slice(0, limit)) out[k] = sampleJsonFromSchema(props && props[k], d + 1);
    return out;
  }

  const items = s.items;
  if (has("array") || items) {
    const minItems = Number.isFinite(Number(s.minItems)) && Number(s.minItems) > 0 ? Math.floor(Number(s.minItems)) : 0;
    const n = Math.min(3, minItems);
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(sampleJsonFromSchema(items, d + 1));
    return arr;
  }

  if (has("integer")) {
    if (Number.isFinite(Number(s.minimum))) return Math.floor(Number(s.minimum));
    if (Number.isFinite(Number(s.exclusiveMinimum))) return Math.floor(Number(s.exclusiveMinimum)) + 1;
    return 1;
  }
  if (has("number")) {
    if (Number.isFinite(Number(s.minimum))) return Number(s.minimum);
    if (Number.isFinite(Number(s.exclusiveMinimum))) return Number(s.exclusiveMinimum) + 1;
    return 1;
  }
  if (has("boolean")) return true;
  if (has("null")) return null;
  if (has("string")) {
    const minLength = Number.isFinite(Number(s.minLength)) && Number(s.minLength) > 0 ? Math.floor(Number(s.minLength)) : 0;
    const base = "x".repeat(Math.min(16, Math.max(1, minLength)));
    return base;
  }

  // fallback：尽量返回可 JSON 化的值
  return {};
}

module.exports = { sampleJsonFromSchema };

