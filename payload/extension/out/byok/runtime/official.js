"use strict";

const { debug, warn } = require("../infra/log");
const { normalizeString, normalizeRawToken } = require("../infra/util");
const { truncateTextForPrompt: truncateText } = require("../infra/text");
const augmentChatShared = require("../core/augment-chat.shared");
const { REQUEST_NODE_TEXT, REQUEST_NODE_TOOL_RESULT } = require("../core/augment-protocol");
const { ensureModelRegistryFeatureFlags } = require("../core/model-registry");
const { makeModelInfo } = require("../core/protocol");
const { getOfficialConnection } = require("../config/official");
const { joinBaseUrl, safeFetch } = require("../providers/http");
const { readHttpErrorDetail } = require("../providers/request-util");

const OFFICIAL_CODEBASE_RETRIEVAL_MAX_OUTPUT_LENGTH = 20000;
const OFFICIAL_CODEBASE_RETRIEVAL_TIMEOUT_MS = 12000;
const OFFICIAL_CONTEXT_CANVAS_TIMEOUT_MS = 4000;
const CONTEXT_CANVAS_CACHE_TTL_MS = 5 * 60 * 1000;
const CONTEXT_CANVAS_CACHE = new Map();

async function fetchOfficialGetModels({ completionURL, apiToken, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "get-models");
  if (!url) throw new Error("completionURL 无效（无法请求官方 get-models）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const resp = await safeFetch(url, { method: "POST", headers, body: "{}" }, { timeoutMs, abortSignal, label: "augment/get-models" });
  if (!resp.ok) throw new Error(`get-models ${resp.status}: ${await readHttpErrorDetail(resp, { maxChars: 300 })}`.trim());
  const json = await resp.json().catch(() => null);
  if (!json || typeof json !== "object") throw new Error("get-models 响应不是 JSON 对象");
  return json;
}

function normalizeExternalSourceIdsFromImplicitResult(raw) {
  const out = [];
  if (Array.isArray(raw)) out.push(...raw);
  else if (raw && typeof raw === "object") {
    const r = raw;
    const candidates =
      (Array.isArray(r.external_source_ids) && r.external_source_ids) ||
      (Array.isArray(r.externalSourceIds) && r.externalSourceIds) ||
      (Array.isArray(r.source_ids) && r.source_ids) ||
      (Array.isArray(r.sourceIds) && r.sourceIds) ||
      (Array.isArray(r.implicit_external_source_ids) && r.implicit_external_source_ids) ||
      (Array.isArray(r.implicitExternalSourceIds) && r.implicitExternalSourceIds) ||
      (Array.isArray(r.external_sources) && r.external_sources) ||
      (Array.isArray(r.externalSources) && r.externalSources) ||
      (Array.isArray(r.sources) && r.sources) ||
      (Array.isArray(r.implicit_external_sources) && r.implicit_external_sources) ||
      (Array.isArray(r.implicitExternalSources) && r.implicitExternalSources) ||
      [];
    out.push(...candidates);
  }
  const ids = [];
  for (const it of out) {
    if (typeof it === "string") ids.push(it);
    else if (it && typeof it === "object") {
      const obj = it;
      const cand = obj.id ?? obj.source_id ?? obj.sourceId ?? obj.external_source_id ?? obj.externalSourceId ?? obj.externalSourceID ?? "";
      if (typeof cand === "string") ids.push(cand);
    }
  }
  return normalizeStringList(ids, { maxItems: 200 });
}

async function fetchOfficialImplicitExternalSources({ completionURL, apiToken, message, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "get-implicit-external-sources");
  if (!url) throw new Error("completionURL 无效（无法请求官方 get-implicit-external-sources）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const payload = { message: String(message || "") };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/get-implicit-external-sources" }
  );
  if (!resp.ok) throw new Error(`get-implicit-external-sources ${resp.status}: ${await readHttpErrorDetail(resp, { maxChars: 300 })}`.trim());
  return await resp.json().catch(() => null);
}

async function fetchOfficialSearchExternalSources({ completionURL, apiToken, query, sourceTypes, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "search-external-sources");
  if (!url) throw new Error("completionURL 无效（无法请求官方 search-external-sources）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const payload = { query: String(query || ""), source_types: Array.isArray(sourceTypes) ? sourceTypes : [] };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/search-external-sources" }
  );
  if (!resp.ok) throw new Error(`search-external-sources ${resp.status}: ${await readHttpErrorDetail(resp, { maxChars: 300 })}`.trim());
  return await resp.json().catch(() => null);
}

