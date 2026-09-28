"use strict";

// ---------- Setup ----------

const $ = (id) => document.getElementById(id);
const el = {
  app: $("app"), sidebar: $("sidebar"), scrim: $("scrim"),
  openSidebar: $("openSidebar"), closeSidebar: $("closeSidebar"),
  newChat: $("newChat"), search: $("search"), chatList: $("chatList"),
  connDot: $("connDot"), connTitle: $("connTitle"), connDetail: $("connDetail"), retry: $("retry"),
  chatTitle: $("chatTitle"), modelBadge: $("modelBadge"), banner: $("banner"),
  messages: $("messages"), empty: $("empty"), emptyDb: $("emptyDb"), thread: $("thread"),
  composer: $("composer"), input: $("input"), send: $("send"), hint: $("hint"),
};

const state = {
  chats: [],
  currentId: null,
  /** chatId -> AbortController for answers still streaming */
  streams: new Map(),
  status: null,
};

marked.setOptions({ gfm: true, breaks: false });

const ICON = {
  db: '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6M4.5 11.5v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

// ---------- Utilities ----------

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMarkdown(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text));
  for (const pre of target.querySelectorAll("pre")) addCopyButton(pre);
}

function addCopyButton(pre) {
  const btn = h("button", "copy-btn", "Copy");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector("code")?.innerText ?? pre.innerText);
      btn.textContent = "Copied";
    } catch {
      btn.textContent = "Failed";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  });
  pre.appendChild(btn);
}

function isNearBottom() {
  const m = el.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 120;
}
function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

// ---------- Connection status ----------

async function loadStatus() {
  try {
    state.status = await api("/api/status");
  } catch {
    state.status = { connected: false, connecting: false, error: "Cannot reach the DB Agent server." };
  }
  renderStatus();
  if (state.status.connecting) setTimeout(loadStatus, 1500);
}

function renderStatus() {
  const s = state.status;
  el.connDot.className = "dot " + (s.connected ? "ok" : s.connecting ? "busy" : "bad");
  el.modelBadge.textContent = s.model || "";
  el.modelBadge.hidden = !s.model;

  if (s.connected) {
    el.connTitle.textContent = s.database;
    el.connDetail.textContent = `${s.login} · ${s.server}`;
    el.retry.hidden = true;
    el.emptyDb.textContent = `Connected to ${s.database}. Read-only; results are capped at ${s.maxRows} rows.`;
    el.hint.textContent = `Read-only · max ${s.maxRows} rows per query · Enter to send, Shift+Enter for a new line`;
  } else {
    el.connTitle.textContent = s.connecting ? "Connecting…" : "Not connected";
    el.connDetail.textContent = s.connecting ? "" : "Open connection settings to connect.";
    el.retry.hidden = s.connecting;
    el.emptyDb.textContent = s.connecting ? "Connecting to the database…" : "The database isn't connected yet.";
  }

  if (!s.connected && !s.connecting && s.error) {
    el.banner.hidden = false;
    el.banner.textContent = `Database not connected: ${s.error}.`;
    const btn = h("button", "", "Connection settings");
    btn.type = "button";
    btn.addEventListener("click", () => window.openConnectionDialog?.());
    el.banner.appendChild(btn);
  } else if (s.connected && s.writeCapabilities?.length) {
    el.banner.hidden = false;
    el.banner.textContent =
      `Heads up: login “${s.login}” has write-capable roles (${s.writeCapabilities.join(", ")}). ` +
      "The agent still blocks writes, but a db_datareader-only login is safer.";
  } else {
    el.banner.hidden = true;
  }
}

el.retry.addEventListener("click", async () => {
  el.retry.disabled = true;
  el.connTitle.textContent = "Connecting…";
  el.connDot.className = "dot busy";
  try {
    state.status = await api("/api/reconnect", { method: "POST" });
  } catch (err) {
    state.status = { connected: false, error: err.message };
  }
  el.retry.disabled = false;
  renderStatus();
});

// ---------- Chat list ----------

async function loadChats() {
  try {
    state.chats = await api("/api/chats");
  } catch {
    state.chats = [];
  }
  renderChatList();
  updateTitle();
}

