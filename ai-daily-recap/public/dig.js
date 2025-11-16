(function () {
  /**
   * Read query params from window.location.search.
   */
  const params = new URLSearchParams(window.location.search);
  const articleUrl = params.get("article_url") || "";
  // lang parameter removed; model will auto-detect language

  const openArticle = document.getElementById("open-article");
  if (openArticle && articleUrl) {
    openArticle.setAttribute("href", articleUrl);
  }

  const transcriptEl = document.getElementById("transcript");
  const qEl = document.getElementById("q");
  const sendBtn = document.getElementById("send");
  const retryBtn = document.getElementById("retry");
  const toastEl = document.getElementById("toast");

  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }
  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }
  function writeCookie(name, value) {
    document.cookie =
      name +
      "=" +
      encodeURIComponent(value) +
      "; path=/; max-age=" +
      60 * 60 * 24 * 365;
  }

  const cookieName = "dig_history";
  function loadHist() {
    try {
      const v = readCookie(cookieName);
      return v ? JSON.parse(v) : {};
    } catch (e) {
      return {};
    }
  }
  function saveHist(obj) {
    try {
      writeCookie(cookieName, JSON.stringify(obj));
    } catch (e) {
      /* ignore */
    }
  }

  function trimHist(arr) {
    if (!Array.isArray(arr)) return [];
    const hasSys = arr[0] && arr[0].role === "system";
    const sys = hasSys ? [arr[0]] : [];
    const rest = hasSys ? arr.slice(1) : arr.slice(0);
    const maxMsgs = 16; // last 8 user/assistant turns
    const trimmed = rest.slice(Math.max(0, rest.length - maxMsgs));
    return sys.concat(trimmed);
  }

  const key = hashStr(articleUrl);
  let store = loadHist();
  if (!store[key]) store[key] = { history: [], initial: "" };

  function renderMarkdown(md) {
    const html = window.marked.parse(md || "");
    return html;
  }
  function appendMsg(role, content) {
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "assistant");
    div.innerHTML = renderMarkdown(content);
    transcriptEl.appendChild(div);
    window.scrollTo(0, document.body.scrollHeight);
  }

  function systemPrompt() {
    return "You are an expert news research assistant. Detect the article language automatically and respond in that language. Analyze the article at the provided URL with up-to-date knowledge. Be concise, accurate, and provide helpful, well-structured answers. If unsure, say so.\nIt is of utmost importance that you respect the language of the article: if the article is written in french, your recap should be in french. If the article is in english, your recap should be in english.";
  }

  async function stream(messages) {
    toast("");
    retryBtn.style.display = "none";
    const res = await fetch("/dig/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ article_url: articleUrl, messages }),
    });
    if (!res.ok) {
      toast("Error: " + res.status + " " + res.statusText);
      retryBtn.style.display = "inline-block";
      return null;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let full = "";
    appendMsg("assistant", "");
    const last = transcriptEl.lastElementChild;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      while (true) {
        const idx = buf.indexOf("\n");
        if (idx === -1) break;
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") {
          reader.cancel();
          return full;
        }
        try {
          const obj = JSON.parse(data);
          const delta = obj.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            last.innerHTML = renderMarkdown(full);
          }
          if (obj.error) {
            toast(obj.error.message || "Stream error");
          }
        } catch (e) {
          /* ignore */
        }
      }
    }
    return full;
  }

  function toast(msg) {
    toastEl.textContent = msg || "";
  }

  async function runInitial() {
    if (store[key].initial) {
      appendMsg("assistant", store[key].initial);
      return;
    }
    const messages = [
      { role: "system", content: systemPrompt() },
      {
        role: "user",
        content:
          "Summarize and analyze this article: " +
          articleUrl +
          ". Focus on key points, implications, and useful context.",
      },
    ];
    const res = await stream(messages);
    if (res) {
      store[key].initial = res;
      store[key].history = trimHist(
        messages.concat([{ role: "assistant", content: res }]),
      );
      saveHist(store);
    }
  }

  sendBtn.addEventListener("click", async () => {
    const q = qEl.value.trim();
    if (!q) return;
    qEl.value = "";
    appendMsg("user", q);
    const base =
      store[key].history && store[key].history.length
        ? store[key].history
        : [{ role: "system", content: systemPrompt() }];
    const messages = base.concat([{ role: "user", content: q }]);
    const res = await stream(messages);
    if (res) {
      store[key].history = trimHist(
        messages.concat([{ role: "assistant", content: res }]),
      );
      saveHist(store);
    }
  });
  retryBtn.addEventListener("click", runInitial);

  // Render existing history
  if (store[key].history) {
    for (const m of store[key].history) {
      appendMsg(m.role, m.content);
    }
  }

  // Auto-run initial dig on first visit
  if (!store[key].initial) {
    runInitial();
  }
})();