async function fetchOfficialContextCanvasList({ completionURL, apiToken, pageSize, pageToken, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "context-canvas/list");
  if (!url) throw new Error("completionURL 无效（无法请求官方 context-canvas/list）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const page_size = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0 ? Math.floor(Number(pageSize)) : 100;
  const payload = { page_size, page_token: String(pageToken || "") };
  const resp = await safeFetch(
    url,
    { method: "POST", headers, body: JSON.stringify(payload) },
    { timeoutMs, abortSignal, label: "augment/context-canvas/list" }
  );
  if (!resp.ok) throw new Error(`context-canvas/list ${resp.status}: ${await readHttpErrorDetail(resp, { maxChars: 300 })}`.trim());
  return await resp.json().catch(() => null);
}

function normalizeOfficialContextCanvasListResponse(raw) {
  const r = raw && typeof raw === "object" ? raw : null;
  const list = [];
  if (Array.isArray(raw)) list.push(...raw);
  else if (r) {
    const canvases = Array.isArray(r.canvases) ? r.canvases : [];
    list.push(...canvases);
  }

  const out = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const c = it;
    const id = normalizeString(c.canvas_id ?? c.canvasId ?? c.canvasID ?? c.id ?? "");
    const name = normalizeString(c.name ?? c.title ?? "");
    const description = normalizeString(c.description ?? c.summary ?? "");
    if (!id && !name && !description) continue;
    out.push({ id, name, description });
  }

  const nextPageToken =
    r && typeof r === "object"
      ? normalizeString(r.next_page_token ?? r.nextPageToken ?? r.next_pageToken ?? r.page_token ?? r.pageToken ?? "")
      : "";
  return { canvases: out, nextPageToken };
}

function formatContextCanvasForPrompt(canvas, { canvasId } = {}) {
  const c = canvas && typeof canvas === "object" ? canvas : null;
  if (!c) return "";
  const id = normalizeString(canvasId ?? c.id);
  const name = truncateText(normalizeString(c.name), 200);
  const description = truncateText(normalizeString(c.description), 4000);
  const lines = ["[CONTEXT_CANVAS]"];
  if (id) lines.push(`canvas_id=${id}`);
  if (name) lines.push(`name=${name}`);
  if (description) lines.push(`description=${description}`);
  if (lines.length === 1) return "";
  lines.push("[/CONTEXT_CANVAS]");
  return lines.join("\n").trim();
}

