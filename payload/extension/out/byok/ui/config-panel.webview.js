(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  const ns = window.__byokCfgPanel;
  if (!ns || typeof ns.qs !== "function" || typeof ns.renderApp !== "function") throw new Error("BYOK panel init failed (missing util/render)");

  const { qs, normalizeStr, uniq, parseModelsTextarea, parseJsonOrEmptyObject, renderApp, debugLog, withTiming, newRequestId } = ns;

  function summarizeMessageForLog(msg) {
    const t = msg && typeof msg === "object" ? normalizeStr(msg.type) : "";
    const idxRaw = msg && typeof msg === "object" && "idx" in msg ? Number(msg.idx) : NaN;
    const requestId = msg && typeof msg === "object" ? normalizeStr(msg.requestId) : "";
    const out = { type: t || "(unknown)" };
    if (Number.isFinite(idxRaw)) out.idx = idxRaw;
    if (requestId) out.requestId = requestId;
    return out;
  }

  function postToExtension(msg) {
    const summary = summarizeMessageForLog(msg);
    debugLog("postMessage", summary);
    try {
      vscode.postMessage(msg);
    } catch (err) {
      debugLog("postMessage FAIL", { ...summary, err: err instanceof Error ? err.message : String(err) });
    }
  }

  function parseByokModelId(raw) {
    const s = normalizeStr(raw);
    if (!s.startsWith("byok:")) return null;
    const rest = s.slice("byok:".length);
    const idx = rest.indexOf(":");
    if (idx <= 0) return null;
    const providerId = normalizeStr(rest.slice(0, idx));
    const modelId = normalizeStr(rest.slice(idx + 1));
    if (!providerId || !modelId) return null;
    return { providerId, modelId };
  }

  function getPersistedState() {
    try { return vscode && typeof vscode.getState === "function" ? vscode.getState() : null; } catch { return null; }
  }

  function setPersistedState(patch) {
    try {
      if (!vscode || typeof vscode.setState !== "function") return;
      const prev = getPersistedState();
      const next = { ...(prev && typeof prev === "object" ? prev : {}), ...(patch && typeof patch === "object" ? patch : {}) };
      vscode.setState(next);
    } catch { }
  }

  const persisted = getPersistedState();
  const persistedSideCollapsed = persisted && typeof persisted === "object" ? Boolean(persisted.sideCollapsed) : false;
  const persistedEndpointSearch =
    persisted && typeof persisted === "object"
      ? normalizeStr(persisted.endpointSearch) || normalizeStr(persisted.telemetrySearch) || normalizeStr(persisted.routingAddSearch)
      : "";
  const persistedProviderExpanded =
    persisted && typeof persisted === "object" && persisted.providerExpanded && typeof persisted.providerExpanded === "object" && !Array.isArray(persisted.providerExpanded)
      ? persisted.providerExpanded
      : {};

  let uiState = {
    cfg: {},
    summary: {},
    status: "Ready.",
    clearOfficialToken: false,
    officialTest: { running: false, ok: null, text: "" },
    providerExpanded: persistedProviderExpanded,
    modal: null,
    dirty: false,
    selfTest: { running: false, logs: [], report: null },
    sideCollapsed: persistedSideCollapsed,
    endpointSearch: persistedEndpointSearch
  };

  function updateDirtyBadge() {
    const el = qs("#dirtyBadge");
    if (!el) return;
    el.textContent = uiState.dirty ? "pending" : "saved";
    try {
      el.classList.toggle("status-badge--warning", uiState.dirty);
      el.classList.toggle("status-badge--success", !uiState.dirty);
    } catch { }
  }

  function updateStatusText(text) {
    const el = qs("#status");
    if (!el) return;
    el.textContent = String(text ?? "");
  }

  function markDirty(statusText) {
    if (!uiState.dirty) uiState.dirty = true;
    if (statusText) uiState.status = String(statusText);
    updateDirtyBadge();
    if (statusText) updateStatusText(statusText);
  }

  function applyEndpointFilter() {
    return withTiming(
      "applyEndpointFilter",
      () => {
        const inputEl = qs("#endpointSearch");
        const raw = inputEl ? normalizeStr(inputEl.value) : normalizeStr(uiState.endpointSearch);
        const q = raw.toLowerCase();

        const rows = Array.from(document.querySelectorAll("[data-endpoint-row]"));
        let visible = 0;
        for (const row of rows) {
          const ep = normalizeStr(row.getAttribute("data-endpoint-row"));
          const desc = normalizeStr(row.getAttribute("data-endpoint-desc"));
          const hay = `${ep} ${desc}`.toLowerCase();
          const match = !q || hay.includes(q);
          row.hidden = !match;
          if (match) visible += 1;
        }

        const groups = Array.from(document.querySelectorAll("[data-endpoint-group]"));
        for (const g of groups) {
          const items = Array.from(g.querySelectorAll("[data-endpoint-row]"));
          const totalInGroup = items.length;
          const visibleInGroup = items.reduce((n, el) => (el && !el.hidden ? n + 1 : n), 0);
          const anyVisible = visibleInGroup > 0;
          g.hidden = !anyVisible;
          if (q && anyVisible && typeof g.open === "boolean") g.open = true;

          const badge = g.querySelector ? g.querySelector("[data-endpoint-group-count-badge]") : null;
          if (badge) badge.textContent = q ? `显示 ${visibleInGroup} / ${totalInGroup}` : `${totalInGroup} total`;
        }

        const countEl = qs("#endpointFilterCount");
        if (countEl) countEl.textContent = rows.length ? `显示 ${visible} / ${rows.length}` : "";
      },
      { thresholdMs: 16 }
    );
  }

  function setEndpointSearch(next) {
    uiState.endpointSearch = normalizeStr(next);
    setPersistedState({ endpointSearch: uiState.endpointSearch });
    applyEndpointFilter();
  }

  function render() {
    return withTiming(
      "render",
      () => {
        const app = qs("#app");
        const prevMain = app?.querySelector ? app.querySelector(".main") : null;
        const prevSide = app?.querySelector ? app.querySelector(".side") : null;
        const mainScrollTop = prevMain ? prevMain.scrollTop : 0;
        const sideScrollTop = prevSide ? prevSide.scrollTop : 0;

        if (app) app.innerHTML = renderApp(uiState);

        const nextMain = app?.querySelector ? app.querySelector(".main") : null;
        const nextSide = app?.querySelector ? app.querySelector(".side") : null;
        if (nextMain) nextMain.scrollTop = mainScrollTop;
        if (nextSide) nextSide.scrollTop = sideScrollTop;

        applyEndpointFilter();
      },
      { thresholdMs: 32 }
    );
  }

  function applyProvidersEditsFromDom(cfg) {
    const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
    const els = Array.from(document.querySelectorAll("[data-p-idx][data-p-key]"));

    for (const el of els) {
      const idx = Number(el.getAttribute("data-p-idx"));
      const key = el.getAttribute("data-p-key");
      if (!Number.isFinite(idx) || idx < 0 || idx >= providers.length) continue;
      if (key === "apiKeyInput") continue;

      const p = providers[idx] && typeof providers[idx] === "object" ? providers[idx] : (providers[idx] = {});

      if (key === "models") {
        p.models = parseModelsTextarea(el.value);
        continue;
      }
      if (key === "headers") {
        try { p.headers = parseJsonOrEmptyObject(el.value); } catch { }
        continue;
      }
      if (key === "requestDefaults") {
        try { p.requestDefaults = parseJsonOrEmptyObject(el.value); } catch { }
        continue;
      }

      if (key === "thinkingLevel") {
        const level = normalizeStr(el.value);
        const providerType = normalizeStr(p.type);
        p.requestDefaults =
          p.requestDefaults && typeof p.requestDefaults === "object" && !Array.isArray(p.requestDefaults) ? p.requestDefaults : {};
        const rd = p.requestDefaults;

        if (providerType === "openai_responses") {
          if (level === "custom") continue;
          const effort = level === "extra" ? "extra_high" : level;
          if (effort === "low" || effort === "medium" || effort === "high" || effort === "extra_high") {
            const reasoning = rd.reasoning && typeof rd.reasoning === "object" && !Array.isArray(rd.reasoning) ? rd.reasoning : {};
            reasoning.effort = effort;
            rd.reasoning = reasoning;
            try { delete rd.__byok_thinking_level; } catch { }
          } else {
            if (rd.reasoning && typeof rd.reasoning === "object" && !Array.isArray(rd.reasoning)) {
              try { delete rd.reasoning.effort; } catch { }
              if (Object.keys(rd.reasoning).length === 0) {
                try { delete rd.reasoning; } catch { }
              }
            }
            try { delete rd.__byok_thinking_level; } catch { }
          }
          p.requestDefaults = rd;
          continue;
        }

        if (providerType === "anthropic") {
          if (level === "custom") continue;
          const budgetByLevel = { low: 1024, medium: 2048, high: 4096, extra: 8192 };
          const budget = budgetByLevel[level];
          if (budget) {
            const thinking = rd.thinking && typeof rd.thinking === "object" && !Array.isArray(rd.thinking) ? rd.thinking : {};
            thinking.type = "enabled";
            thinking.budget_tokens = budget;
            rd.thinking = thinking;
          } else {
            try { delete rd.thinking; } catch { }
          }
          p.requestDefaults = rd;
          continue;
        }

        continue;
      }

      p[key] = normalizeStr(el.value);
    }

    for (const el of els) {
      const idx = Number(el.getAttribute("data-p-idx"));
      const key = el.getAttribute("data-p-key");
      if (key !== "apiKeyInput") continue;
      const v = normalizeStr(el.value);
      if (v && providers[idx]) providers[idx].apiKey = v;
    }

    for (const p of providers) {
      const models = uniq((Array.isArray(p.models) ? p.models : []).concat(normalizeStr(p.defaultModel) ? [p.defaultModel] : []));
      p.models = models;
      if (!normalizeStr(p.defaultModel)) p.defaultModel = models[0] || "";
    }

    cfg.providers = providers;
  }

  function applyRulesEditsFromDom(cfg) {
    const routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : (cfg.routing = {});
    const rules = routing.rules && typeof routing.rules === "object" ? routing.rules : (routing.rules = {});

    const els = Array.from(document.querySelectorAll("[data-rule-ep][data-rule-key]"));
    for (const el of els) {
      const ep = el.getAttribute("data-rule-ep");
      const key = el.getAttribute("data-rule-key");
      if (!ep || !key) continue;
      const r = rules[ep] && typeof rules[ep] === "object" ? rules[ep] : (rules[ep] = {});
      r[key] = normalizeStr(el.value);
    }

    routing.rules = rules;
    cfg.routing = routing;
  }

  function gatherConfigFromDom() {
    return withTiming(
      "gatherConfigFromDom",
      () => {
        const base = uiState.cfg && typeof uiState.cfg === "object" ? uiState.cfg : {};
        const cfg = JSON.parse(JSON.stringify(base));
        try { delete cfg.enabled; } catch { }
        try { delete cfg.timeouts; } catch { }

        cfg.historySummary = cfg.historySummary && typeof cfg.historySummary === "object" ? cfg.historySummary : {};
        cfg.historySummary.enabled = Boolean(qs("#historySummaryEnabled")?.checked);
        cfg.historySummary.providerId = "";
        cfg.historySummary.model = "";
        const hsByokModel = normalizeStr(qs("#historySummaryByokModel")?.value);
        const parsedHsModel = parseByokModelId(hsByokModel);
        if (parsedHsModel) {
          cfg.historySummary.providerId = parsedHsModel.providerId;
          cfg.historySummary.model = parsedHsModel.modelId;
        }

        cfg.routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {};
        try { delete cfg.routing.defaultMode; } catch { }

        cfg.official = cfg.official && typeof cfg.official === "object" ? cfg.official : {};
        cfg.official.completionUrl = normalizeStr(qs("#officialCompletionUrl")?.value);

        const officialTokenInput = normalizeStr(qs("#officialApiToken")?.value);
        if (officialTokenInput) cfg.official.apiToken = officialTokenInput;
        if (uiState.clearOfficialToken) cfg.official.apiToken = "";

        applyProvidersEditsFromDom(cfg);
        applyRulesEditsFromDom(cfg);

        cfg.routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {};
        cfg.routing.rules = cfg.routing.rules && typeof cfg.routing.rules === "object" ? cfg.routing.rules : {};
        for (const ep of Object.keys(cfg.routing.rules)) {
          const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : null;
          const mode = normalizeStr(r?.mode);
          if (!r || !mode) {
            delete cfg.routing.rules[ep];
            continue;
          }
          if (mode !== "byok") {
            r.providerId = "";
            r.model = "";
          }
        }

        cfg.telemetry = cfg.telemetry && typeof cfg.telemetry === "object" ? cfg.telemetry : {};
        cfg.telemetry.disabledEndpoints = [];

        return cfg;
      },
      { thresholdMs: 16 }
    );
  }

  function migrateLegacyTelemetryDisabledEndpointsToRules(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    const out = JSON.parse(JSON.stringify(c));
    const disabled = Array.isArray(out?.telemetry?.disabledEndpoints) ? out.telemetry.disabledEndpoints : [];
    if (disabled.length) {
      out.routing = out.routing && typeof out.routing === "object" ? out.routing : {};
      out.routing.rules = out.routing.rules && typeof out.routing.rules === "object" ? out.routing.rules : {};
      for (const epRaw of disabled) {
        const ep = normalizeStr(epRaw);
        if (!ep) continue;
        const r = out.routing.rules[ep] && typeof out.routing.rules[ep] === "object" ? out.routing.rules[ep] : (out.routing.rules[ep] = {});
        r.mode = "disabled";
        r.providerId = "";
        r.model = "";
      }
    }
    out.telemetry = out.telemetry && typeof out.telemetry === "object" ? out.telemetry : {};
    out.telemetry.disabledEndpoints = [];
    return out;
  }

  function setUiState(patch, { preserveEdits = true } = {}) {
    if (preserveEdits) {
      try {
        if (qs("#officialCompletionUrl")) uiState.cfg = gatherConfigFromDom();
      } catch { }
    }
    uiState = { ...uiState, ...(patch || {}) };
    if (patch && typeof patch === "object" && "sideCollapsed" in patch) setPersistedState({ sideCollapsed: Boolean(uiState.sideCollapsed) });
    render();
  }

  function handleMessage(msg) {
    const t = msg && typeof msg === "object" ? msg.type : "";
    if (t && t !== "selfTestLog" && t !== "status") debugLog("onMessage", summarizeMessageForLog(msg));

    if (t === "status") {
      setUiState({ status: msg.status || "" }, { preserveEdits: true });
      return;
    }

    if (t === "render") {
      setUiState(
        { cfg: migrateLegacyTelemetryDisabledEndpointsToRules(msg.config || {}), summary: msg.summary || {}, clearOfficialToken: false, modal: null, dirty: false },
        { preserveEdits: false }
      );
      return;
    }

    if (t === "providerModelsFetched") {
      const idx = Number(msg.idx);
      const models = Array.isArray(msg.models) ? msg.models : [];
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (!Number.isFinite(idx) || idx < 0 || idx >= cfg.providers.length) return setUiState({ status: "Models fetched but provider index invalid." }, { preserveEdits: true });
      cfg.providers[idx] = cfg.providers[idx] && typeof cfg.providers[idx] === "object" ? cfg.providers[idx] : {};
      cfg.providers[idx].models = uniq(models);
      const dm = normalizeStr(cfg.providers[idx].defaultModel);
      if (dm && !cfg.providers[idx].models.includes(dm)) cfg.providers[idx].models = uniq(cfg.providers[idx].models.concat([dm]));
      if (!dm) cfg.providers[idx].defaultModel = cfg.providers[idx].models[0] || "";
      return setUiState({ cfg, status: "Models fetched (pending save).", dirty: true }, { preserveEdits: false });
    }

    if (t === "providerModelsFailed") return setUiState({ status: msg.error || "Fetch models failed." }, { preserveEdits: true });

    if (t === "selfTestStarted") {
      return setUiState({ selfTest: { running: true, logs: [], report: null }, status: "Self Test started..." }, { preserveEdits: true });
    }

    if (t === "selfTestLog") {
      const line = normalizeStr(msg?.line);
      const prev = uiState.selfTest && typeof uiState.selfTest === "object" ? uiState.selfTest : { running: false, logs: [], report: null };
      const logs = Array.isArray(prev.logs) ? prev.logs.slice() : [];
      if (line) logs.push(line);
      while (logs.length > 600) logs.shift();
      return setUiState({ selfTest: { ...prev, logs } }, { preserveEdits: true });
    }

    if (t === "selfTestDone") {
      const prev = uiState.selfTest && typeof uiState.selfTest === "object" ? uiState.selfTest : { running: false, logs: [], report: null };
      return setUiState({ selfTest: { ...prev, running: false, report: msg?.report || null }, status: "Self Test finished." }, { preserveEdits: true });
    }

    if (t === "selfTestFailed") {
      const prev = uiState.selfTest && typeof uiState.selfTest === "object" ? uiState.selfTest : { running: false, logs: [], report: null };
      return setUiState(
        { selfTest: { ...prev, running: false }, status: msg?.error ? `Self Test failed: ${msg.error}` : "Self Test failed." },
        { preserveEdits: true }
      );
    }

    if (t === "selfTestCanceled") {
      const prev = uiState.selfTest && typeof uiState.selfTest === "object" ? uiState.selfTest : { running: false, logs: [], report: null };
      return setUiState({ selfTest: { ...prev, running: false }, status: "Self Test canceled." }, { preserveEdits: true });
    }

    if (t === "officialGetModelsOk") {
      const modelsCount = Number.isFinite(Number(msg?.modelsCount)) ? Number(msg.modelsCount) : 0;
      const defaultModel = normalizeStr(msg?.defaultModel);
      const featureFlagsCount = Number.isFinite(Number(msg?.featureFlagsCount)) ? Number(msg.featureFlagsCount) : 0;
      const elapsedMs = Number.isFinite(Number(msg?.elapsedMs)) ? Math.max(0, Math.floor(Number(msg.elapsedMs))) : 0;
      const parts = [`models=${modelsCount}`];
      if (defaultModel) parts.push(`default=${defaultModel}`);
      if (featureFlagsCount) parts.push(`flags=${featureFlagsCount}`);
      if (elapsedMs) parts.push(`${elapsedMs}ms`);
      const text = parts.join(" ");
      return setUiState(
        { status: "Official /get-models OK.", officialTest: { running: false, ok: true, text } },
        { preserveEdits: true }
      );
    }

    if (t === "officialGetModelsFailed") {
      let err = normalizeStr(msg?.error) || "Official /get-models failed.";
      err = err.replace(/^Official\s+\/get-models\s+failed:\s*/i, "");
      return setUiState({ status: "Official /get-models failed.", officialTest: { running: false, ok: false, text: err } }, { preserveEdits: true });
    }
  }

  window.addEventListener("message", (ev) => {
    handleMessage(ev.data);
  });

  function handleAction(action, btn) {
    const a = normalizeStr(action);
    if (!a) return;

    const idxForLog = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
    if (Number.isFinite(idxForLog)) debugLog("action", { action: a, idx: idxForLog });
    else debugLog("action", { action: a });

    if (a === "toggleProviderCard") {
      const card = btn && btn.closest ? btn.closest("[data-provider-card]") : null;
      if (!card) return;
      card.classList.toggle("is-expanded");
      const key = normalizeStr(card.getAttribute("data-provider-key"));
      if (key) {
        const next = uiState.providerExpanded && typeof uiState.providerExpanded === "object" ? { ...uiState.providerExpanded } : {};
        next[key] = card.classList.contains("is-expanded");
        uiState.providerExpanded = next;
        setPersistedState({ providerExpanded: next });
      }
      return;
    }

    if (a === "clearOfficialToken") {
      setUiState({ clearOfficialToken: true, status: "Official token cleared (pending save).", dirty: true }, { preserveEdits: true });
      return;
    }

    if (a === "fetchProviderModels") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      const p = Number.isFinite(idx) && idx >= 0 && idx < cfg.providers.length ? cfg.providers[idx] : null;
      if (!p) return setUiState({ status: "Fetch Models: provider not found." }, { preserveEdits: true });
      const requestId = newRequestId("fetchModels");
      postToExtension({ type: "fetchProviderModels", requestId, idx, provider: p });
      setUiState({ status: `Fetching models... (Provider #${idx + 1})` }, { preserveEdits: true });
      return;
    }

    if (a === "testOfficialGetModels") {
      const requestId = newRequestId("officialGetModels");
      postToExtension({ type: "testOfficialGetModels", requestId, config: gatherConfigFromDom() });
      setUiState({ status: "Testing Official /get-models...", officialTest: { running: true, ok: null, text: "" } }, { preserveEdits: true });
      return;
    }

    if (a === "runSelfTest") {
      const requestId = newRequestId("selfTest");
      postToExtension({ type: "runSelfTest", requestId, config: gatherConfigFromDom() });
      setUiState({ selfTest: { running: true, logs: [], report: null }, status: "Self Test starting..." }, { preserveEdits: true });
      return;
    }

    if (a === "cancelSelfTest") {
      postToExtension({ type: "cancelSelfTest" });
      setUiState({ status: "Canceling Self Test..." }, { preserveEdits: true });
      return;
    }

    if (a === "clearSelfTest") {
      setUiState({ selfTest: { running: false, logs: [], report: null }, status: "Self Test cleared." }, { preserveEdits: true });
      return;
    }

    if (a === "editProviderModels") return setUiState({ modal: { kind: "models", idx: Number(btn.getAttribute("data-idx")) } }, { preserveEdits: true });
    if (a === "editProviderHeaders") return setUiState({ modal: { kind: "headers", idx: Number(btn.getAttribute("data-idx")) } }, { preserveEdits: true });
    if (a === "editProviderRequestDefaults") return setUiState({ modal: { kind: "requestDefaults", idx: Number(btn.getAttribute("data-idx")) } }, { preserveEdits: true });
    if (a === "modalCancel") return setUiState({ modal: null, status: "Canceled." }, { preserveEdits: true });

    if (a === "confirmReset") {
      postToExtension({ type: "reset" });
      setUiState({ modal: null, status: "Resetting..." }, { preserveEdits: true });
      return;
    }

    if (a === "modalApply") {
      const m = uiState.modal && typeof uiState.modal === "object" ? uiState.modal : null;
      const idx = Number(m?.idx);
      const kind = normalizeStr(m?.kind);
      const text = qs("#modalText")?.value ?? "";
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (!Number.isFinite(idx) || idx < 0 || idx >= cfg.providers.length) return setUiState({ status: "Apply failed: provider index invalid." }, { preserveEdits: true });
      const p = cfg.providers[idx] && typeof cfg.providers[idx] === "object" ? cfg.providers[idx] : (cfg.providers[idx] = {});
      if (kind === "models") p.models = parseModelsTextarea(text);
      else {
        try { kind === "headers" ? (p.headers = parseJsonOrEmptyObject(text)) : (p.requestDefaults = parseJsonOrEmptyObject(text)); } catch { return setUiState({ status: "Invalid JSON (kept modal open)." }, { preserveEdits: true }); }
      }
      return setUiState({ cfg, modal: null, status: "Updated (pending save).", dirty: true }, { preserveEdits: false });
    }

    if (a === "addProvider") {
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      cfg.providers.push({ id: `provider_${cfg.providers.length + 1}`, type: "openai_compatible", baseUrl: "", apiKey: "", models: [], defaultModel: "", headers: {}, requestDefaults: {} });
      setUiState({ cfg, status: "Provider added (pending save).", dirty: true }, { preserveEdits: false });
      return;
    }

    if (a === "removeProvider") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (Number.isFinite(idx) && idx >= 0 && idx < cfg.providers.length) cfg.providers.splice(idx, 1);
      setUiState({ cfg, status: "Provider removed (pending save).", dirty: true }, { preserveEdits: false });
      return;
    }

    if (a === "makeProviderDefault") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (!Number.isFinite(idx) || idx <= 0 || idx >= cfg.providers.length) return setUiState({ status: "Make Default: provider index invalid." }, { preserveEdits: true });
      const [picked] = cfg.providers.splice(idx, 1);
      cfg.providers.unshift(picked);
      setUiState({ cfg, status: "Default provider updated (providers[0], pending save).", dirty: true }, { preserveEdits: false });
      return;
    }

    if (a === "clearProviderKey") {
      const idx = btn && typeof btn.getAttribute === "function" ? Number(btn.getAttribute("data-idx")) : NaN;
      const cfg = gatherConfigFromDom();
      cfg.providers = Array.isArray(cfg.providers) ? cfg.providers : [];
      if (cfg.providers[idx]) cfg.providers[idx].apiKey = "";
      setUiState({ cfg, status: "Provider apiKey cleared (pending save).", dirty: true }, { preserveEdits: false });
      return;
    }

    if (a === "save") {
      postToExtension({ type: "save", config: gatherConfigFromDom() });
      setUiState({ status: "Saving..." }, { preserveEdits: true });
      return;
    }

    if (a === "clearHistorySummaryCache") {
      postToExtension({ type: "clearHistorySummaryCache" });
      setUiState({ status: "Clearing history summary cache..." }, { preserveEdits: true });
      return;
    }

    if (a === "reset") return setUiState({ modal: { kind: "confirmReset" } }, { preserveEdits: true });

    if (a === "reload") {
      postToExtension({ type: "reload" });
      setUiState({ status: "Reloading..." }, { preserveEdits: true });
      return;
    }

    if (a === "reloadWindow") {
      postToExtension({ type: "reloadWindow" });
      setUiState({ status: "Reload Window requested..." }, { preserveEdits: true });
      return;
    }

    if (a === "toggleRuntime") {
      const enabled = Boolean(uiState?.summary?.runtimeEnabled);
      postToExtension({ type: enabled ? "disableRuntime" : "enableRuntime" });
      setUiState({ status: enabled ? "Disabling runtime..." : "Enabling runtime..." }, { preserveEdits: true });
      return;
    }

    if (a === "toggleSide") return setUiState({ sideCollapsed: !uiState.sideCollapsed }, { preserveEdits: true });
    if (a === "disableRuntime") return postToExtension({ type: "disableRuntime" });
    if (a === "enableRuntime") return postToExtension({ type: "enableRuntime" });

    debugLog("action.unknown", { action: a });
  }

  document.addEventListener("click", (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest("[data-action]") : null;
    if (!btn) return;
    handleAction(btn.getAttribute("data-action"), btn);
  });

  function handleRuleChange(el) {
    const ep = normalizeStr(el.getAttribute("data-rule-ep"));
    const key = normalizeStr(el.getAttribute("data-rule-key"));
    const cfg = gatherConfigFromDom();
    cfg.routing = cfg.routing && typeof cfg.routing === "object" ? cfg.routing : {};
    cfg.routing.rules = cfg.routing.rules && typeof cfg.routing.rules === "object" ? cfg.routing.rules : {};

    if (key === "mode") {
      const nextMode = normalizeStr(el.value);
      if (!nextMode) {
        if (cfg.routing.rules[ep]) delete cfg.routing.rules[ep];
        return setUiState({ cfg, status: `Rule cleared: ${ep} (use default, pending save).`, dirty: true }, { preserveEdits: false });
      }
      const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : (cfg.routing.rules[ep] = {});
      r.mode = nextMode;
      if (nextMode !== "byok") {
        r.providerId = "";
        r.model = "";
      }
      return setUiState({ cfg, status: `Rule mode changed: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
    }

    if (key === "providerId") {
      const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : (cfg.routing.rules[ep] = {});
      r.mode = "byok";
      const pid = normalizeStr(r.providerId);
      if (!pid) {
        r.model = "";
      } else {
        const ps = Array.isArray(cfg.providers) ? cfg.providers : [];
        const p = ps.find((x) => normalizeStr(x?.id) === pid);
        const models = Array.isArray(p?.models) ? p.models.map((m) => normalizeStr(m)).filter(Boolean) : [];
        const m = normalizeStr(r.model);
        if (m && models.length && !models.includes(m)) r.model = "";
      }
      return setUiState({ cfg, status: `Rule provider changed: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
    }

    if (key === "model") {
      const r = cfg.routing.rules[ep] && typeof cfg.routing.rules[ep] === "object" ? cfg.routing.rules[ep] : (cfg.routing.rules[ep] = {});
      r.mode = "byok";
      return setUiState({ cfg, status: `Rule model changed: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
    }

    return setUiState({ cfg, status: `Rule updated: ${ep} (pending save).`, dirty: true }, { preserveEdits: false });
  }

  function handleChange(el) {
    if (!el || typeof el.matches !== "function") return;

    if (el.matches("#runtimeEnabledToggle")) {
      const enable = Boolean(el.checked);
      postToExtension({ type: enable ? "enableRuntime" : "disableRuntime" });
      setUiState({ status: enable ? "Enabling runtime..." : "Disabling runtime..." }, { preserveEdits: true });
      return;
    }

    if (el.matches("[data-rule-ep][data-rule-key]")) return handleRuleChange(el);

    if (el.matches("[data-p-key=\"type\"],[data-p-key=\"defaultModel\"],[data-p-key=\"thinkingLevel\"]"))
      return setUiState({ status: "Provider updated (pending save).", dirty: true }, { preserveEdits: true });
    if (el.matches("#historySummaryEnabled,#historySummaryByokModel")) return markDirty("History summary updated (pending save).");
  }

  function handleInput(el) {
    if (!el || typeof el.matches !== "function") return;
    if (el.matches("#endpointSearch")) return setEndpointSearch(el.value);
    if (el.matches("#modalText")) return;
    if (el.matches("input[type=\"text\"],input[type=\"number\"],input[type=\"password\"],input[type=\"url\"],textarea")) return markDirty("Edited (pending save).");
  }

  document.addEventListener("change", (ev) => {
    handleChange(ev.target);
  });

  document.addEventListener("input", (ev) => {
    handleInput(ev.target);
  });

  function init() {
    try {
      const initEl = qs("#byokInit");
      const init = initEl ? JSON.parse(initEl.textContent || "{}") : {};
      setUiState({ cfg: migrateLegacyTelemetryDisabledEndpointsToRules(init.config || {}), summary: init.summary || {}, status: "Ready.", clearOfficialToken: false, dirty: false }, { preserveEdits: false });
    } catch {
      setUiState({ cfg: {}, summary: {}, status: "Init failed.", clearOfficialToken: false, dirty: false }, { preserveEdits: false });
    }
    postToExtension({ type: "init" });
  }

  init();
})();