function dateGroup(iso) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.floor((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

function renderChatList() {
  const q = el.search.value.trim().toLowerCase();
  const chats = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
  el.chatList.replaceChildren();

  if (chats.length === 0) {
    el.chatList.appendChild(h("div", "list-empty", q ? "No chats match your search." : "No chats yet."));
    return;
  }

  let group = null;
  for (const chat of chats) {
    const g = dateGroup(chat.updatedAt);
    if (g !== group) {
      group = g;
      el.chatList.appendChild(h("div", "group-label", g));
    }
    el.chatList.appendChild(chatItem(chat));
  }
}

function chatItem(chat) {
  const item = h("div", "chat-item" + (chat.id === state.currentId ? " active" : ""));
  const link = h("a", "", chat.title);
  link.href = `#/c/${chat.id}`;
  link.title = chat.title;

  const actions = h("div", "actions");
  const renameBtn = h("button");
  renameBtn.innerHTML = ICON.pencil;
  renameBtn.title = "Rename";
  renameBtn.setAttribute("aria-label", "Rename chat");
  renameBtn.addEventListener("click", () => startRename(item, chat));

  const delBtn = h("button", "del");
  delBtn.innerHTML = ICON.trash;
  delBtn.title = "Delete";
  delBtn.setAttribute("aria-label", "Delete chat");
  delBtn.addEventListener("click", () => deleteChat(chat));

  actions.append(renameBtn, delBtn);
  item.append(link, actions);
  return item;
}

function startRename(item, chat) {
  const input = h("input");
  input.value = chat.title;
  item.replaceChildren(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (save && title && title !== chat.title) {
      try {
        await api(`/api/chats/${chat.id}`, { method: "PATCH", body: JSON.stringify({ title }) });
      } catch (err) {
        alert(`Rename failed: ${err.message}`);
      }
    }
    loadChats();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

async function deleteChat(chat) {
  if (!confirm(`Delete “${chat.title}”? This can't be undone.`)) return;
  try {
    await api(`/api/chats/${chat.id}`, { method: "DELETE" });
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
    return;
  }
  if (chat.id === state.currentId) location.hash = "";
  loadChats();
}

el.search.addEventListener("input", renderChatList);

// ---------- Routing ----------

function routeId() {
  return location.hash.match(/^#\/c\/([0-9a-f-]{36})$/)?.[1] ?? null;
}

async function onRoute() {
  const id = routeId();
  if (id === state.currentId && id !== null) return; // already showing (e.g. just created while sending)
  closeSidebar();
  if (!id) return showNewChat();
  await openChat(id);
}

function showNewChat() {
  state.currentId = null;
  el.thread.replaceChildren();
  el.empty.hidden = false;
  renderChatList();
  updateTitle();
  updateComposer();
  el.input.focus();
}

async function openChat(id) {
  state.currentId = id;
  renderChatList();
  updateComposer();
  let chat;
  try {
    chat = await api(`/api/chats/${id}`);
  } catch {
    location.hash = "";
    return;
  }
  if (state.currentId !== id) return; // user navigated away while loading
  renderThread(chat.messages);
  updateTitle(chat.title);
  scrollToBottom();
}

function updateTitle(title) {
  const chat = state.chats.find((c) => c.id === state.currentId);
  const text = title || chat?.title || "New chat";
  el.chatTitle.textContent = text;
  document.title = state.currentId ? `${text} · DB Agent` : "DB Agent";
}

window.addEventListener("hashchange", onRoute);

// ---------- Rendering messages ----------

function showThread() {
  el.empty.hidden = true;
}

function appendUser(text) {
  showThread();
  el.thread.appendChild(h("div", "msg-user", text));
}

function renderThread(messages) {
  el.thread.replaceChildren();
  el.empty.hidden = messages.length > 0;
  let turn = null;
  const steps = new Map();

  for (const m of messages) {
    if (m.role === "user") {
      appendUser(typeof m.content === "string" ? m.content : "");
      turn = null;
    } else if (m.role === "assistant") {
      turn ??= new AssistantTurn();
      if (typeof m.content === "string" && m.content.trim()) turn.addText(m.content);
      for (const call of m.tool_calls ?? []) {
        steps.set(call.id, turn.addStep(call.function.name, parseArgs(call.function.arguments)));
      }
    } else if (m.role === "tool") {
      steps.get(m.tool_call_id)?.finish(m.content);
    }
  }
  for (const step of steps.values()) if (!step.done) step.interrupt();
}

function parseArgs(args) {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

class AssistantTurn {
  constructor() {
    this.el = h("div", "msg-assistant");
    const avatar = h("div", "avatar");
    avatar.innerHTML = ICON.db;
    this.body = h("div", "assistant-body");
    this.el.append(avatar, this.body);
    el.thread.appendChild(this.el);
    this.text = null; // { node, value } of the text block currently receiving deltas
    this.thinking = null;
    this.renderQueued = false;
  }

  showThinking() {
    if (this.thinking) return;
    this.thinking = h("div", "thinking");
    this.thinking.append(h("span"), h("span"), h("span"));
    this.body.appendChild(this.thinking);
  }

  hideThinking() {
    this.thinking?.remove();
    this.thinking = null;
  }

  addText(value) {
    const node = h("div", "md");
    this.body.appendChild(node);
    renderMarkdown(node, value);
    this.text = null;
  }

  appendText(delta) {
    if (!this.text) {
      if (!delta.trim()) return; // don't open a block for stray whitespace
      this.text = { node: h("div", "md"), value: "" };
      this.body.insertBefore(this.text.node, this.thinking);
    }
    this.text.value += delta;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.text) return;
      const stick = isNearBottom();
      renderMarkdown(this.text.node, this.text.value);
      if (stick) scrollToBottom();
    });
  }

  flushText() {
    if (this.text) renderMarkdown(this.text.node, this.text.value);
    this.text = null;
  }

  addStep(name, input) {
    this.flushText();
    const step = new Step(name, input);
    this.body.insertBefore(step.el, this.thinking);
    return step;
  }

  addNotice(message) {
    this.flushText();
    this.body.insertBefore(h("div", "notice", message), this.thinking);
  }

  addError(message) {
    this.flushText();
    this.body.insertBefore(h("div", "error-box", message), this.thinking);
  }

  finalize() {
    this.hideThinking();
    this.flushText();
    if (!this.body.children.length) this.el.remove();
  }
}

class Step {
  constructor(name, input) {
    this.name = name;
    this.input = input || {};
    this.done = false;

    this.el = h("details", "step");
    const summary = h("summary");
    this.status = h("span", "step-status");
    this.status.appendChild(h("span", "spinner"));
    this.label = h("span", "step-label");
    summary.append(this.status, this.label);
    summary.insertAdjacentHTML("beforeend", ICON.chevron);
    this.body = h("div", "step-body");
    this.el.append(summary, this.body);

    this.setLabel(true);
    if (name === "run_query" && this.input.sql) {
      const pre = h("pre");
      pre.appendChild(h("code", "", this.input.sql));
      addCopyButton(pre);
      this.body.appendChild(pre);
    }
  }

  setLabel(running) {
    const i = this.input;
    this.label.replaceChildren();
    const add = (text, bold) => this.label.appendChild(bold ? h("b", "", text) : document.createTextNode(text));
    if (this.name === "list_tables") {
      add(running ? "Listing tables" : "Listed tables");
      if (i.schema) add(` in ${i.schema}`);
      if (i.name_pattern) add(` matching ${i.name_pattern}`);
    } else if (this.name === "describe_table") {
      add(running ? "Describing " : "Described ");
      add(`${i.schema}.${i.table}`, true);
    } else if (this.name === "run_query") {
      add(running ? "Running query" : "Ran query");
      if (i.purpose) {
        add(": ");
        add(i.purpose, true);
      }
    } else {
      add(this.name, true);
    }
  }

  finish(content, isError) {
    this.done = true;
    const error = isError || (typeof content === "string" && content.startsWith("ERROR: "));
    this.setLabel(false);
    this.status.className = "step-status " + (error ? "err" : "ok");
    this.status.innerHTML = error ? ICON.x : ICON.check;

    if (error) {
      this.body.appendChild(h("div", "step-error", String(content).replace(/^ERROR: /, "")));
      return;
    }
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      this.body.appendChild(h("pre", "", content));
      return;
    }
    if (isResult(data)) {
      this.body.appendChild(resultTable(data));
    } else {
      // describe_table: metadata + several result sets
      const meta = [data.object_type?.replace(/_/g, " ").toLowerCase(), data.approx_rows != null && `~${Number(data.approx_rows).toLocaleString()} rows`]
        .filter(Boolean)
        .join(" · ");
      if (meta) this.body.appendChild(h("div", "step-meta", meta));
      for (const [key, value] of Object.entries(data)) {
        if (isResult(value) && value.rows.length) this.body.appendChild(resultTable(value, key.replace(/_/g, " ")));
      }
    }
  }

  interrupt() {
    this.done = true;
    this.setLabel(false);
    this.status.className = "step-status";
    this.status.innerHTML = ICON.stop;
    this.body.appendChild(h("div", "step-meta", "Interrupted before a result came back."));
  }
}

function isResult(v) {
  return v && typeof v === "object" && Array.isArray(v.columns) && Array.isArray(v.rows);
}

function resultTable(result, title) {
  const wrap = h("div");
  if (title) wrap.appendChild(h("div", "result-title", title[0].toUpperCase() + title.slice(1)));
  const count = result.rows.length;
  wrap.appendChild(h("div", "step-meta", `${count.toLocaleString()} row${count === 1 ? "" : "s"}${result.truncated ? " (truncated, more exist)" : ""}`));
  if (!count) return wrap;

  const scroller = h("div", "result-wrap");
  const table = h("table", "result-table");
  const thead = h("thead");
  const headRow = h("tr");
  for (const c of result.columns) headRow.appendChild(h("th", "", c));
  thead.appendChild(headRow);
  const tbody = h("tbody");
  for (const row of result.rows) {
    const tr = h("tr");
    for (const v of row) {
      const td = h("td", v === null ? "null" : typeof v === "number" ? "num" : "", v === null ? "NULL" : String(v));
      td.title = v === null ? "" : String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  return wrap;
}

// ---------- Sending ----------

async function readSSE(response, onEvent) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      onEvent(event, data ? JSON.parse(data) : null);
    }
  }
}

async function send(text) {
  text = text.trim();
  if (!text) return;

  let chatId = state.currentId;
  if (chatId && state.streams.has(chatId)) return;

  el.input.value = "";
  autosize();

  if (!chatId) {
    try {
      chatId = (await api("/api/chats", { method: "POST" })).id;
    } catch (err) {
      alert(`Couldn't create a chat: ${err.message}`);
      return;
    }
    state.currentId = chatId; // set before the hash so onRoute doesn't reload it
    location.hash = `#/c/${chatId}`;
  }

  appendUser(text);
  const turn = new AssistantTurn();
  turn.showThinking();
  scrollToBottom();

  const controller = new AbortController();
  state.streams.set(chatId, controller);
  updateComposer();
  setTimeout(loadChats, 300); // show the new chat / title in the sidebar

  try {
    const res = await fetch(`/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      turn.addError(body.error || `${res.status} ${res.statusText}`);
      return;
    }

    const steps = new Map();
    await readSSE(res, (event, data) => {
      const stick = isNearBottom();
      switch (event) {
        case "text":
          turn.hideThinking();
          turn.appendText(data.delta);
          break;
        case "tool_start":
          turn.hideThinking();
          steps.set(data.id, turn.addStep(data.name, data.input));
          turn.showThinking();
          break;
        case "tool_end":
          steps.get(data.id)?.finish(data.content, data.isError);
          break;
        case "notice":
          turn.addNotice(data.message);
          break;
        case "error":
          turn.addError(data.message);
          break;
      }
      if (stick) scrollToBottom();
    });
  } catch (err) {
    if (err.name === "AbortError") turn.addNotice("Stopped.");
    else turn.addError(err.message);
  } finally {
    turn.finalize();
    state.streams.delete(chatId);
    updateComposer();
    await loadChats();
    // If the user left and came back mid-answer, the live view was replaced; reload the saved chat.
    if (state.currentId === chatId && !turn.el.isConnected) openChat(chatId);
  }
}

// ---------- Composer ----------

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
  updateComposer();
}

function updateComposer() {
  const streaming = state.currentId !== null && state.streams.has(state.currentId);
  el.send.classList.toggle("stop", streaming);
  el.send.title = streaming ? "Stop" : "Send (Enter)";
  el.send.setAttribute("aria-label", streaming ? "Stop" : "Send");
  el.send.disabled = !streaming && !el.input.value.trim();
}

el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!(state.currentId && state.streams.has(state.currentId))) send(el.input.value);
  }
});
el.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const controller = state.currentId && state.streams.get(state.currentId);
  if (controller) controller.abort();
  else send(el.input.value);
});

for (const btn of document.querySelectorAll(".suggestion")) {
  btn.addEventListener("click", () => send(btn.textContent));
}

// ---------- Sidebar (mobile) ----------

function closeSidebar() {
  el.app.classList.remove("sidebar-open");
}
el.openSidebar.addEventListener("click", () => el.app.classList.add("sidebar-open"));
el.closeSidebar.addEventListener("click", closeSidebar);
el.scrim.addEventListener("click", closeSidebar);
el.newChat.addEventListener("click", () => {
  if (location.hash) location.hash = "";
  else showNewChat();
  closeSidebar();
});

// ---------- Start ----------

loadStatus();
loadChats().then(onRoute);