function normalizeOfficialExternalSourcesSearchResults(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  const list = [];
  if (Array.isArray(raw)) list.push(...raw);
  else if (src) {
    const candidates =
      (Array.isArray(src.sources) && src.sources) ||
      (Array.isArray(src.external_sources) && src.external_sources) ||
      (Array.isArray(src.externalSources) && src.externalSources) ||
      (Array.isArray(src.items) && src.items) ||
      (Array.isArray(src.results) && src.results) ||
      [];
    list.push(...candidates);
  }

  const out = [];
  for (const it of list) {
    if (typeof it === "string") {
      const snippet = truncateText(it, 2000);
      if (snippet) out.push({ id: "", title: "", url: "", sourceType: "", snippet });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const r = it;
    const id = normalizeString(r.id ?? r.source_id ?? r.sourceId ?? r.external_source_id ?? r.externalSourceId ?? r.externalSourceID ?? "");
    const title = normalizeString(r.title ?? r.name ?? r.display_name ?? r.displayName ?? r.source_title ?? r.sourceTitle ?? "");
    const url = normalizeString(r.url ?? r.href ?? r.link ?? r.source_url ?? r.sourceUrl ?? "");
    const sourceType = normalizeString(r.source_type ?? r.sourceType ?? r.type ?? r.kind ?? "");
    const snippet = truncateText(r.snippet ?? r.summary ?? r.excerpt ?? r.text ?? r.content ?? r.body ?? "", 4000);
    if (!id && !title && !url && !snippet) continue;
    out.push({ id, title, url, sourceType, snippet });
  }
  return out;
}

function formatExternalSourcesForPrompt(results, { selectedExternalSourceIds } = {}) {
  const items = Array.isArray(results) ? results : [];
  const selected = Array.isArray(selectedExternalSourceIds) ? selectedExternalSourceIds : [];
  const lines = ["[EXTERNAL_SOURCES]"];
  if (selected.length) lines.push(`selected_external_source_ids=${selected.join(",")}`);
  for (const r of items) {
    if (!r || typeof r !== "object") continue;
    const title = normalizeString(r.title);
    const url = normalizeString(r.url);
    const id = normalizeString(r.id);
    const sourceType = normalizeString(r.sourceType);
    const snippet = truncateText(r.snippet, 4000);
    const headerParts = [];
    if (title) headerParts.push(title);
    if (sourceType) headerParts.push(`type=${sourceType}`);
    if (url) headerParts.push(url);
    else if (id) headerParts.push(`id=${id}`);
    if (!headerParts.length && !snippet) continue;
    lines.push(`- ${headerParts.join(" | ") || "(source)"}`);
    if (snippet) lines.push(snippet);
  }
  if (lines.length === 1) return "";
  lines.push("[/EXTERNAL_SOURCES]");
  return lines.join("\n").trim();
}

function normalizeOfficialBlobs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const b = raw;
  const checkpointIdRaw = Object.prototype.hasOwnProperty.call(b, "checkpoint_id") ? b.checkpoint_id : b.checkpointId ?? b.checkpointID ?? null;
  const addedBlobsRaw = Object.prototype.hasOwnProperty.call(b, "added_blobs") ? b.added_blobs : b.addedBlobs;
  const deletedBlobsRaw = Object.prototype.hasOwnProperty.call(b, "deleted_blobs") ? b.deleted_blobs : b.deletedBlobs;
  const checkpoint_id = normalizeString(checkpointIdRaw) || null;
  const added_blobs = Array.isArray(addedBlobsRaw) ? addedBlobsRaw : [];
  const deleted_blobs = Array.isArray(deletedBlobsRaw) ? deletedBlobsRaw : [];
  return { checkpoint_id, added_blobs, deleted_blobs };
}

function normalizeStringList(raw, { maxItems } = {}) {
  const lim = Number.isFinite(Number(maxItems)) && Number(maxItems) > 0 ? Math.floor(Number(maxItems)) : 100;
  const out = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : [];
  for (const v of list) {
    const s = normalizeString(String(v ?? ""));
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= lim) break;
  }
  return out;
}

async function fetchOfficialCodebaseRetrieval({ completionURL, apiToken, informationRequest, blobs, maxOutputLength, timeoutMs, abortSignal }) {
  const url = joinBaseUrl(normalizeString(completionURL), "agents/codebase-retrieval");
  if (!url) throw new Error("completionURL 无效（无法请求官方 agents/codebase-retrieval）");
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const max_output_length = Number.isFinite(Number(maxOutputLength)) && Number(maxOutputLength) > 0 ? Math.floor(Number(maxOutputLength)) : 20000;
  const basePayload = {
    information_request: String(informationRequest || ""),
    blobs: normalizeOfficialBlobs(blobs) || { checkpoint_id: null, added_blobs: [], deleted_blobs: [] },
    dialog: [],
    max_output_length
  };
  const payload = { ...basePayload, disable_codebase_retrieval: false, enable_commit_retrieval: false };

  const postOnce = async (p) => {
    const resp = await safeFetch(
      url,
      { method: "POST", headers, body: JSON.stringify(p) },
      { timeoutMs, abortSignal, label: "augment/agents/codebase-retrieval" }
    );
    if (resp.ok) {
      const json = await resp.json().catch(() => null);
      return { ok: true, json };
    }
    const text = String(await readHttpErrorDetail(resp, { maxChars: 300 }) || "").trim();
    return { ok: false, status: resp.status, text };
  };

  let result = await postOnce(payload);
  if (!result.ok && (result.status === 400 || result.status === 422)) {
    const retry = await postOnce(basePayload);
    if (retry.ok) result = retry;
  }
  if (!result.ok) throw new Error(`agents/codebase-retrieval ${result.status}: ${result.text}`.trim());

  const json = result.json;
  if (!json || typeof json !== "object") throw new Error("agents/codebase-retrieval 响应不是 JSON 对象");
  const formatted = normalizeString(json.formatted_retrieval ?? json.formattedRetrieval);
  return formatted;
}

