import { marked } from "/vendor/marked.js";
import DOMPurify from "/vendor/purify.js";

const $ = (s) => document.querySelector(s);
const els = {
  list: $("#conv-list"),
  messages: $("#messages"),
  empty: $("#empty"),
  input: $("#input"),
  send: $("#send"),
  stop: $("#stop"),
  form: $("#composer"),
  title: $("#conv-title"),
  banner: $("#banner"),
  modelInfo: $("#model-info"),
};
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const state = { convId: null, streaming: null, conversations: [] };

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    const href = node.getAttribute("href") || "";
    if (/^\d+$/.test(node.textContent.trim())) node.classList.add("cite");
    if (/^https?:/i.test(href)) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
      if (node.classList.contains("cite")) node.setAttribute("title", hostOf(href));
    } else if (href.startsWith("#memory/")) {
      node.setAttribute("title", "From an earlier conversation");
    }
  }
});

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function fmtWhen(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
function fmtMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function scrollToBottom(force = false) {
  const m = els.messages;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}

/* ---------- Sidebar ---------- */

async function loadList() {
  state.conversations = await fetch("/api/conversations").then((r) => r.json());
  const groups = new Map();
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  for (const c of state.conversations) {
    const d = new Date(c.updatedAt);
    const key = d.toDateString() === today ? "Today" : d.toDateString() === yesterday ? "Yesterday"
      : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  els.list.innerHTML = "";
  for (const [label, convs] of groups) {
    els.list.insertAdjacentHTML("beforeend", `<div class="group-label">${esc(label)}</div>`);
    for (const c of convs) {
      const a = document.createElement("a");
      a.className = "conv" + (c.id === state.convId ? " active" : "");
      a.href = `#c/${c.id}`;
      a.innerHTML = `<span>${esc(c.title)}</span><button class="del" type="button" title="Delete">×</button>`;
      a.querySelector(".del").addEventListener("click", async (e) => {
        e.preventDefault();
        if (!confirm(`Delete “${c.title}”? This also removes it from memory.`)) return;
        await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
        if (state.convId === c.id) location.hash = "";
        loadList();
      });
      els.list.appendChild(a);
    }
  }
}

async function loadHealth() {
  const h = await fetch("/api/health").then((r) => r.json()).catch(() => null);
  if (!h) return;
  els.modelInfo.textContent = h.provider ? `${h.provider} · ${h.model} · effort ${h.effort}` : "no model configured";
  const problems = [h.problem, !h.searchKey && "TAVILY_API_KEY is missing, so web search is off."].filter(Boolean);
  if (problems.length) {
    els.banner.hidden = false;
    els.banner.textContent = `${problems.join(" ")} Edit .env and restart the server.`;
  }
}

/* ---------- Conversation view ---------- */

function resetView() {
  els.messages.querySelectorAll(".msg").forEach((n) => n.remove());
  els.empty.hidden = false;
}

async function openConversation(id, focusTurn) {
  if (state.streaming) return;
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) { location.hash = ""; return; }
  const conv = await res.json();
  state.convId = conv.id;
  els.title.textContent = conv.title;
  resetView();
  els.empty.hidden = conv.turns.length > 0;
  for (const t of conv.turns) renderStoredTurn(t);
  document.querySelectorAll(".conv").forEach((n) => n.classList.toggle("active", n.getAttribute("href") === `#c/${id}`));
  if (focusTurn) {
    const n = els.messages.querySelector(`[data-turn="${CSS.escape(focusTurn)}"]`);
    if (n) {
      n.scrollIntoView({ block: "center" });
      n.classList.add("flash");
      setTimeout(() => n.classList.remove("flash"), 2000);
      return;
    }
  }
  scrollToBottom(true);
}

function newChat() {
  if (state.streaming) return;
  state.convId = null;
  els.title.textContent = "New chat";
  resetView();
  document.querySelectorAll(".conv.active").forEach((n) => n.classList.remove("active"));
  els.input.focus();
}

function addUserMessage(text, at, turnId) {
  els.empty.hidden = true;
  const div = document.createElement("div");
  div.className = "msg user";
  if (turnId) div.dataset.turn = turnId;
  div.innerHTML = `<span class="when">${esc(fmtWhen(at))}</span><div class="bubble"></div>`;
  div.querySelector(".bubble").textContent = text;
  els.messages.appendChild(div);
  return div;
}

function addAssistantMessage(turnId) {
  const div = document.createElement("div");
  div.className = "msg assistant";
  if (turnId) div.dataset.turn = turnId;
  div.innerHTML = `<div class="activity"></div><div class="answer"></div><div class="sources" hidden></div><div class="meta"></div>`;
  els.messages.appendChild(div);
  return div;
}

function searchLabel(input) {
  const qs = (input.queries || []).map((q) => `“${q}”`).join(", ");
  const f = [input.since && `since ${input.since}`, input.recency && `past ${input.recency}`, input.topic === "news" && "news",
    input.domains?.length && input.domains.join(", ")].filter(Boolean).join(" · ");
  return `Searched ${qs}${f ? ` (${f})` : ""}`;
}
function recallLabel(input) {
  const range = input.from ? (input.to && input.to !== input.from ? `${input.from} → ${input.to}` : input.from) : "";
  const parts = [range, input.query && `“${input.query}”`].filter(Boolean).join(" · ");
  return `Checked memory${parts ? `: ${parts}` : ""}`;
}

function addStep(activity, { id, label, running }) {
  const d = document.createElement("details");
  d.className = "step" + (running ? " running" : "");
  if (id) d.dataset.id = id;
  d.innerHTML = `<summary></summary><ul></ul>`;
  d.querySelector("summary").textContent = label;
  activity.appendChild(d);
  return d;
}
function finishStep(step, { summary, sources = [], ms, error }) {
  step.classList.remove("running");
  if (error) step.classList.add("error");
  step.querySelector("summary").textContent += ` — ${error ? "failed" : summary}${ms != null ? ` · ${fmtMs(ms)}` : ""}`;
  const ul = step.querySelector("ul");
  ul.innerHTML = sources.slice(0, 14).map((s) => {
    const ext = /^https?:/.test(s.url);
    return `<li><a href="${esc(s.url)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(s.title)}</a>${ext ? ` <span>· ${esc(hostOf(s.url))}</span>` : ""}${s.published ? ` <span>· ${esc(s.published)}</span>` : ""}</li>`;
  }).join("");
  if (error) ul.innerHTML = `<li>${esc(error)}</li>`;
}

function renderSources(container, sources) {
  if (!sources.length) { container.hidden = true; return; }
  container.hidden = false;
  container.innerHTML = `<ol>${sources.map((s) => {
    const ext = /^https?:/.test(s.url);
    return `<li><a href="${esc(s.url)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(s.title)}</a>${ext ? ` · ${esc(hostOf(s.url))}` : " · earlier conversation"}</li>`;
  }).join("")}</ol>`;
}

function renderStoredTurn(t) {
  addUserMessage(t.user, t.at, t.id);
  const a = addAssistantMessage(t.id);
  const activity = a.querySelector(".activity");
  for (const s of t.searches) {
    const step = addStep(activity, { label: searchLabel({ queries: s.queries, ...s.filters }) });
    finishStep(step, { summary: s.error && !s.results.length ? "failed" : `${s.results.length} results`, sources: s.results, ms: s.ms });
  }
  renderMarkdown(a.querySelector(".answer"), t.answer || "_(no answer)_");
  renderSources(a.querySelector(".sources"), t.sources);
  a.querySelector(".meta").textContent = `${fmtMs(t.ms)}${t.status === "stopped" ? " · stopped" : ""}`;
}

/* ---------- Sending & streaming ---------- */

function setStreaming(on) {
  els.send.hidden = on;
  els.stop.hidden = !on;
  if (!on) state.streaming = null;
  updateSendEnabled();
}
function updateSendEnabled() {
  els.send.disabled = !els.input.value.trim();
}

async function send(text) {
  if (state.streaming || !text.trim()) return;
  els.input.value = "";
  autosize();
  addUserMessage(text, new Date().toISOString());
  const a = addAssistantMessage();
  const activity = a.querySelector(".activity");
  const answerEl = a.querySelector(".answer");
  answerEl.innerHTML = `<span class="thinking">Thinking</span>`;
  scrollToBottom(true);

  const controller = new AbortController();
  state.streaming = controller;
  setStreaming(true);

  let answer = "";
  let renderQueued = false;
  const queueRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderMarkdown(answerEl, answer);
      scrollToBottom();
    });
  };
  const steps = new Map();
  const t0 = performance.now();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: state.convId, message: text, tz }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        const ev = JSON.parse(chunk.slice(6));
        switch (ev.type) {
          case "start":
            if (state.convId !== ev.conversationId) {
              state.convId = ev.conversationId;
              history.replaceState(null, "", `#c/${ev.conversationId}`);
            }
            a.dataset.turn = ev.turnId;
            a.previousElementSibling.dataset.turn = ev.turnId;
            break;
          case "text":
            answer += ev.text;
            queueRender();
            break;
          case "tool": {
            const label = ev.name === "web_search" ? searchLabel(ev.input) : recallLabel(ev.input);
            steps.set(ev.id, addStep(activity, { id: ev.id, label, running: true }));
            if (!answer) answerEl.innerHTML = `<span class="thinking">${ev.name === "web_search" ? "Reading results" : "Checking memory"}</span>`;
            scrollToBottom();
            break;
          }
          case "tool_done": {
            const step = steps.get(ev.id);
            if (step) finishStep(step, ev);
            if (!answer) answerEl.innerHTML = `<span class="thinking">Thinking</span>`;
            break;
          }
          case "done":
            answer = ev.turn.answer;
            renderMarkdown(answerEl, answer || "_(no answer)_");
            renderSources(a.querySelector(".sources"), ev.turn.sources);
            a.querySelector(".meta").textContent =
              `${fmtMs(ev.stats.ms)}${ev.stats.firstTokenMs ? ` · first words ${fmtMs(ev.stats.firstTokenMs)}` : ""}` +
              `${ev.turn.searches.length ? ` · ${ev.turn.searches.length} search step${ev.turn.searches.length > 1 ? "s" : ""}` : ""}`;
            els.title.textContent = ev.title;
            break;
          case "error":
            answerEl.innerHTML = (answer ? DOMPurify.sanitize(marked.parse(answer)) : "") + `<p class="error-msg">${esc(ev.message)}</p>`;
            break;
        }
      }
    }
  } catch (err) {
    if (controller.signal.aborted) {
      renderMarkdown(answerEl, answer ? `${answer}\n\n_(stopped)_` : "_(stopped)_");
      a.querySelector(".meta").textContent = `${fmtMs(Math.round(performance.now() - t0))} · stopped`;
    } else {
      answerEl.innerHTML = `<p class="error-msg">${esc(err.message || err)}</p>`;
    }
  } finally {
    a.querySelectorAll(".step.running").forEach((s) => s.classList.remove("running"));
    setStreaming(false);
    loadList();
    els.input.focus();
  }
}

/* ---------- Wiring ---------- */

function autosize() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  updateSendEnabled();
}
els.input.addEventListener("input", autosize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(els.input.value);
  }
});
els.form.addEventListener("submit", (e) => { e.preventDefault(); send(els.input.value); });
els.stop.addEventListener("click", () => state.streaming?.abort());
$("#new-chat").addEventListener("click", () => { location.hash = ""; newChat(); });
$("#toggle-sidebar").addEventListener("click", () => document.body.classList.toggle("show-sidebar"));
document.querySelectorAll("#examples button").forEach((b) => b.addEventListener("click", () => send(b.textContent)));

function route() {
  document.body.classList.remove("show-sidebar");
  const h = location.hash.slice(1);
  const mem = /^memory\/([\w-]+)\/([\w-]+)$/.exec(h);
  const conv = /^c\/([\w-]+)$/.exec(h);
  if (mem) openConversation(mem[1], mem[2]);
  else if (conv) { if (conv[1] !== state.convId) openConversation(conv[1]); }
  else newChat();
}
window.addEventListener("hashchange", route);

loadHealth();
loadList().then(route);
updateSendEnabled();
