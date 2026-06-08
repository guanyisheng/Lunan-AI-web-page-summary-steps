// ==UserScript==
// @name         路南网页总结AI
// @namespace    http://tampermonkey.net/
// @version      1.7.0
// @connect      tc.lunan.cloud
// @description  路南网页总结AI - 从当前浏览器页面获取内容，调用自定义 API 进行 AI 总结
// @author       you
// @match        *://*/*
// @connect      *
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @icon         https://tc.lunan.cloud/i/2026/05/31/lsz1xk.png
// ==/UserScript==

(function () {
  "use strict";

  const ROOT_ID = "tm-ai-summary-root";
  const APP_NAME = "路南网页总结AI";
  const ICON_URL = "https://tc.lunan.cloud/i/2026/05/31/lsz1xk.png";
  const STORAGE = {
    apiProfiles: "ai_summary_api_profiles",
    defaultProfileId: "ai_summary_default_profile_id",
    activeProfileId: "ai_summary_active_profile_id",
    failoverEnabled: "ai_summary_failover_enabled",
    contentMode: "ai_summary_content_mode",
    maxChars: "ai_summary_max_chars",
    panelPos: "ai_summary_panel_pos",
    fabPos: "ai_summary_fab_pos",
    iconData: "ai_summary_icon_data",
    apiUrl: "ai_summary_api_url",
    apiKey: "ai_summary_api_key",
    model: "ai_summary_model",
    modelMappings: "ai_summary_model_mappings",
  };

  const PROFILE_PRESETS = {
    openai: {
      name: "OpenAI",
      apiUrl: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4o-mini",
      apiKey: "",
    },
    deepseek: {
      name: "DeepSeek",
      apiUrl: "https://api.deepseek.com/v1/chat/completions",
      model: "deepseek-chat",
      apiKey: "",
    },
    ollama: {
      name: "Ollama",
      apiUrl: "http://localhost:11434/v1/chat/completions",
      model: "llama3",
      apiKey: "",
    },
  };

  const FAB_MARGIN = 12;
  const FAB_CLICK_THRESHOLD = 6;

  const DEFAULTS = {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    contentMode: "text",
    maxChars: 80000,
  };

  let panelVisible = false;
  let dragging = false;
  let dragOffset = { x: 0, y: 0 };
  let fabDragging = false;
  let fabDragMoved = false;
  let fabDragOffset = { x: 0, y: 0 };
  let fabDragStart = { x: 0, y: 0 };
  let persistTimer = null;
  let chatSession = null;
  let editingProfileId = null;
  let requestState = { id: 0, aborted: false, xhr: null };
  let isBusy = false;

  const FOLLOWUP_SYSTEM_PROMPT = [
    "你是网页阅读助手，用户已完成当前页面的总结，现在会基于页面内容和总结继续提问。",
    "请结合提供的页面信息与已有总结作答，不要编造页面中不存在的内容。",
    "回答请使用 Markdown 格式，可使用标题、列表、表格、加粗、代码块等，以便在对话框中正确渲染。",
  ].join("\n");

  function log(msg) {
    console.log("[" + APP_NAME + "]", msg);
  }

  function createProfileId() {
    return "profile_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function normalizeProfile(raw, fallbackName) {
    const mappings = Array.isArray(raw?.modelMappings) ? raw.modelMappings : [];
    const model = raw?.model || mappings[0]?.requestModel || DEFAULTS.model;
    return {
      id: raw?.id || createProfileId(),
      name: raw?.name || fallbackName || "未命名 API",
      apiUrl: raw?.apiUrl || DEFAULTS.apiUrl,
      apiKey: raw?.apiKey || "",
      model,
      modelMappings: mappings.length
        ? mappings
        : [{ displayName: model, requestModel: model, contextWindow: "" }],
      enabled: raw?.enabled !== false,
    };
  }

  function migrateLegacyProfiles() {
    const legacyUrl = GM_getValue(STORAGE.apiUrl, "");
    if (!legacyUrl) return [];
    let mappings = [];
    try {
      mappings = JSON.parse(GM_getValue(STORAGE.modelMappings, "[]"));
    } catch (_) {}
    const model = GM_getValue(STORAGE.model, DEFAULTS.model);
    return [
      normalizeProfile(
        {
          id: createProfileId(),
          name: "默认 API",
          apiUrl: legacyUrl,
          apiKey: GM_getValue(STORAGE.apiKey, ""),
          model,
          modelMappings: mappings,
          enabled: true,
        },
        "默认 API"
      ),
    ];
  }

  function getApiProfiles() {
    try {
      const raw = GM_getValue(STORAGE.apiProfiles, "[]");
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) {
        return list.map((item, index) => normalizeProfile(item, "API " + (index + 1)));
      }
    } catch (_) {}
    const migrated = migrateLegacyProfiles();
    if (migrated.length) {
      saveApiProfiles(migrated);
      if (!GM_getValue(STORAGE.defaultProfileId, "")) {
        GM_setValue(STORAGE.defaultProfileId, migrated[0].id);
      }
      if (!GM_getValue(STORAGE.activeProfileId, "")) {
        GM_setValue(STORAGE.activeProfileId, migrated[0].id);
      }
      return migrated;
    }

    const initial = [
      normalizeProfile(
        {
          id: createProfileId(),
          name: PROFILE_PRESETS.openai.name,
          apiUrl: PROFILE_PRESETS.openai.apiUrl,
          apiKey: "",
          model: PROFILE_PRESETS.openai.model,
          enabled: true,
        },
        PROFILE_PRESETS.openai.name
      ),
    ];
    saveApiProfiles(initial);
    GM_setValue(STORAGE.defaultProfileId, initial[0].id);
    GM_setValue(STORAGE.activeProfileId, initial[0].id);
    return initial;
  }

  function saveApiProfiles(list) {
    GM_setValue(STORAGE.apiProfiles, JSON.stringify(list));
  }

  function getDefaultProfileId() {
    const profiles = getApiProfiles();
    const saved = GM_getValue(STORAGE.defaultProfileId, "");
    if (saved && profiles.some((item) => item.id === saved)) return saved;
    return profiles[0]?.id || "";
  }

  function getActiveProfileId() {
    const profiles = getApiProfiles();
    const saved = GM_getValue(STORAGE.activeProfileId, "");
    if (saved && profiles.some((item) => item.id === saved)) return saved;
    return getDefaultProfileId();
  }

  function setActiveProfileId(id) {
    GM_setValue(STORAGE.activeProfileId, id);
  }

  function setDefaultProfileId(id) {
    GM_setValue(STORAGE.defaultProfileId, id);
  }

  function isFailoverEnabled() {
    return GM_getValue(STORAGE.failoverEnabled, "true") !== "false";
  }

  function getProfileById(id) {
    return getApiProfiles().find((item) => item.id === id) || null;
  }

  function getActiveProfile() {
    return getProfileById(getActiveProfileId()) || getApiProfiles()[0] || null;
  }

  function getProfilesForRequest(preferredId) {
    const profiles = getApiProfiles().filter((item) => item.enabled);
    if (!profiles.length) return [];
    const startId = preferredId || getActiveProfileId() || getDefaultProfileId();
    const ordered = [];
    const start = profiles.find((item) => item.id === startId);
    if (start) ordered.push(start);
    profiles.forEach((item) => {
      if (item.id !== startId) ordered.push(item);
    });
    return isFailoverEnabled() ? ordered : ordered.slice(0, 1);
  }

  function readCurrentProfileFromForm(root) {
    const mappings = readMappingsFromTable(root);
    const selectedModel = root.querySelector("#tm-ai-model-select")?.value.trim() || "";
    return normalizeProfile(
      {
        id: editingProfileId || createProfileId(),
        name: root.querySelector("#tm-ai-profile-name")?.value.trim() || "未命名 API",
        apiUrl: root.querySelector("#tm-ai-api-url")?.value || "",
        apiKey: root.querySelector("#tm-ai-api-key")?.value || "",
        model: selectedModel || mappings[0]?.requestModel || DEFAULTS.model,
        modelMappings: mappings,
        enabled: root.querySelector("#tm-ai-profile-enabled")?.checked !== false,
      },
      "未命名 API"
    );
  }

  function readSettingsFromForm(root) {
    const profiles = getApiProfiles();
    const current = readCurrentProfileFromForm(root);
    const index = profiles.findIndex((item) => item.id === current.id);
    if (index >= 0) profiles[index] = current;
    else profiles.push(current);
    return {
      profiles,
      defaultProfileId:
        root.querySelector("#tm-ai-default-profile")?.value || getDefaultProfileId(),
      activeProfileId:
        root.querySelector("#tm-ai-active-profile")?.value ||
        root.querySelector("#tm-ai-summary-profile")?.value ||
        getActiveProfileId(),
      failoverEnabled: root.querySelector("#tm-ai-failover-enabled")?.checked !== false,
      contentMode: root.querySelector("#tm-ai-content-mode")?.value || DEFAULTS.contentMode,
      maxChars: Number(root.querySelector("#tm-ai-max-chars")?.value) || DEFAULTS.maxChars,
    };
  }

  function saveSettingsData(data) {
    saveApiProfiles(data.profiles);
    setDefaultProfileId(data.defaultProfileId || data.profiles[0]?.id || "");
    setActiveProfileId(data.activeProfileId || data.defaultProfileId || data.profiles[0]?.id || "");
    GM_setValue(STORAGE.failoverEnabled, data.failoverEnabled ? "true" : "false");
    GM_setValue(STORAGE.contentMode, data.contentMode);
    GM_setValue(STORAGE.maxChars, String(data.maxChars));
    const active = getProfileById(getActiveProfileId());
    if (active) {
      GM_setValue(STORAGE.apiUrl, active.apiUrl);
      GM_setValue(STORAGE.apiKey, active.apiKey);
      GM_setValue(STORAGE.model, active.model);
      GM_setValue(STORAGE.modelMappings, JSON.stringify(active.modelMappings));
    }
  }

  function persistSettingsFromForm(root, immediate) {
    if (!root) return;
    const run = () => {
      const data = readSettingsFromForm(root);
      saveSettingsData(data);
      editingProfileId = getActiveProfileId();
      renderProfileControls(root);
      showSaveStatus(root);
    };
    if (immediate) {
      clearTimeout(persistTimer);
      run();
      return;
    }
    clearTimeout(persistTimer);
    persistTimer = setTimeout(run, 500);
  }

  function getConfig() {
    const profile = getActiveProfile();
    const mappings = profile?.modelMappings || [];
    const model = profile?.model || DEFAULTS.model;
    const matched = mappings.find((item) => item.requestModel === model);
    return {
      profileId: profile?.id || "",
      profileName: profile?.name || "",
      apiUrl: profile?.apiUrl || DEFAULTS.apiUrl,
      apiKey: profile?.apiKey || "",
      model,
      modelLabel: matched ? matched.displayName : model,
      modelMappings: mappings,
      profiles: getApiProfiles(),
      defaultProfileId: getDefaultProfileId(),
      activeProfileId: getActiveProfileId(),
      failoverEnabled: isFailoverEnabled(),
      contentMode: GM_getValue(STORAGE.contentMode, DEFAULTS.contentMode),
      maxChars: Number(GM_getValue(STORAGE.maxChars, DEFAULTS.maxChars)) || DEFAULTS.maxChars,
    };
  }

  function saveConfig(partial) {
    if (partial.profiles !== undefined) saveApiProfiles(partial.profiles);
    if (partial.defaultProfileId !== undefined) setDefaultProfileId(partial.defaultProfileId);
    if (partial.activeProfileId !== undefined) setActiveProfileId(partial.activeProfileId);
    if (partial.failoverEnabled !== undefined) {
      GM_setValue(STORAGE.failoverEnabled, partial.failoverEnabled ? "true" : "false");
    }
    if (partial.contentMode !== undefined) GM_setValue(STORAGE.contentMode, partial.contentMode);
    if (partial.maxChars !== undefined) GM_setValue(STORAGE.maxChars, String(partial.maxChars));
  }

  function buildExportConfig() {
    const cfg = getConfig();
    return {
      version: 2,
      app: APP_NAME,
      exportedAt: new Date().toISOString(),
      profiles: cfg.profiles,
      defaultProfileId: cfg.defaultProfileId,
      activeProfileId: cfg.activeProfileId,
      failoverEnabled: cfg.failoverEnabled,
      contentMode: cfg.contentMode,
      maxChars: cfg.maxChars,
    };
  }

  function applyImportedConfig(data) {
    if (!data || typeof data !== "object") {
      throw new Error("配置文件格式无效");
    }
    if (Array.isArray(data.profiles) && data.profiles.length) {
      saveSettingsData({
        profiles: data.profiles.map((item, index) => normalizeProfile(item, "API " + (index + 1))),
        defaultProfileId: data.defaultProfileId || data.profiles[0]?.id,
        activeProfileId: data.activeProfileId || data.defaultProfileId || data.profiles[0]?.id,
        failoverEnabled: data.failoverEnabled !== false,
        contentMode: data.contentMode ?? DEFAULTS.contentMode,
        maxChars: Number(data.maxChars) || DEFAULTS.maxChars,
      });
      return;
    }
    saveSettingsData({
      profiles: [
        normalizeProfile(
          {
            id: createProfileId(),
            name: "导入的 API",
            apiUrl: data.apiUrl ?? DEFAULTS.apiUrl,
            apiKey: data.apiKey ?? "",
            model: data.model ?? DEFAULTS.model,
            modelMappings: Array.isArray(data.modelMappings) ? data.modelMappings : [],
            enabled: true,
          },
          "导入的 API"
        ),
      ],
      defaultProfileId: "",
      activeProfileId: "",
      failoverEnabled: true,
      contentMode: data.contentMode ?? DEFAULTS.contentMode,
      maxChars: Number(data.maxChars) || DEFAULTS.maxChars,
    });
  }

  function showSaveStatus(root) {
    const el = root.querySelector("#tm-ai-save-status");
    if (!el) return;
    el.textContent = "配置已自动保存";
    el.className = "tm-save-status tm-success";
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.textContent = "修改后会自动记住配置";
      el.className = "tm-save-status";
    }, 2000);
  }

  function exportConfigFile() {
    const data = buildExportConfig();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${APP_NAME}-配置-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function importConfigFile(file) {
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error("配置文件不是有效的 JSON");
    }
    applyImportedConfig(data);
  }

  function deriveModelsUrl(chatUrl) {
    const url = chatUrl.trim().replace(/\/+$/, "");
    if (!url) return "";
    if (url.endsWith("/chat/completions")) {
      return url.replace(/\/chat\/completions$/, "/models");
    }
    if (url.endsWith("/v1")) {
      return url + "/models";
    }
    const v1Match = url.match(/^(.*\/v1)(?:\/.*)?$/);
    if (v1Match) return v1Match[1] + "/models";
    return url.replace(/\/[^/]+$/, "/models");
  }

  function parseModelsResponse(data) {
    const list = data.data || data.models || data.result || [];
    return list
      .map((item) => {
        if (typeof item === "string") {
          return { id: item, context: null };
        }
        return {
          id: item.id || item.name || item.model,
          context: item.context_window || item.max_context_length || item.context_length || null,
        };
      })
      .filter((item) => item.id);
  }

  async function fetchModelsFromApi(apiUrl, apiKey) {
    const modelsUrl = deriveModelsUrl(apiUrl);
    if (!modelsUrl) throw new Error("无法从 API 地址推导 models 接口");

    const resp = await gmRequest({
      method: "GET",
      url: modelsUrl,
      headers: {
        Authorization: "Bearer " + apiKey,
        Accept: "application/json",
      },
      timeout: 30000,
    });

    if (resp.status < 200 || resp.status >= 300) {
      let detail = resp.responseText;
      try {
        const err = JSON.parse(resp.responseText);
        detail = err.error?.message || err.message || resp.responseText;
      } catch (_) {}
      throw new Error(`获取模型列表失败 (${resp.status}): ${detail}`);
    }

    const data = JSON.parse(resp.responseText);
    const models = parseModelsResponse(data);
    if (!models.length) throw new Error("接口未返回可用模型");
    return models;
  }

  function mergeFetchedModels(existing, fetched) {
    const map = new Map();
    existing.forEach((item) => map.set(item.requestModel, { ...item }));
    fetched.forEach((item) => {
      if (!map.has(item.id)) {
        map.set(item.id, {
          displayName: item.id,
          requestModel: item.id,
          contextWindow: item.context || "",
        });
      } else if (item.context && !map.get(item.id).contextWindow) {
        const current = map.get(item.id);
        current.contextWindow = String(item.context);
        map.set(item.id, current);
      }
    });
    return Array.from(map.values());
  }

  function beginRequest() {
    requestState.id += 1;
    requestState.aborted = false;
    requestState.xhr = null;
    return requestState.id;
  }

  function abortActiveRequest() {
    requestState.aborted = true;
    if (requestState.xhr && typeof requestState.xhr.abort === "function") {
      requestState.xhr.abort();
    }
    requestState.xhr = null;
  }

  function isRequestAborted(reqId) {
    return requestState.aborted || reqId !== requestState.id;
  }

  function gmRequest(options, cancellable) {
    const reqId = cancellable ? requestState.id || beginRequest() : -1;
    return new Promise((resolve, reject) => {
      const xhr = GM_xmlhttpRequest({
        ...options,
        onload: (resp) => {
          if (cancellable && isRequestAborted(reqId)) {
            reject(new Error("已中断"));
            return;
          }
          resolve(resp);
        },
        onerror: (err) => {
          if (cancellable && isRequestAborted(reqId)) reject(new Error("已中断"));
          else reject(err);
        },
        ontimeout: () => {
          if (cancellable && isRequestAborted(reqId)) reject(new Error("已中断"));
          else reject(new Error("请求超时"));
        },
      });
      if (cancellable) requestState.xhr = xhr;
    });
  }

  function arrayBufferToDataUrl(buffer, contentType) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${contentType || "image/png"};base64,${btoa(binary)}`;
  }

  async function getIconDataUrl() {
    try {
      const cached = JSON.parse(GM_getValue(STORAGE.iconData, "null"));
      if (cached?.url === ICON_URL && cached?.dataUrl) {
        return cached.dataUrl;
      }
    } catch (_) {}

    const resp = await gmRequest({
      method: "GET",
      url: ICON_URL,
      responseType: "arraybuffer",
      timeout: 15000,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`图标加载失败 (${resp.status})`);
    }

    const contentType =
      (resp.responseHeaders || "").match(/content-type:\s*([^\r\n;]+)/i)?.[1] || "image/png";
    const dataUrl = arrayBufferToDataUrl(resp.response, contentType.trim());
    GM_setValue(STORAGE.iconData, JSON.stringify({ url: ICON_URL, dataUrl }));
    return dataUrl;
  }

  async function loadFabIcon(fab) {
    const img = fab.querySelector("#tm-ai-fab-icon");
    try {
      const dataUrl = await getIconDataUrl();
      if (img) {
        img.src = dataUrl;
      }
      fab.classList.add("tm-has-icon");
    } catch (err) {
      log(err.message || err);
    }
  }

  function stripNoiseFromHtml(html) {
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getPageContent(mode) {
    const title = document.title || "";
    const url = location.href;
    let body = "";

    if (mode === "html") {
      body = document.documentElement.outerHTML;
    } else if (mode === "html-clean") {
      body = stripNoiseFromHtml(document.documentElement.outerHTML);
    } else {
      body = document.body ? document.body.innerText : "";
    }

    return { title, url, body };
  }

  function truncateContent(text, maxChars) {
    if (text.length <= maxChars) {
      return { text, truncated: false, originalLength: text.length };
    }
    const head = Math.floor(maxChars * 0.85);
    const tail = maxChars - head - 80;
    return {
      text:
        text.slice(0, head) +
        "\n\n...[内容过长，已截断]...\n\n" +
        text.slice(-tail),
      truncated: true,
      originalLength: text.length,
    };
  }

  const SYSTEM_PROMPT = [
    "你是专业的网页阅读助手，擅长从网页内容中提取核心信息并输出清晰、易读的中文总结。",
    "",
    "【输出格式 — 必须使用 Markdown】",
    "你的回复将在工作对话框中渲染为 Markdown，请严格使用以下格式：",
    "- 用 ## 作为大标题、### 作为小标题分层组织",
    "- 开头用 > 引用块写 1-2 句核心摘要",
    "- 关键要点用 - 或 1. 列表呈现",
    "- 有对比、数据、参数、字段、步骤等多列信息时，必须用 Markdown 表格（| 列1 | 列2 | 格式）",
    "- 重要术语、数字、结论用 **加粗**",
    "- 代码、命令、路径、文件名用 `行内代码`",
    "- 较长代码片段用 ```语言 代码块 ```",
    "- 可用 --- 分隔不同章节",
    "",
    "【内容要求】",
    "- 忽略导航栏、广告、页脚、Cookie 提示等无关噪音",
    "- 保留页面中的关键事实、数据、结论与可操作步骤",
    "- 若页面信息不足，如实说明，不要编造",
    "- 只输出 Markdown 正文，不要包裹 ```markdown 代码块，不要输出 HTML",
  ].join("\n");

  function buildPrompt(page) {
    return [
      "请总结以下网页内容，并按 Markdown 格式输出，确保标题、列表、表格等能在对话框中正确显示。",
      "",
      "建议结构示例：",
      "## 页面概览",
      "> 一两句核心摘要",
      "",
      "## 关键要点",
      "- 要点一",
      "- 要点二",
      "",
      "## 重要信息（如有数据/对比/步骤，请用表格）",
      "| 项目 | 说明 |",
      "| --- | --- |",
      "| ... | ... |",
      "",
      "## 结论或建议",
      "（可选）",
      "",
      "---",
      `**标题：** ${page.title}`,
      `**URL：** ${page.url}`,
      "",
      "**页面内容：**",
      page.body,
    ].join("\n");
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderInlineMarkdown(text) {
    return text
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function isTableDivider(line) {
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    return cells.length >= 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function parseTableBlock(lines) {
    if (lines.length < 2) return null;
    const splitRow = (line) =>
      line
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());

    const header = splitRow(lines[0]);
    if (!isTableDivider(lines[1])) return null;

    const rows = lines.slice(2).map(splitRow).filter((row) => row.some(Boolean));
    const thead = `<thead><tr>${header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
    const tbody = `<tbody>${rows
      .map(
        (row) =>
          `<tr>${row
            .map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`)
            .join("")}</tr>`
      )
      .join("")}</tbody>`;
    return `<div class="tm-md-table-wrap"><table class="tm-md-table">${thead}${tbody}</table></div>`;
  }

  function renderMarkdown(raw) {
    if (!raw) return "";

    const codeBlocks = [];
    let text = String(raw).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const index = codeBlocks.length;
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      codeBlocks.push(`<pre class="tm-md-pre"><code${langClass}>${escapeHtml(code.trim())}</code></pre>`);
      return `\x00CODE${index}\x00`;
    });

    text = escapeHtml(text);
    const lines = text.split("\n");
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\x00CODE\d+\x00$/.test(line.trim())) {
        html.push(line.trim());
        i += 1;
        continue;
      }

      if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
        html.push("<hr>");
        i += 1;
        continue;
      }

      if (/^#{1,6}\s+/.test(line)) {
        const level = line.match(/^#+/)[0].length;
        const content = line.replace(/^#{1,6}\s+/, "");
        html.push(`<h${Math.min(level, 6)}>${renderInlineMarkdown(content)}</h${Math.min(level, 6)}>`);
        i += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i += 1;
        }
        html.push(`<blockquote>${renderInlineMarkdown(quoteLines.join("<br>"))}</blockquote>`);
        continue;
      }

      if (/^\|.+\|$/.test(line.trim())) {
        const tableLines = [];
        while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
          tableLines.push(lines[i].trim());
          i += 1;
        }
        const tableHtml = parseTableBlock(tableLines);
        html.push(tableHtml || `<p>${renderInlineMarkdown(tableLines.join("<br>"))}</p>`);
        continue;
      }

      if (/^[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
          items.push(`<li>${renderInlineMarkdown(lines[i].replace(/^[-*+]\s+/, ""))}</li>`);
          i += 1;
        }
        html.push(`<ul>${items.join("")}</ul>`);
        continue;
      }

      if (/^\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          items.push(`<li>${renderInlineMarkdown(lines[i].replace(/^\d+\.\s+/, ""))}</li>`);
          i += 1;
        }
        html.push(`<ol>${items.join("")}</ol>`);
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^#{1,6}\s+/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^\|.+\|$/.test(lines[i].trim()) &&
        !/^[-*+]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i]) &&
        !/^---+$/.test(lines[i].trim()) &&
        !/^\x00CODE\d+\x00$/.test(lines[i].trim())
      ) {
        paraLines.push(lines[i]);
        i += 1;
      }
      html.push(`<p>${renderInlineMarkdown(paraLines.join("<br>"))}</p>`);
    }

    return html
      .join("\n")
      .replace(/\x00CODE(\d+)\x00/g, (_, index) => codeBlocks[Number(index)] || "");
  }

  function parseApiResponse(data) {
    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    }
    if (data.output?.text) return data.output.text;
    if (typeof data.result === "string") return data.result;
    if (typeof data.response === "string") return data.response;
    throw new Error("无法解析 API 返回内容，请检查接口格式是否为 OpenAI Chat Completions 兼容");
  }

  function profileNeedsApiKey(profile) {
    return !/localhost|127\.0\.0\.1/.test(profile.apiUrl || "");
  }

  async function callChatApiSingle(profile, messages, temperature) {
    if (!profile?.apiUrl) throw new Error(`[${profile.name}] 请先配置 API 地址`);
    if (profileNeedsApiKey(profile) && !profile.apiKey) {
      throw new Error(`[${profile.name}] 请先配置 API Key`);
    }
    if (!profile.model) throw new Error(`[${profile.name}] 请先配置模型名称`);

    const resp = await gmRequest({
      method: "POST",
      url: profile.apiUrl,
      headers: {
        "Content-Type": "application/json",
        ...(profile.apiKey ? { Authorization: "Bearer " + profile.apiKey } : {}),
      },
      data: JSON.stringify({
        model: profile.model,
        messages,
        temperature: temperature ?? 0.3,
      }),
      timeout: 120000,
    }, true);

    if (resp.status < 200 || resp.status >= 300) {
      let detail = resp.responseText;
      try {
        const err = JSON.parse(resp.responseText);
        detail = err.error?.message || err.message || resp.responseText;
      } catch (_) {}
      throw new Error(`[${profile.name}] API 请求失败 (${resp.status}): ${detail}`);
    }

    return parseApiResponse(JSON.parse(resp.responseText));
  }

  async function callChatApi(messages, temperature, options) {
    const profiles = getProfilesForRequest(options?.profileId);
    if (!profiles.length) throw new Error("请先在设置中添加并启用至少一个 API");

    const errors = [];
    for (let i = 0; i < profiles.length; i += 1) {
      const profile = profiles[i];
      if (isRequestAborted(requestState.id)) throw new Error("已中断");
      try {
        if (options?.onTrying) options.onTrying(profile, i, profiles.length);
        const content = await callChatApiSingle(profile, messages, temperature);
        if (options?.onSuccess) options.onSuccess(profile);
        return { content, profile };
      } catch (err) {
        if (String(err.message || err) === "已中断") throw err;
        errors.push(err.message || String(err));
        if (!isFailoverEnabled() || i === profiles.length - 1) break;
      }
    }
    throw new Error(errors.join("\n"));
  }

  async function callSummaryApi(pageContent, options) {
    const cfg = getConfig();
    const { text, truncated, originalLength } = truncateContent(
      pageContent.body,
      cfg.maxChars
    );

    const { content, profile } = await callChatApi(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildPrompt({ ...pageContent, body: text }) },
      ],
      0.3,
      options
    );

    return {
      summary: content,
      profile,
      truncated,
      originalLength,
      pageContext: {
        title: pageContent.title,
        url: pageContent.url,
        body: text,
      },
    };
  }

  function buildFollowUpMessages(session, question) {
    const contextBlock = [
      `页面标题：${session.pageContext.title}`,
      `页面 URL：${session.pageContext.url}`,
      "",
      "页面内容（供参考）：",
      session.pageContext.body,
      "",
      "---",
      "",
      "已有总结：",
      session.summary,
    ].join("\n");

    const messages = [
      {
        role: "system",
        content: `${FOLLOWUP_SYSTEM_PROMPT}\n\n${contextBlock}`,
      },
    ];

    session.messages.forEach((item) => {
      messages.push({ role: item.role, content: item.content });
    });
    messages.push({ role: "user", content: question });
    return messages;
  }

  async function callFollowUpApi(session, question, options) {
    const { content } = await callChatApi(buildFollowUpMessages(session, question), 0.4, options);
    return content;
  }

  function injectStyles() {
    if (document.getElementById("tm-ai-summary-style")) return;

    const style = document.createElement("style");
    style.id = "tm-ai-summary-style";
    style.textContent = `
      #${ROOT_ID} {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${ROOT_ID} * {
        box-sizing: border-box;
      }
      #tm-ai-fab {
        position: fixed;
        z-index: 2147483646;
        width: 52px;
        height: 52px;
        padding: 0;
        border: none;
        border-radius: 14px;
        background: #fff;
        cursor: grab;
        touch-action: none;
        box-shadow: 0 6px 20px rgba(15, 23, 42, 0.18);
        transition: left 0.28s ease, top 0.28s ease, transform 0.15s, box-shadow 0.15s;
        user-select: none;
        overflow: hidden;
      }
      #tm-ai-fab img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        pointer-events: none;
        border-radius: 14px;
      }
      #tm-ai-fab .tm-fab-fallback {
        display: flex;
        width: 100%;
        height: 100%;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        font-weight: 700;
        color: #fff;
        pointer-events: none;
        border-radius: 14px;
        background: linear-gradient(135deg, #6366f1, #8b5cf6);
      }
      #tm-ai-fab.tm-has-icon .tm-fab-fallback {
        display: none;
      }
      #tm-ai-fab.tm-has-icon #tm-ai-fab-icon {
        display: block;
      }
      #tm-ai-fab #tm-ai-fab-icon {
        display: none;
      }
      #tm-ai-fab:hover {
        transform: scale(1.06);
        box-shadow: 0 8px 28px rgba(15, 23, 42, 0.24);
      }
      #tm-ai-fab.tm-dragging {
        cursor: grabbing;
        transition: none;
        transform: scale(1.08);
        box-shadow: 0 10px 32px rgba(15, 23, 42, 0.28);
      }
      #tm-ai-panel {
        position: fixed;
        z-index: 2147483647;
        width: min(420px, calc(100vw - 24px));
        max-height: min(760px, calc(100vh - 24px));
        background: #fff;
        border-radius: 14px;
        box-shadow: 0 20px 50px rgba(15, 23, 42, 0.22);
        display: none;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, 0.35);
      }
      #tm-ai-panel.tm-visible {
        display: flex;
      }
      #tm-ai-panel .tm-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px;
        background: linear-gradient(135deg, #6366f1, #7c3aed);
        color: #fff;
        cursor: move;
        user-select: none;
        flex-shrink: 0;
      }
      #tm-ai-panel .tm-head-title {
        font-size: 14px;
        font-weight: 700;
      }
      #tm-ai-panel .tm-head-actions {
        display: flex;
        gap: 6px;
      }
      #tm-ai-panel .tm-icon-btn {
        border: none;
        background: rgba(255,255,255,.18);
        color: #fff;
        width: 26px;
        height: 26px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
      }
      #tm-ai-panel .tm-icon-btn:hover {
        background: rgba(255,255,255,.28);
      }
      #tm-ai-panel .tm-tabs {
        display: flex;
        border-bottom: 1px solid #e2e8f0;
        flex-shrink: 0;
      }
      #tm-ai-panel .tm-tab {
        flex: 1;
        border: none;
        background: #f8fafc;
        padding: 10px;
        font-size: 13px;
        color: #64748b;
        cursor: pointer;
        font-weight: 600;
      }
      #tm-ai-panel .tm-tab.tm-active {
        background: #fff;
        color: #6366f1;
        box-shadow: inset 0 -2px 0 #6366f1;
      }
      #tm-ai-panel .tm-body {
        flex: 1;
        overflow: auto;
        padding: 14px;
        font-size: 13px;
        color: #334155;
        line-height: 1.65;
      }
      #tm-ai-panel .tm-page-info {
        padding: 10px 12px;
        background: #f1f5f9;
        border-radius: 8px;
        margin-bottom: 12px;
        font-size: 12px;
        color: #475569;
        word-break: break-all;
      }
      #tm-ai-panel .tm-page-info strong {
        color: #0f172a;
      }
      #tm-ai-panel .tm-actions-row {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }
      #tm-ai-panel .tm-btn {
        border: none;
        border-radius: 8px;
        padding: 9px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
      }
      #tm-ai-panel .tm-btn-primary {
        background: #6366f1;
        color: #fff;
        flex: 1;
      }
      #tm-ai-panel .tm-btn-primary:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #tm-ai-panel .tm-btn-secondary {
        background: #f1f5f9;
        color: #475569;
      }
      #tm-ai-panel .tm-btn-danger {
        background: #fee2e2;
        color: #b91c1c;
      }
      #tm-ai-panel .tm-btn-danger:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #tm-ai-panel .tm-profile-bar {
        margin-bottom: 12px;
      }
      #tm-ai-panel .tm-profile-bar label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        color: #475569;
        margin-bottom: 5px;
      }
      #tm-ai-panel .tm-profile-bar select {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 13px;
        background: #fff;
        color: #0f172a;
      }
      #tm-ai-panel .tm-profile-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 8px 0 12px;
      }
      #tm-ai-panel .tm-profile-chip {
        border: 1px solid #cbd5e1;
        background: #fff;
        color: #475569;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        cursor: pointer;
      }
      #tm-ai-panel .tm-profile-chip.tm-active {
        border-color: #6366f1;
        background: #eef2ff;
        color: #4338ca;
        font-weight: 700;
      }
      #tm-ai-panel .tm-profile-chip.tm-default::after {
        content: " · 默认";
        color: #16a34a;
        font-weight: 700;
      }
      #tm-ai-panel .tm-profile-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 8px 0 12px;
      }
      #tm-ai-panel .tm-profile-actions .tm-btn {
        flex: 1;
        min-width: 88px;
        padding: 8px 10px;
        font-size: 12px;
      }
      #tm-ai-panel .tm-inline-check {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 10px 0;
        font-size: 13px;
        color: #334155;
      }
      #tm-ai-panel .tm-inline-check input {
        width: auto;
      }
      #tm-ai-panel .tm-result {
        word-break: break-word;
        padding: 12px;
        background: #fafafa;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        min-height: 120px;
        font-size: 13px;
        color: #1e293b;
        line-height: 1.65;
      }
      #tm-ai-panel .tm-result.tm-loading,
      #tm-ai-panel .tm-result.tm-error {
        white-space: pre-wrap;
      }
      #tm-ai-panel .tm-result.tm-markdown {
        white-space: normal;
      }
      #tm-ai-panel .tm-result.tm-markdown h2,
      #tm-ai-panel .tm-result.tm-markdown h3,
      #tm-ai-panel .tm-result.tm-markdown h4 {
        margin: 14px 0 8px;
        color: #0f172a;
        line-height: 1.35;
      }
      #tm-ai-panel .tm-result.tm-markdown h2 {
        font-size: 16px;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 6px;
      }
      #tm-ai-panel .tm-result.tm-markdown h3 {
        font-size: 14px;
      }
      #tm-ai-panel .tm-result.tm-markdown p {
        margin: 8px 0;
      }
      #tm-ai-panel .tm-result.tm-markdown ul,
      #tm-ai-panel .tm-result.tm-markdown ol {
        margin: 8px 0 8px 18px;
        padding: 0;
      }
      #tm-ai-panel .tm-result.tm-markdown li {
        margin: 4px 0;
      }
      #tm-ai-panel .tm-result.tm-markdown blockquote {
        margin: 10px 0;
        padding: 8px 12px;
        border-left: 3px solid #6366f1;
        background: #eef2ff;
        color: #3730a3;
        border-radius: 0 8px 8px 0;
      }
      #tm-ai-panel .tm-result.tm-markdown hr {
        border: none;
        border-top: 1px solid #e2e8f0;
        margin: 14px 0;
      }
      #tm-ai-panel .tm-result.tm-markdown code {
        padding: 1px 5px;
        border-radius: 4px;
        background: #f1f5f9;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        color: #be123c;
      }
      #tm-ai-panel .tm-result.tm-markdown pre.tm-md-pre {
        margin: 10px 0;
        padding: 10px 12px;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 8px;
        overflow: auto;
        font-size: 12px;
        line-height: 1.5;
      }
      #tm-ai-panel .tm-result.tm-markdown pre.tm-md-pre code {
        padding: 0;
        background: transparent;
        color: inherit;
        font-size: inherit;
      }
      #tm-ai-panel .tm-result.tm-markdown a {
        color: #2563eb;
        text-decoration: none;
      }
      #tm-ai-panel .tm-result.tm-markdown a:hover {
        text-decoration: underline;
      }
      #tm-ai-panel .tm-md-table-wrap {
        overflow: auto;
        margin: 10px 0;
      }
      #tm-ai-panel .tm-md-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      #tm-ai-panel .tm-md-table th,
      #tm-ai-panel .tm-md-table td {
        border: 1px solid #cbd5e1;
        padding: 7px 10px;
        text-align: left;
        vertical-align: top;
      }
      #tm-ai-panel .tm-md-table th {
        background: #f8fafc;
        font-weight: 700;
        color: #0f172a;
      }
      #tm-ai-panel .tm-md-table tr:nth-child(even) td {
        background: #fcfcfd;
      }
      #tm-ai-panel .tm-result.tm-loading {
        color: #64748b;
        font-style: italic;
      }
      #tm-ai-panel .tm-result.tm-error {
        background: #fef2f2;
        border-color: #fecaca;
        color: #b91c1c;
      }
      #tm-ai-panel .tm-meta {
        margin-top: 8px;
        font-size: 11px;
        color: #94a3b8;
      }
      #tm-ai-panel .tm-chat-section {
        display: none;
        margin-top: 14px;
        padding-top: 14px;
        border-top: 1px solid #e2e8f0;
      }
      #tm-ai-panel .tm-chat-section.tm-visible {
        display: block;
      }
      #tm-ai-panel .tm-chat-head {
        font-size: 13px;
        font-weight: 700;
        color: #0f172a;
        margin-bottom: 10px;
      }
      #tm-ai-panel .tm-chat-messages {
        max-height: 220px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 10px;
      }
      #tm-ai-panel .tm-chat-bubble {
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 13px;
        line-height: 1.6;
        word-break: break-word;
      }
      #tm-ai-panel .tm-chat-bubble.tm-user {
        align-self: flex-end;
        max-width: 92%;
        background: #6366f1;
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      #tm-ai-panel .tm-chat-bubble.tm-assistant {
        align-self: flex-start;
        max-width: 100%;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        color: #1e293b;
        border-bottom-left-radius: 4px;
      }
      #tm-ai-panel .tm-chat-bubble.tm-assistant.tm-markdown code {
        background: #eef2ff;
        color: #4338ca;
      }
      #tm-ai-panel .tm-chat-bubble.tm-loading {
        color: #64748b;
        font-style: italic;
        background: #f8fafc;
        border: 1px dashed #cbd5e1;
      }
      #tm-ai-panel .tm-chat-bubble.tm-error {
        background: #fef2f2;
        border: 1px solid #fecaca;
        color: #b91c1c;
      }
      #tm-ai-panel .tm-chat-input-row {
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }
      #tm-ai-panel .tm-chat-input-row textarea {
        flex: 1;
        min-height: 56px;
        max-height: 120px;
        resize: vertical;
        padding: 8px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 13px;
        font-family: inherit;
        color: #0f172a;
        background: #fff;
      }
      #tm-ai-panel .tm-chat-input-row textarea:disabled {
        background: #f8fafc;
        color: #94a3b8;
      }
      #tm-ai-panel .tm-chat-input-row .tm-btn {
        flex: 0 0 auto;
        min-width: 64px;
      }
      #tm-ai-panel .tm-chat-clear {
        width: 100%;
        margin-top: 8px;
        padding: 8px 12px;
        font-size: 12px;
      }
      #tm-ai-panel .tm-config-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
      }
      #tm-ai-panel .tm-config-actions .tm-btn {
        flex: 1;
      }
      #tm-ai-panel .tm-import-input {
        display: none;
      }
      #tm-ai-panel .tm-settings label {
        display: block;
        font-size: 12px;
        font-weight: 600;
        color: #475569;
        margin: 10px 0 5px;
      }
      #tm-ai-panel .tm-settings input,
      #tm-ai-panel .tm-settings select {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        font-size: 13px;
        color: #0f172a;
        background: #fff;
      }
      #tm-ai-panel .tm-settings .tm-hint {
        font-size: 11px;
        color: #94a3b8;
        margin-top: 4px;
        line-height: 1.4;
      }
      #tm-ai-panel .tm-settings .tm-save-row {
        margin-top: 14px;
      }
      #tm-ai-panel .tm-save-status {
        margin-top: 8px;
        font-size: 11px;
        color: #94a3b8;
        text-align: center;
      }
      #tm-ai-panel .tm-save-status.tm-success {
        color: #16a34a;
      }
      #tm-ai-panel .tm-model-section {
        margin-top: 4px;
      }
      #tm-ai-panel .tm-model-toolbar {
        display: flex;
        gap: 8px;
        margin: 6px 0 10px;
      }
      #tm-ai-panel .tm-model-toolbar .tm-btn {
        flex: 1;
        padding: 8px 10px;
        font-size: 12px;
      }
      #tm-ai-panel .tm-model-table-wrap {
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        overflow: auto;
        max-height: 180px;
        margin-bottom: 8px;
      }
      #tm-ai-panel .tm-model-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      #tm-ai-panel .tm-model-table th {
        position: sticky;
        top: 0;
        background: #f8fafc;
        color: #64748b;
        font-weight: 600;
        text-align: left;
        padding: 8px;
        border-bottom: 1px solid #e2e8f0;
        white-space: nowrap;
      }
      #tm-ai-panel .tm-model-table td {
        padding: 6px 8px;
        border-bottom: 1px solid #f1f5f9;
        vertical-align: middle;
      }
      #tm-ai-panel .tm-model-table tr:last-child td {
        border-bottom: none;
      }
      #tm-ai-panel .tm-model-table input {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        font-size: 12px;
      }
      #tm-ai-panel .tm-model-table .tm-del-btn {
        border: none;
        background: transparent;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 4px;
      }
      #tm-ai-panel .tm-model-table .tm-del-btn:hover {
        color: #ef4444;
      }
      #tm-ai-panel .tm-model-status {
        font-size: 11px;
        color: #64748b;
        min-height: 16px;
        margin-bottom: 4px;
      }
      #tm-ai-panel .tm-model-status.tm-error {
        color: #b91c1c;
      }
      #tm-ai-panel .tm-model-status.tm-success {
        color: #16a34a;
      }
      #tm-ai-panel .tm-model-empty {
        padding: 16px;
        text-align: center;
        color: #94a3b8;
        font-size: 12px;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function getSavedFabPos() {
    try {
      return JSON.parse(GM_getValue(STORAGE.fabPos, "null"));
    } catch (_) {
      return null;
    }
  }

  function saveFabPos(data) {
    GM_setValue(STORAGE.fabPos, JSON.stringify(data));
  }

  function clampFabPosition(fab, left, top) {
    const maxLeft = window.innerWidth - fab.offsetWidth;
    const maxTop = window.innerHeight - fab.offsetHeight;
    return {
      left: Math.max(0, Math.min(left, maxLeft)),
      top: Math.max(0, Math.min(top, maxTop)),
    };
  }

  function snapFabToEdge(fab, left, top) {
    const w = fab.offsetWidth;
    const h = fab.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = FAB_MARGIN;
    const cx = left + w / 2;
    const cy = top + h / 2;

    const distLeft = cx;
    const distRight = vw - cx;
    const distTop = cy;
    const distBottom = vh - cy;
    const minDist = Math.min(distLeft, distRight, distTop, distBottom);

    let edge;
    let finalLeft = left;
    let finalTop = top;

    if (minDist === distLeft) {
      edge = "left";
      finalLeft = margin;
      finalTop = Math.max(margin, Math.min(top, vh - h - margin));
    } else if (minDist === distRight) {
      edge = "right";
      finalLeft = vw - w - margin;
      finalTop = Math.max(margin, Math.min(top, vh - h - margin));
    } else if (minDist === distTop) {
      edge = "top";
      finalTop = margin;
      finalLeft = Math.max(margin, Math.min(left, vw - w - margin));
    } else {
      edge = "bottom";
      finalTop = vh - h - margin;
      finalLeft = Math.max(margin, Math.min(left, vw - w - margin));
    }

    fab.style.left = finalLeft + "px";
    fab.style.top = finalTop + "px";
    fab.style.right = "auto";
    fab.style.bottom = "auto";
    fab.dataset.snapEdge = edge;
    saveFabPos({ edge, left: finalLeft, top: finalTop });
    return { edge, left: finalLeft, top: finalTop };
  }

  function applyFabPosition(fab) {
    const pos = getSavedFabPos();
    fab.style.right = "auto";
    fab.style.bottom = "auto";

    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      const clamped = clampFabPosition(fab, pos.left, pos.top);
      fab.style.left = clamped.left + "px";
      fab.style.top = clamped.top + "px";
      fab.dataset.snapEdge = pos.edge || "";
      return;
    }

    const defaultLeft = window.innerWidth - fab.offsetWidth - 20;
    const defaultTop = window.innerHeight - fab.offsetHeight - 20;
    fab.style.left = defaultLeft + "px";
    fab.style.top = defaultTop + "px";
    fab.dataset.snapEdge = "right";
    saveFabPos({ edge: "right", left: defaultLeft, top: defaultTop });
  }

  function setupFabDrag(fab, onClick) {
    fab.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      fabDragging = true;
      fabDragMoved = false;
      const rect = fab.getBoundingClientRect();
      fabDragOffset.x = e.clientX - rect.left;
      fabDragOffset.y = e.clientY - rect.top;
      fabDragStart.x = e.clientX;
      fabDragStart.y = e.clientY;

      fab.classList.add("tm-dragging");
      fab.style.left = rect.left + "px";
      fab.style.top = rect.top + "px";
      fab.style.right = "auto";
      fab.style.bottom = "auto";
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!fabDragging) return;
      if (
        Math.abs(e.clientX - fabDragStart.x) > FAB_CLICK_THRESHOLD ||
        Math.abs(e.clientY - fabDragStart.y) > FAB_CLICK_THRESHOLD
      ) {
        fabDragMoved = true;
      }
      const next = clampFabPosition(
        fab,
        e.clientX - fabDragOffset.x,
        e.clientY - fabDragOffset.y
      );
      fab.style.left = next.left + "px";
      fab.style.top = next.top + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!fabDragging) return;
      fabDragging = false;
      fab.classList.remove("tm-dragging");

      const left = parseInt(fab.style.left, 10);
      const top = parseInt(fab.style.top, 10);
      if (!Number.isNaN(left) && !Number.isNaN(top)) {
        snapFabToEdge(fab, left, top);
      }
    });

    fab.addEventListener("click", (e) => {
      if (fabDragMoved) {
        fabDragMoved = false;
        return;
      }
      e.stopPropagation();
      onClick();
    });

    window.addEventListener("resize", () => {
      if (fabDragging) return;
      const left = parseInt(fab.style.left, 10);
      const top = parseInt(fab.style.top, 10);
      if (!Number.isNaN(left) && !Number.isNaN(top)) {
        snapFabToEdge(fab, left, top);
      } else {
        applyFabPosition(fab);
      }
    });
  }

  function getSavedPanelPos() {
    try {
      return JSON.parse(GM_getValue(STORAGE.panelPos, "null"));
    } catch (_) {
      return null;
    }
  }

  function savePanelPos(left, top) {
    GM_setValue(STORAGE.panelPos, JSON.stringify({ left, top }));
  }

  function applyPanelPosition(panel) {
    const pos = getSavedPanelPos();
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      panel.style.left = pos.left + "px";
      panel.style.top = pos.top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    } else {
      panel.style.right = "20px";
      panel.style.bottom = "84px";
      panel.style.left = "auto";
      panel.style.top = "auto";
    }
  }

  function setupDrag(panel, handle) {
    handle.addEventListener("mousedown", (e) => {
      if (e.target.closest(".tm-icon-btn")) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;

      const left = rect.left;
      const top = rect.top;
      panel.style.left = left + "px";
      panel.style.top = top + "px";
      panel.style.right = "auto";
      panel.style.bottom = "auto";

      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      const left = Math.max(0, Math.min(e.clientX - dragOffset.x, maxLeft));
      const top = Math.max(0, Math.min(e.clientY - dragOffset.y, maxTop));
      panel.style.left = left + "px";
      panel.style.top = top + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      const left = parseInt(panel.style.left, 10);
      const top = parseInt(panel.style.top, 10);
      if (!Number.isNaN(left) && !Number.isNaN(top)) {
        savePanelPos(left, top);
      }
    });
  }

  function switchTab(root, tabName) {
    const currentTab = root.querySelector(".tm-tab.tm-active")?.dataset.tab;
    if (currentTab === "settings" && tabName !== "settings") {
      persistSettingsFromForm(root, true);
    }
    root.querySelectorAll(".tm-tab").forEach((tab) => {
      tab.classList.toggle("tm-active", tab.dataset.tab === tabName);
    });
    root.querySelector("#tm-ai-tab-summary").style.display =
      tabName === "summary" ? "block" : "none";
    root.querySelector("#tm-ai-tab-settings").style.display =
      tabName === "settings" ? "block" : "none";
  }

  function readMappingsFromTable(root) {
    const rows = root.querySelectorAll("#tm-ai-model-table tbody tr");
    return Array.from(rows)
      .map((row) => ({
        displayName: row.querySelector(".tm-col-display")?.value.trim() || "",
        requestModel: row.querySelector(".tm-col-request")?.value.trim() || "",
        contextWindow: row.querySelector(".tm-col-context")?.value.trim() || "",
      }))
      .filter((item) => item.displayName && item.requestModel);
  }

  function renderModelSelect(root, mappings, selectedModel) {
    const select = root.querySelector("#tm-ai-model-select");
    if (!select) return;

    select.innerHTML = "";
    if (!mappings.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "请先获取或添加模型";
      select.appendChild(opt);
      return;
    }

    mappings.forEach((item) => {
      const opt = document.createElement("option");
      opt.value = item.requestModel;
      opt.textContent = item.displayName;
      if (item.requestModel === selectedModel) opt.selected = true;
      select.appendChild(opt);
    });

    if (selectedModel && !mappings.some((item) => item.requestModel === selectedModel)) {
      const opt = document.createElement("option");
      opt.value = selectedModel;
      opt.textContent = selectedModel + " (未在列表中)";
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }
  }

  function renderModelTable(root, mappings) {
    const tbody = root.querySelector("#tm-ai-model-table tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    if (!mappings.length) {
      tbody.innerHTML =
        '<tr><td colspan="4" class="tm-model-empty">暂无模型，点击「获取模型列表」自动检测，或手动添加</td></tr>';
      return;
    }

    mappings.forEach((item, index) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input class="tm-col-display" type="text" value="${escapeAttr(item.displayName)}"></td>
        <td><input class="tm-col-request" type="text" value="${escapeAttr(item.requestModel)}"></td>
        <td><input class="tm-col-context" type="text" value="${escapeAttr(item.contextWindow || "")}" placeholder="例如: 128000"></td>
        <td><button type="button" class="tm-del-btn" data-index="${index}" title="删除">🗑</button></td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".tm-del-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mappings = readMappingsFromTable(root);
        const index = Number(btn.dataset.index);
        mappings.splice(index, 1);
        renderModelTable(root, mappings);
        renderModelSelect(root, mappings, root.querySelector("#tm-ai-model-select")?.value || "");
        persistSettingsFromForm(root, true);
      });
    });
  }

  function escapeAttr(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function setModelStatus(root, text, type) {
    const el = root.querySelector("#tm-ai-model-status");
    if (!el) return;
    el.textContent = text || "";
    el.className = "tm-model-status" + (type ? " tm-" + type : "");
  }

  function renderProfileSelectOptions(select, profiles, selectedId) {
    if (!select) return;
    select.innerHTML = "";
    profiles.forEach((profile) => {
      const opt = document.createElement("option");
      opt.value = profile.id;
      opt.textContent = profile.name + (profile.enabled ? "" : "（已禁用）");
      if (profile.id === selectedId) opt.selected = true;
      select.appendChild(opt);
    });
  }

  function renderProfileControls(root) {
    const profiles = getApiProfiles();
    const defaultId = getDefaultProfileId();
    const activeId = getActiveProfileId();

    renderProfileSelectOptions(root.querySelector("#tm-ai-summary-profile"), profiles, activeId);
    renderProfileSelectOptions(root.querySelector("#tm-ai-default-profile"), profiles, defaultId);
    renderProfileSelectOptions(root.querySelector("#tm-ai-active-profile"), profiles, activeId);

    const list = root.querySelector("#tm-ai-profile-list");
    if (list) {
      list.innerHTML = "";
      profiles.forEach((profile) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          "tm-profile-chip" +
          (profile.id === editingProfileId ? " tm-active" : "") +
          (profile.id === defaultId ? " tm-default" : "");
        btn.textContent = profile.name;
        btn.addEventListener("click", () => selectEditingProfile(root, profile.id));
        list.appendChild(btn);
      });
    }

    const failover = root.querySelector("#tm-ai-failover-enabled");
    if (failover) failover.checked = isFailoverEnabled();
  }

  function loadProfileIntoForm(root, profile) {
    if (!profile) return;
    editingProfileId = profile.id;
    root.querySelector("#tm-ai-profile-name").value = profile.name;
    root.querySelector("#tm-ai-api-url").value = profile.apiUrl;
    root.querySelector("#tm-ai-api-key").value = profile.apiKey;
    root.querySelector("#tm-ai-profile-enabled").checked = profile.enabled !== false;
    renderModelTable(root, profile.modelMappings || []);
    renderModelSelect(root, profile.modelMappings || [], profile.model);
  }

  function selectEditingProfile(root, profileId, persistCurrent) {
    if (persistCurrent !== false && editingProfileId) {
      const data = readSettingsFromForm(root);
      saveSettingsData(data);
    }
    const profile = getProfileById(profileId);
    if (!profile) return;
    loadProfileIntoForm(root, profile);
    renderProfileControls(root);
  }

  function addProfileFromPreset(root, presetKey) {
    const preset = PROFILE_PRESETS[presetKey];
    if (!preset) return;
    const data = readSettingsFromForm(root);
    const profile = normalizeProfile(
      {
        id: createProfileId(),
        name: preset.name,
        apiUrl: preset.apiUrl,
        apiKey: preset.apiKey,
        model: preset.model,
        enabled: true,
      },
      preset.name
    );
    data.profiles.push(profile);
    saveSettingsData(data);
    selectEditingProfile(root, profile.id, false);
    persistSettingsFromForm(root, true);
  }

  function deleteCurrentProfile(root) {
    const profiles = getApiProfiles();
    if (profiles.length <= 1) {
      setModelStatus(root, "至少保留一个 API 配置", "error");
      return;
    }
    const data = readSettingsFromForm(root);
    const currentId = editingProfileId || getActiveProfileId();
    data.profiles = data.profiles.filter((item) => item.id !== currentId);
    if (data.defaultProfileId === currentId) {
      data.defaultProfileId = data.profiles[0].id;
    }
    if (data.activeProfileId === currentId) {
      data.activeProfileId = data.profiles[0].id;
    }
    saveSettingsData(data);
    selectEditingProfile(root, data.profiles[0].id, false);
    renderProfileControls(root);
    persistSettingsFromForm(root, true);
    setModelStatus(root, "已删除当前 API 配置", "success");
  }

  function loadSettingsForm(root) {
    getApiProfiles();
    const cfg = getConfig();
    root.querySelector("#tm-ai-content-mode").value = cfg.contentMode;
    root.querySelector("#tm-ai-max-chars").value = cfg.maxChars;
    editingProfileId = getActiveProfileId();
    const profile = getProfileById(editingProfileId) || getApiProfiles()[0];
    if (profile) loadProfileIntoForm(root, profile);
    renderProfileControls(root);
  }

  function setBusyState(root, busy) {
    isBusy = busy;
    const summarizeBtn = root.querySelector("#tm-ai-summarize-btn");
    const abortBtn = root.querySelector("#tm-ai-abort-btn");
    const chatSend = root.querySelector("#tm-ai-chat-send");
    const chatInput = root.querySelector("#tm-ai-chat-input");
    const chatAbort = root.querySelector("#tm-ai-chat-abort-btn");
    if (summarizeBtn) summarizeBtn.disabled = busy;
    if (abortBtn) abortBtn.hidden = !busy;
    if (chatSend) chatSend.disabled = busy || !chatSession;
    if (chatInput) chatInput.disabled = busy || !chatSession;
    if (chatAbort) chatAbort.hidden = !busy;
    root.querySelector("#tm-ai-summary-profile")?.toggleAttribute("disabled", busy);
  }

  function abortCurrentTask(root) {
    abortActiveRequest();
    setBusyState(root, false);
    const resultEl = root.querySelector("#tm-ai-result");
    const metaEl = root.querySelector("#tm-ai-meta");
    if (resultEl && resultEl.classList.contains("tm-loading")) {
      setResult(resultEl, "已中断总结。", "error");
    }
    if (metaEl) metaEl.textContent = "";
    const loadingBubble = root.querySelector("#tm-ai-chat-messages .tm-loading");
    if (loadingBubble) {
      loadingBubble.className = "tm-chat-bubble tm-assistant tm-error";
      loadingBubble.textContent = "已中断。";
    }
  }

  async function fetchAndApplyModels(root) {
    const apiUrl = root.querySelector("#tm-ai-api-url").value.trim();
    const apiKey = root.querySelector("#tm-ai-api-key").value;
    const btn = root.querySelector("#tm-ai-fetch-models");

    if (!apiUrl) {
      setModelStatus(root, "请先填写 API 地址", "error");
      return;
    }
    if (profileNeedsApiKey({ apiUrl, apiKey }) && !apiKey) {
      setModelStatus(root, "请先填写 API Key", "error");
      return;
    }

    btn.disabled = true;
    setModelStatus(root, "正在从 OpenAI 兼容接口获取模型列表...", "");

    try {
      const fetched = await fetchModelsFromApi(apiUrl, apiKey);
      const existing = readMappingsFromTable(root);
      const merged = mergeFetchedModels(existing, fetched);
      renderModelTable(root, merged);
      const nextModel =
        root.querySelector("#tm-ai-model-select")?.value || merged[0]?.requestModel || "";
      renderModelSelect(root, merged, nextModel);
      persistSettingsFromForm(root, true);
      setModelStatus(root, `已检测到 ${fetched.length} 个模型，当前共 ${merged.length} 条映射`, "success");
    } catch (err) {
      setModelStatus(root, err.message || String(err), "error");
      log(err);
    } finally {
      btn.disabled = false;
    }
  }

  function addManualModelRow(root) {
    const mappings = readMappingsFromTable(root);
    mappings.push({ displayName: "", requestModel: "", contextWindow: "" });
    renderModelTable(root, mappings);
    renderModelSelect(root, mappings, root.querySelector("#tm-ai-model-select")?.value || "");
    const lastInput = root.querySelector("#tm-ai-model-table tbody tr:last-child .tm-col-display");
    if (lastInput) lastInput.focus();
  }

  function setResult(el, text, type) {
    el.className = "tm-result" + (type ? " tm-" + type : "");
    if (type === "loading" || type === "error") {
      el.classList.remove("tm-markdown");
      el.textContent = text;
      return;
    }
    el.classList.add("tm-markdown");
    el.innerHTML = renderMarkdown(text);
  }

  function resetChatSession(root) {
    chatSession = null;
    const section = root.querySelector("#tm-ai-chat-section");
    const messagesEl = root.querySelector("#tm-ai-chat-messages");
    const input = root.querySelector("#tm-ai-chat-input");
    if (section) section.classList.remove("tm-visible");
    if (messagesEl) messagesEl.innerHTML = "";
    if (input) {
      input.value = "";
      input.disabled = true;
      input.placeholder = "完成总结后可继续提问...";
    }
    const sendBtn = root.querySelector("#tm-ai-chat-send");
    if (sendBtn) sendBtn.disabled = true;
  }

  function startChatSession(root, pageContext, summary) {
    chatSession = {
      pageContext,
      summary,
      messages: [],
    };
    const section = root.querySelector("#tm-ai-chat-section");
    const input = root.querySelector("#tm-ai-chat-input");
    const sendBtn = root.querySelector("#tm-ai-chat-send");
    const messagesEl = root.querySelector("#tm-ai-chat-messages");
    if (section) section.classList.add("tm-visible");
    if (messagesEl) messagesEl.innerHTML = "";
    if (input) {
      input.disabled = false;
      input.placeholder = "基于当前页面和总结继续提问，Enter 发送，Shift+Enter 换行";
      input.focus();
    }
    if (sendBtn) sendBtn.disabled = false;
  }

  function appendChatBubble(container, role, content, type) {
    const bubble = document.createElement("div");
    bubble.className = "tm-chat-bubble tm-" + role + (type ? " tm-" + type : "");
    if (role === "assistant" && !type) {
      bubble.classList.add("tm-markdown");
      bubble.innerHTML = renderMarkdown(content);
    } else {
      bubble.textContent = content;
    }
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  function setChatBusy(root, busy) {
    setBusyState(root, busy);
  }

  async function sendChatMessage(root) {
    if (!chatSession) return;
    const input = root.querySelector("#tm-ai-chat-input");
    const messagesEl = root.querySelector("#tm-ai-chat-messages");
    const question = input.value.trim();
    if (!question) return;

    beginRequest();
    input.value = "";
    appendChatBubble(messagesEl, "user", question);
    const loadingBubble = appendChatBubble(messagesEl, "assistant", "正在思考...", "loading");
    setChatBusy(root, true);

    try {
      const answer = await callFollowUpApi(chatSession, question, {
        onTrying(profile, index, total) {
          loadingBubble.textContent =
            total > 1 && isFailoverEnabled()
              ? `正在使用 ${profile.name} 思考... (${index + 1}/${total})`
              : "正在思考...";
        },
      });
      chatSession.messages.push({ role: "user", content: question });
      chatSession.messages.push({ role: "assistant", content: answer });
      loadingBubble.className = "tm-chat-bubble tm-assistant tm-markdown";
      loadingBubble.innerHTML = renderMarkdown(answer);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      loadingBubble.className = "tm-chat-bubble tm-assistant tm-error";
      loadingBubble.textContent = err.message || String(err);
      log(err);
    } finally {
      setChatBusy(root, false);
      root.querySelector("#tm-ai-chat-input")?.focus();
    }
  }

  function clearChatMessages(root) {
    if (!chatSession) return;
    chatSession.messages = [];
    const messagesEl = root.querySelector("#tm-ai-chat-messages");
    if (messagesEl) messagesEl.innerHTML = "";
  }

  async function runSummary(root) {
    const cfg = getConfig();
    const resultEl = root.querySelector("#tm-ai-result");
    const metaEl = root.querySelector("#tm-ai-meta");
    const profileId = root.querySelector("#tm-ai-summary-profile")?.value || cfg.activeProfileId;

    beginRequest();
    resetChatSession(root);
    setBusyState(root, true);
    setResult(resultEl, "正在读取页面内容并请求 AI 总结...", "loading");
    metaEl.textContent = "";

    try {
      if (profileId) {
        setActiveProfileId(profileId);
        persistSettingsFromForm(root, true);
      }
      const page = getPageContent(cfg.contentMode);
      if (!page.body.trim()) {
        throw new Error("未能从当前页面读取到有效内容");
      }

      const { summary, truncated, originalLength, pageContext, profile } = await callSummaryApi(
        page,
        {
          profileId,
          onTrying(currentProfile, index, total) {
            setResult(
              resultEl,
              total > 1 && isFailoverEnabled()
                ? `正在使用 ${currentProfile.name} 总结... (${index + 1}/${total})`
                : `正在使用 ${currentProfile.name} 总结...`,
              "loading"
            );
          },
        }
      );
      setResult(resultEl, summary);
      startChatSession(root, pageContext, summary);
      const profileTip = profile ? ` · API：${profile.name}` : "";
      metaEl.textContent = truncated
        ? `已截断：原始 ${originalLength.toLocaleString()} 字符 → 发送 ${cfg.maxChars.toLocaleString()} 字符以内${profileTip}`
        : `内容长度：${originalLength.toLocaleString()} 字符${profileTip}`;
    } catch (err) {
      setResult(resultEl, err.message || String(err), "error");
      log(err);
    } finally {
      setBusyState(root, false);
    }
  }

  function togglePanel(show) {
    const panel = document.getElementById("tm-ai-panel");
    if (!panel) return;
    panelVisible = show !== undefined ? show : !panelVisible;
    panel.classList.toggle("tm-visible", panelVisible);
  }

  function createUI() {
    if (document.getElementById(ROOT_ID)) return;

    injectStyles();

    const root = document.createElement("div");
    root.id = ROOT_ID;

    root.innerHTML = `
      <button id="tm-ai-fab" title="路南网页总结AI - 拖动可吸附边缘，点击打开面板">
        <img id="tm-ai-fab-icon" alt="${APP_NAME}">
        <span class="tm-fab-fallback" aria-hidden="true">路</span>
      </button>
      <div id="tm-ai-panel">
        <div class="tm-head">
          <span class="tm-head-title">${APP_NAME}</span>
          <div class="tm-head-actions">
            <button class="tm-icon-btn" id="tm-ai-minimize" title="收起">−</button>
            <button class="tm-icon-btn" id="tm-ai-close" title="关闭">×</button>
          </div>
        </div>
        <div class="tm-tabs">
          <button class="tm-tab tm-active" data-tab="summary">总结</button>
          <button class="tm-tab" data-tab="settings">设置</button>
        </div>
        <div class="tm-body">
          <div id="tm-ai-tab-summary">
            <div class="tm-page-info">
              <div><strong>当前页面</strong></div>
              <div id="tm-ai-page-title"></div>
              <div id="tm-ai-page-url"></div>
            </div>
            <div class="tm-profile-bar">
              <label for="tm-ai-summary-profile">当前 API</label>
              <select id="tm-ai-summary-profile"></select>
            </div>
            <div class="tm-actions-row">
              <button class="tm-btn tm-btn-primary" id="tm-ai-summarize-btn">开始总结</button>
              <button class="tm-btn tm-btn-danger" id="tm-ai-abort-btn" hidden>中断</button>
              <button class="tm-btn tm-btn-secondary" id="tm-ai-refresh-info">刷新</button>
            </div>
            <div class="tm-result" id="tm-ai-result">点击「开始总结」即可。</div>
            <div class="tm-meta" id="tm-ai-meta"></div>
            <div id="tm-ai-chat-section" class="tm-chat-section">
              <div class="tm-chat-head">继续提问</div>
              <div id="tm-ai-chat-messages" class="tm-chat-messages"></div>
              <div class="tm-chat-input-row">
                <textarea id="tm-ai-chat-input" placeholder="完成总结后可继续提问..." disabled></textarea>
                <button type="button" class="tm-btn tm-btn-primary" id="tm-ai-chat-send" disabled>发送</button>
                <button type="button" class="tm-btn tm-btn-danger" id="tm-ai-chat-abort-btn" hidden>中断</button>
              </div>
              <button type="button" class="tm-btn tm-btn-secondary tm-chat-clear" id="tm-ai-chat-clear">清空对话</button>
            </div>
          </div>
          <div id="tm-ai-tab-settings" class="tm-settings" style="display:none">
            <label>API 配置管理</label>
            <div class="tm-hint">可配置多个 API（如 DeepSeek、Ollama），支持默认选择与失败容灾切换</div>

            <label class="tm-inline-check">
              <input type="checkbox" id="tm-ai-failover-enabled" checked>
              启用容灾切换（当前 API 失败时自动尝试其他已启用 API）
            </label>

            <label for="tm-ai-default-profile">默认 API</label>
            <select id="tm-ai-default-profile"></select>

            <label for="tm-ai-active-profile">当前使用 API</label>
            <select id="tm-ai-active-profile"></select>

            <div id="tm-ai-profile-list" class="tm-profile-list"></div>
            <div class="tm-profile-actions">
              <button type="button" class="tm-btn tm-btn-secondary" data-preset="deepseek">+ DeepSeek</button>
              <button type="button" class="tm-btn tm-btn-secondary" data-preset="ollama">+ Ollama</button>
              <button type="button" class="tm-btn tm-btn-secondary" data-preset="openai">+ OpenAI</button>
              <button type="button" class="tm-btn tm-btn-secondary" id="tm-ai-delete-profile">删除当前</button>
            </div>

            <label for="tm-ai-profile-name">配置名称</label>
            <input id="tm-ai-profile-name" type="text" placeholder="例如：DeepSeek 主力">
            <label class="tm-inline-check">
              <input type="checkbox" id="tm-ai-profile-enabled" checked>
              参与容灾切换
            </label>

            <label for="tm-ai-api-url">API 地址</label>
            <input id="tm-ai-api-url" type="text" placeholder="https://api.openai.com/v1/chat/completions">
            <div class="tm-hint">支持 OpenAI 兼容接口，填写完整的 chat/completions 地址</div>

            <label for="tm-ai-api-key">API Key</label>
            <input id="tm-ai-api-key" type="password" placeholder="sk-...">

            <div class="tm-model-section">
              <label for="tm-ai-model-select">当前使用模型</label>
              <select id="tm-ai-model-select"></select>

              <div class="tm-model-toolbar">
                <button type="button" class="tm-btn tm-btn-secondary" id="tm-ai-fetch-models">获取模型列表</button>
                <button type="button" class="tm-btn tm-btn-secondary" id="tm-ai-add-model">+ 添加模型</button>
              </div>
              <div class="tm-hint">OpenAI 兼容接口会自动请求 <code>/v1/models</code> 检测模型名称；可编辑显示名与实际请求模型</div>
              <div id="tm-ai-model-status" class="tm-model-status"></div>
              <div class="tm-model-table-wrap">
                <table class="tm-model-table" id="tm-ai-model-table">
                  <thead>
                    <tr>
                      <th>菜单显示名</th>
                      <th>实际请求模型</th>
                      <th>上下文窗口</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody></tbody>
                </table>
              </div>
            </div>

            <label for="tm-ai-content-mode">内容来源</label>
            <select id="tm-ai-content-mode">
              <option value="text">页面可见文本（推荐，适合文章）</option>
              <option value="html-clean">页面 HTML（去除 script/style）</option>
              <option value="html">完整 HTML 源码（类似查看源代码）</option>
            </select>

            <label for="tm-ai-max-chars">最大字符数</label>
            <input id="tm-ai-max-chars" type="number" min="5000" max="500000" step="1000">
            <div class="tm-hint">超出部分会自动截断，避免超出模型上下文限制</div>

            <div class="tm-actions-row tm-save-row">
              <button class="tm-btn tm-btn-primary" id="tm-ai-save-settings">保存设置</button>
            </div>
            <div class="tm-config-actions">
              <button type="button" class="tm-btn tm-btn-secondary" id="tm-ai-export-config">导出配置</button>
              <button type="button" class="tm-btn tm-btn-secondary" id="tm-ai-import-config">导入配置</button>
              <input type="file" id="tm-ai-import-input" class="tm-import-input" accept=".json,application/json">
            </div>
            <div id="tm-ai-save-status" class="tm-save-status">修改后会自动记住配置</div>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);

    const panel = root.querySelector("#tm-ai-panel");
    const fab = root.querySelector("#tm-ai-fab");

    applyPanelPosition(panel);
    applyFabPosition(fab);
    loadFabIcon(fab);
    setupDrag(panel, panel.querySelector(".tm-head"));
    setupFabDrag(fab, () => {
      togglePanel(true);
      updatePageInfo(root);
    });
    loadSettingsForm(root);
    updatePageInfo(root);

    fab.addEventListener("mousedown", (e) => e.stopPropagation());

    panel.addEventListener("click", (e) => e.stopPropagation());
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    root.querySelector("#tm-ai-close").addEventListener("click", () => togglePanel(false));
    root.querySelector("#tm-ai-minimize").addEventListener("click", () => togglePanel(false));

    root.querySelectorAll(".tm-tab").forEach((tab) => {
      tab.addEventListener("click", () => switchTab(root, tab.dataset.tab));
    });

    root.querySelector("#tm-ai-summarize-btn").addEventListener("click", () => runSummary(root));
    root.querySelector("#tm-ai-abort-btn").addEventListener("click", () => abortCurrentTask(root));
    root.querySelector("#tm-ai-chat-abort-btn").addEventListener("click", () => abortCurrentTask(root));
    root.querySelector("#tm-ai-refresh-info").addEventListener("click", () => updatePageInfo(root));
    root.querySelector("#tm-ai-summary-profile").addEventListener("change", () => {
      setActiveProfileId(root.querySelector("#tm-ai-summary-profile").value);
      persistSettingsFromForm(root, true);
      renderProfileControls(root);
    });
    root.querySelector("#tm-ai-chat-send").addEventListener("click", () => sendChatMessage(root));
    root.querySelector("#tm-ai-chat-clear").addEventListener("click", () => clearChatMessages(root));
    root.querySelector("#tm-ai-chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(root);
      }
    });
    root.querySelector("#tm-ai-export-config").addEventListener("click", () => {
      exportConfigFile();
      showSaveStatus(root);
      const status = root.querySelector("#tm-ai-save-status");
      if (status) status.textContent = "配置已导出为 JSON 文件";
    });
    root.querySelector("#tm-ai-import-config").addEventListener("click", () => {
      root.querySelector("#tm-ai-import-input")?.click();
    });
    root.querySelector("#tm-ai-import-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        await importConfigFile(file);
        loadSettingsForm(root);
        showSaveStatus(root);
        const status = root.querySelector("#tm-ai-save-status");
        if (status) status.textContent = "配置已从文件导入并保存";
      } catch (err) {
        const status = root.querySelector("#tm-ai-save-status");
        if (status) {
          status.textContent = err.message || String(err);
          status.className = "tm-save-status";
          status.style.color = "#b91c1c";
          setTimeout(() => {
            status.style.color = "";
            status.textContent = "修改后会自动记住配置";
          }, 3000);
        }
        log(err);
      }
    });
    root.querySelector("#tm-ai-fetch-models").addEventListener("click", () => fetchAndApplyModels(root));
    root.querySelector("#tm-ai-add-model").addEventListener("click", () => addManualModelRow(root));
    root.querySelector("#tm-ai-delete-profile").addEventListener("click", () => deleteCurrentProfile(root));
    root.querySelectorAll("[data-preset]").forEach((btn) => {
      btn.addEventListener("click", () => addProfileFromPreset(root, btn.dataset.preset));
    });

    root.querySelector("#tm-ai-model-table").addEventListener("input", () => {
      const mappings = readMappingsFromTable(root);
      renderModelSelect(
        root,
        mappings,
        root.querySelector("#tm-ai-model-select")?.value || ""
      );
      persistSettingsFromForm(root);
    });

    [
      "#tm-ai-profile-name",
      "#tm-ai-api-url",
      "#tm-ai-api-key",
      "#tm-ai-content-mode",
      "#tm-ai-max-chars",
      "#tm-ai-default-profile",
      "#tm-ai-active-profile",
    ].forEach((selector) => {
      root.querySelector(selector)?.addEventListener("input", () => persistSettingsFromForm(root));
      root.querySelector(selector)?.addEventListener("change", () => persistSettingsFromForm(root, true));
    });

    root.querySelector("#tm-ai-failover-enabled")?.addEventListener("change", () => {
      persistSettingsFromForm(root, true);
    });
    root.querySelector("#tm-ai-profile-enabled")?.addEventListener("change", () => {
      persistSettingsFromForm(root, true);
    });

    root.querySelector("#tm-ai-model-select")?.addEventListener("change", () => {
      persistSettingsFromForm(root, true);
    });

    root.querySelector("#tm-ai-save-settings").addEventListener("click", () => {
      persistSettingsFromForm(root, true);
      switchTab(root, "summary");
      setResult(
        root.querySelector("#tm-ai-result"),
        "设置已保存。点击「开始总结」即可使用。"
      );
    });
  }

  function updatePageInfo(root) {
    const titleEl = root.querySelector("#tm-ai-page-title");
    const urlEl = root.querySelector("#tm-ai-page-url");
    if (titleEl) titleEl.textContent = document.title || "(无标题)";
    if (urlEl) urlEl.textContent = location.href;
  }

  function registerMenu() {
    GM_registerMenuCommand("打开路南网页总结AI", () => {
      createUI();
      togglePanel(true);
      updatePageInfo(document.getElementById(ROOT_ID));
    });
    GM_registerMenuCommand("路南网页总结AI - 打开设置", () => {
      createUI();
      togglePanel(true);
      switchTab(document.getElementById(ROOT_ID), "settings");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", createUI);
  } else {
    createUI();
  }

  registerMenu();
})();