function buildCodebaseRetrievalInformationRequest(req) {
  const parts = [];
  const main = normalizeString(req?.message);
  if (main) parts.push(main.trim());
  for (const p of augmentChatShared.buildUserExtraTextParts(req, { hasNodes: false })) {
    const s = normalizeString(p);
    if (s) parts.push(s.trim());
  }
  if (normalizeString(req?.path)) parts.push(`path: ${String(req.path).trim()}`);
  if (normalizeString(req?.lang)) parts.push(`lang: ${String(req.lang).trim()}`);
  return parts.join("\n\n").trim();
}

function makeTextRequestNode({ id, text }) {
  return { id: Number(id) || 0, type: REQUEST_NODE_TEXT, content: "", text_node: { content: String(text || "") } };
}

function countNonToolRequestNodes(req) {
  const nodes = [...(Array.isArray(req?.nodes) ? req.nodes : []), ...(Array.isArray(req?.structured_request_nodes) ? req.structured_request_nodes : []), ...(Array.isArray(req?.request_nodes) ? req.request_nodes : [])];
  let n = 0;
  for (const node of nodes) if (augmentChatShared.normalizeNodeType(node) !== REQUEST_NODE_TOOL_RESULT) n += 1;
  return n;
}

function maybeInjectUserExtraTextParts({ req, target, startId }) {
  if (!req || typeof req !== "object") return false;
  if (!Array.isArray(target)) return false;
  if (countNonToolRequestNodes(req) > 0) return false;
  let id = Number.isFinite(Number(startId)) ? Number(startId) : -30;
  for (const p of augmentChatShared.buildUserExtraTextParts(req, { hasNodes: false })) {
    const s = normalizeString(p);
    if (!s) continue;
    target.push(makeTextRequestNode({ id, text: s.trim() }));
    id -= 1;
  }
  return true;
}

function pickInjectionTargetArray(req) {
  if (Array.isArray(req?.request_nodes) && req.request_nodes.length) return req.request_nodes;
  if (Array.isArray(req?.structured_request_nodes) && req.structured_request_nodes.length) return req.structured_request_nodes;
  if (Array.isArray(req?.nodes) && req.nodes.length) return req.nodes;
  if (Array.isArray(req?.nodes)) return req.nodes;
  return null;
}

function cacheKeyForCanvas(completionURL) {
  const key = normalizeString(completionURL);
  return key ? key : "";
}

function getCanvasCacheEntry(completionURL) {
  const key = cacheKeyForCanvas(completionURL);
  if (!key) return null;
  const e = CONTEXT_CANVAS_CACHE.get(key);
  if (!e) return null;
  if (Number(e.expiresAtMs || 0) <= Date.now()) {
    CONTEXT_CANVAS_CACHE.delete(key);
    return null;
  }
  return e;
}

function ensureCanvasCacheEntry(completionURL) {
  const key = cacheKeyForCanvas(completionURL);
  if (!key) return null;
  const existing = getCanvasCacheEntry(key);
  if (existing) return existing;
  const created = { expiresAtMs: Date.now() + CONTEXT_CANVAS_CACHE_TTL_MS, byId: new Map() };
  CONTEXT_CANVAS_CACHE.set(key, created);
  return created;
}

function upsertCanvasCache(completionURL, canvases) {
  const entry = ensureCanvasCacheEntry(completionURL);
  if (!entry) return;
  for (const c of Array.isArray(canvases) ? canvases : []) {
    if (!c || typeof c !== "object") continue;
    const id = normalizeString(c.id);
    if (!id) continue;
    entry.byId.set(id, c);
  }
  entry.expiresAtMs = Date.now() + CONTEXT_CANVAS_CACHE_TTL_MS;
}

function getCanvasFromCache(completionURL, canvasId) {
  const entry = getCanvasCacheEntry(completionURL);
  if (!entry || !entry.byId) return null;
  const id = normalizeString(canvasId);
  if (!id) return null;
  return entry.byId.get(id) || null;
}

