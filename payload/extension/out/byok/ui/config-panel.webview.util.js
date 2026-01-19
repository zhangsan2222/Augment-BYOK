(function () {
  "use strict";

  const ns = (window.__byokCfgPanel = window.__byokCfgPanel || {});

  ns.qs = function qs(sel, root) {
    return (root || document).querySelector(sel);
  };

  ns.normalizeStr = function normalizeStr(v) {
    return String(v ?? "").trim();
  };

  ns.uniq = function uniq(xs) {
    return Array.from(new Set((Array.isArray(xs) ? xs : []).map((x) => ns.normalizeStr(x)).filter(Boolean)));
  };

  ns.parseJsonOrEmptyObject = function parseJsonOrEmptyObject(s) {
    const t = ns.normalizeStr(s);
    if (!t) return {};
    return JSON.parse(t);
  };

  ns.parseModelsTextarea = function parseModelsTextarea(s) {
    const lines = String(s ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    return ns.uniq(lines);
  };

  ns.escapeHtml = function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  ns.optionHtml = function optionHtml({ value, label, selected, disabled }) {
    return `<option value="${ns.escapeHtml(value)}"${selected ? " selected" : ""}${disabled ? " disabled" : ""}>${ns.escapeHtml(label)}</option>`;
  };

  ns.computeProviderIndexById = function computeProviderIndexById(cfg) {
    const out = {};
    const list = Array.isArray(cfg?.providers) ? cfg.providers : [];
    for (const p of list) {
      const id = ns.normalizeStr(p?.id);
      if (id) out[id] = p;
    }
    return out;
  };

  ns.nowMs = function nowMs() {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now();
    } catch {}
    return Date.now();
  };

  ns.debugLog = function debugLog(message, meta) {
    try {
      const prefix = "[byok.webview]";
      if (meta && typeof meta === "object") console.log(prefix, String(message || ""), meta);
      else console.log(prefix, String(message || ""), meta ?? "");
    } catch {}
  };

  ns.withTiming = function withTiming(label, fn, opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const thresholdMs = Number.isFinite(Number(o.thresholdMs)) ? Number(o.thresholdMs) : 0;
    const startedAt = ns.nowMs();
    try {
      const out = fn();
      if (out && typeof out.then === "function") {
        return out.then(
          (res) => {
            const ms = ns.nowMs() - startedAt;
            if (ms >= thresholdMs) ns.debugLog(label, { ms: Math.round(ms) });
            return res;
          },
          (err) => {
            const ms = ns.nowMs() - startedAt;
            ns.debugLog(`${label} FAIL`, { ms: Math.round(ms), err: err instanceof Error ? err.message : String(err) });
            throw err;
          }
        );
      }
      const ms = ns.nowMs() - startedAt;
      if (ms >= thresholdMs) ns.debugLog(label, { ms: Math.round(ms) });
      return out;
    } catch (err) {
      const ms = ns.nowMs() - startedAt;
      ns.debugLog(`${label} FAIL`, { ms: Math.round(ms), err: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };

  let __reqSeq = 0;
  ns.newRequestId = function newRequestId(prefix) {
    __reqSeq += 1;
    const p = ns.normalizeStr(prefix) || "req";
    return `${p}_${Date.now().toString(36)}_${__reqSeq.toString(36)}`;
  };
})();