async function maybeInjectOfficialCodebaseRetrieval({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }) {
  if (!req || typeof req !== "object") return false;
  if (req.disable_retrieval === true) return false;

  const info = buildCodebaseRetrievalInformationRequest(req);
  if (!normalizeString(info)) return false;

  const off = getOfficialConnection();
  const completionURL = normalizeString(upstreamCompletionURL) || off.completionURL;
  const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
  if (!completionURL || !apiToken) {
    debug("officialRetrieval skipped: missing completionURL/apiToken");
    return false;
  }

  const hardTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
  const t = Math.max(2000, Math.min(OFFICIAL_CODEBASE_RETRIEVAL_TIMEOUT_MS, Math.floor(hardTimeout * 0.5)));

  const baseBlobs = normalizeOfficialBlobs(req.blobs) || { checkpoint_id: null, added_blobs: [], deleted_blobs: [] };
  const userGuidedBlobs = Array.isArray(req.user_guided_blobs) ? req.user_guided_blobs : [];
  const userGuidedBlobNames = userGuidedBlobs.map((b) => normalizeString(String(b ?? ""))).filter(Boolean);

  const hasCheckpoint = Boolean(normalizeString(baseBlobs.checkpoint_id));
  const hasAdded = Array.isArray(baseBlobs.added_blobs) && baseBlobs.added_blobs.length > 0;
  const hasDeleted = Array.isArray(baseBlobs.deleted_blobs) && baseBlobs.deleted_blobs.length > 0;
  const hasUserGuided = userGuidedBlobNames.length > 0;
  if (!hasCheckpoint && !hasAdded && !hasDeleted && !hasUserGuided) return false;

  try {
    const added_blobs = [...new Set([...(Array.isArray(baseBlobs.added_blobs) ? baseBlobs.added_blobs : []), ...userGuidedBlobNames])].slice(0, 500);
    const formatted = await fetchOfficialCodebaseRetrieval({
      completionURL,
      apiToken,
      informationRequest: info,
      blobs: { ...baseBlobs, added_blobs },
      maxOutputLength: OFFICIAL_CODEBASE_RETRIEVAL_MAX_OUTPUT_LENGTH,
      timeoutMs: t,
      abortSignal
    });
    if (!normalizeString(formatted)) return false;

    const retrievalNode = makeTextRequestNode({ id: -20, text: formatted.trim() });
    const target = pickInjectionTargetArray(req);
    if (!target) return false;
    maybeInjectUserExtraTextParts({ req, target, startId: -30 });
    target.push(retrievalNode);
    debug(`officialRetrieval injected: chars=${formatted.length} target_len=${target.length}`);
    return true;
  } catch (err) {
    warn(`officialRetrieval failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function maybeInjectOfficialContextCanvas({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }) {
  if (!req || typeof req !== "object") return false;
  if (req.disable_retrieval === true) return false;

  const canvasId = normalizeString(req.canvas_id);
  if (!canvasId) return false;

  const off = getOfficialConnection();
  const completionURL = normalizeString(upstreamCompletionURL) || off.completionURL;
  const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
  if (!completionURL || !apiToken) {
    debug("officialContextCanvas skipped: missing completionURL/apiToken");
    return false;
  }

  try {
    let canvas = getCanvasFromCache(completionURL, canvasId);
    if (!canvas) {
      const hardTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
      const t = Math.max(800, Math.min(OFFICIAL_CONTEXT_CANVAS_TIMEOUT_MS, Math.floor(hardTimeout * 0.15)));
      const deadline = Date.now() + t;
      let pageToken = "";
      let pages = 0;
      while (pages < 3 && Date.now() < deadline - 200) {
        const remaining = Math.max(300, deadline - Date.now());
        const raw = await fetchOfficialContextCanvasList({ completionURL, apiToken, pageSize: 100, pageToken, timeoutMs: remaining, abortSignal });
        const { canvases, nextPageToken } = normalizeOfficialContextCanvasListResponse(raw);
        if (canvases.length) upsertCanvasCache(completionURL, canvases);
        canvas = canvases.find((c) => c && typeof c === "object" && normalizeString(c.id) === canvasId) || getCanvasFromCache(completionURL, canvasId);
        if (canvas) break;
        const next = normalizeString(nextPageToken);
        if (!next) break;
        pageToken = next;
        pages += 1;
      }
    }
    if (!canvas) return false;

    const text = formatContextCanvasForPrompt(canvas, { canvasId });
    if (!normalizeString(text)) return false;

    const target = pickInjectionTargetArray(req);
    if (!target) return false;
    maybeInjectUserExtraTextParts({ req, target, startId: -30 });

    const node = makeTextRequestNode({ id: -22, text });
    const idx = target.findIndex((n) => Number(n?.id) === -20);
    if (idx >= 0) target.splice(idx, 0, node);
    else target.push(node);
    debug(`officialContextCanvas injected: chars=${text.length} target_len=${target.length}`);
    return true;
  } catch (err) {
    warn(`officialContextCanvas failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function maybeInjectOfficialExternalSources({ req, timeoutMs, abortSignal, upstreamCompletionURL, upstreamApiToken }) {
  if (!req || typeof req !== "object") return false;
  if (req.disable_retrieval === true) return false;

  const msg = normalizeString(req?.message);
  if (!msg) return false;

  const explicitExternalSourceIds = normalizeStringList(req.external_source_ids, { maxItems: 200 });
  const shouldAuto = req.disable_auto_external_sources !== true;
  if (!explicitExternalSourceIds.length && !shouldAuto) return false;

  const off = getOfficialConnection();
  const completionURL = normalizeString(upstreamCompletionURL) || off.completionURL;
  const apiToken = normalizeRawToken(upstreamApiToken) || off.apiToken;
  if (!completionURL || !apiToken) {
    debug("officialExternalSources skipped: missing completionURL/apiToken");
    return false;
  }

  const hardTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 120000;
  const t = Math.max(1500, Math.min(8000, Math.floor(hardTimeout * 0.25)));
  const implicitTimeout = Math.max(1000, Math.min(3500, Math.floor(t * 0.4)));

  let wantedIds = explicitExternalSourceIds;
  if (!wantedIds.length && shouldAuto) {
    try {
      const implicit = await fetchOfficialImplicitExternalSources({ completionURL, apiToken, message: msg, timeoutMs: implicitTimeout, abortSignal });
      const implicitIds = normalizeExternalSourceIdsFromImplicitResult(implicit);
      if (implicitIds.length) wantedIds = implicitIds;
    } catch (err) {
      debug(`officialExternalSources implicit failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!wantedIds.length && shouldAuto) return false;

  try {
    const searchTimeout = explicitExternalSourceIds.length ? t : Math.max(1500, t - implicitTimeout);
    const raw = await fetchOfficialSearchExternalSources({ completionURL, apiToken, query: msg, sourceTypes: [], timeoutMs: searchTimeout, abortSignal });
    const results = normalizeOfficialExternalSourcesSearchResults(raw);
    if (!results.length) return false;

    const wantedSet = wantedIds.length ? new Set(wantedIds) : null;
    const filtered = wantedSet ? results.filter((r) => r && typeof r === "object" && normalizeString(r.id) && wantedSet.has(String(r.id))) : [];
    const chosen = (filtered.length ? filtered : results).slice(0, 6);
    const text = formatExternalSourcesForPrompt(chosen, { selectedExternalSourceIds: wantedIds });
    if (!normalizeString(text)) return false;

    const target = pickInjectionTargetArray(req);
    if (!target) return false;
    maybeInjectUserExtraTextParts({ req, target, startId: -30 });

    const node = makeTextRequestNode({ id: -21, text });
    const idx = target.findIndex((n) => Number(n?.id) === -20);
    if (idx >= 0) target.splice(idx, 0, node);
    else target.push(node);
    debug(`officialExternalSources injected: chars=${text.length} target_len=${target.length}`);
    return true;
  } catch (err) {
    warn(`officialExternalSources failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function mergeModels(upstreamJson, byokModelNames, opts) {
  const base = upstreamJson && typeof upstreamJson === "object" ? upstreamJson : {};
  const models = Array.isArray(base.models) ? base.models.slice() : [];
  const existing = new Set(models.map((m) => (m && typeof m.name === "string" ? m.name : "")).filter(Boolean));
  for (const name of byokModelNames) {
    if (!name || existing.has(name)) continue;
    models.push(makeModelInfo(name));
    existing.add(name);
  }
  const baseDefaultModel = typeof base.default_model === "string" && base.default_model ? base.default_model : (models[0]?.name || "unknown");
  const baseFlags = base.feature_flags && typeof base.feature_flags === "object" && !Array.isArray(base.feature_flags) ? base.feature_flags : {};
  const preferredDefaultModel = normalizeString(opts?.defaultModel);
  const defaultModel = preferredDefaultModel || baseDefaultModel;
  const flags = ensureModelRegistryFeatureFlags(baseFlags, { byokModelIds: byokModelNames, defaultModel, agentChatModel: defaultModel });
  return { ...base, default_model: defaultModel, models, feature_flags: flags };
}

module.exports = {
  fetchOfficialGetModels,
  mergeModels,
  maybeInjectOfficialCodebaseRetrieval,
  maybeInjectOfficialContextCanvas,
  maybeInjectOfficialExternalSources
};

