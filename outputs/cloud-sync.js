(() => {
  "use strict";

  const TOKEN_KEY = "orion-lente-cloud-session-v1";
  const API_KEY = "orion-lente-cloud-api-v1";
  const configuredApi = String(window.ORION_LENTE_CONFIG?.apiBase || "").replace(/\/$/, "");
  let apiBase = configuredApi || localStorage.getItem(API_KEY) || "";
  let timer = null;
  let saving = false;
  let pendingState = null;

  const syncButton = document.querySelector("#cloudSyncBtn");
  const logoutButton = document.querySelector("#cloudLogoutBtn");
  const status = document.querySelector("#cloudStatus");
  const token = () => localStorage.getItem(TOKEN_KEY) || "";

  function setStatus(text, kind = "local") {
    if (!status) return;
    status.textContent = text;
    status.dataset.kind = kind;
  }

  function refreshControls() {
    const connected = Boolean(token());
    if (syncButton) syncButton.textContent = connected ? "↻ Sincronizar ahora" : "☁ Conectar Google";
    if (logoutButton) logoutButton.hidden = !connected;
    if (!apiBase) setStatus("Modo local · backend pendiente", "local");
    else if (!connected) setStatus("Modo local · sin iniciar sesión", "local");
  }

  function captureSession() {
    const url = new URL(location.href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const session = hash.get("orion_lente_session") || url.searchParams.get("orion_lente_session");
    if (!session) return false;
    localStorage.setItem(TOKEN_KEY, session);
    url.searchParams.delete("orion_lente_session");
    hash.delete("orion_lente_session");
    url.hash = hash.toString();
    history.replaceState({}, "", url.pathname + url.search + url.hash);
    return true;
  }

  async function request(path, options = {}) {
    if (!apiBase) throw new Error("missing_api");
    const headers = { ...(options.headers || {}) };
    if (token()) headers.authorization = `Bearer ${token()}`;
    const response = await fetch(`${apiBase}${path}`, { ...options, headers });
    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      refreshControls();
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error(`http_${response.status}`);
    return response.json();
  }

  async function flush() {
    if (!token() || !pendingState || saving) return;
    saving = true;
    const state = pendingState;
    pendingState = null;
    setStatus("Sincronizando…", "working");
    try {
      const data = await request("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (data.state) window.OrionLente?.replaceState(data.state);
      setStatus(data.calendar?.ok ? "Sincronizado · Google Calendar" : "Sincronizado · Calendar pendiente", data.calendar?.ok ? "ok" : "warning");
    } catch (error) {
      pendingState = pendingState || state;
      setStatus(error.message === "unauthorized" ? "Sesión vencida · vuelve a conectar" : "Sin conexión · guardado local", "error");
    } finally {
      saving = false;
      if (pendingState) {
        clearTimeout(timer);
        timer = setTimeout(flush, 1800);
      }
    }
  }

  function queueSave(state) {
    pendingState = structuredClone(state);
    if (!token()) return;
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  }

  async function pull() {
    if (!token()) return;
    setStatus("Leyendo tu nube…", "working");
    try {
      const data = await request("/api/state");
      if (data.state) {
        window.OrionLente?.replaceState(data.state);
        setStatus("Sincronizado · Google Calendar", "ok");
      } else {
        pendingState = window.OrionLente?.getState();
        await flush();
      }
    } catch (error) {
      setStatus(error.message === "unauthorized" ? "Sesión vencida · vuelve a conectar" : "Sin conexión · usando datos locales", "error");
    }
  }

  function configureApiIfNeeded() {
    if (apiBase) return true;
    const value = prompt("Pega la URL del backend de ORI♡N LENTE (termina en workers.dev):", "https://orion-lente-api.tu-cuenta.workers.dev");
    if (!value) return false;
    apiBase = value.trim().replace(/\/$/, "");
    localStorage.setItem(API_KEY, apiBase);
    refreshControls();
    return true;
  }

  async function syncOrLogin() {
    if (!configureApiIfNeeded()) return;
    if (!token()) {
      location.href = `${apiBase}/auth/google`;
      return;
    }
    pendingState = window.OrionLente?.getState();
    await flush();
  }

  async function logout() {
    try { await request("/api/logout", { method: "POST" }); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    pendingState = null;
    refreshControls();
  }

  window.OrionLenteCloud = { save: queueSave, sync: pull };
  if (syncButton) syncButton.addEventListener("click", syncOrLogin);
  if (logoutButton) logoutButton.addEventListener("click", logout);
  window.addEventListener("online", () => token() && pull());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pendingState) flush();
  });

  const returnedFromGoogle = captureSession();
  refreshControls();
  if (token()) pull();
  if (returnedFromGoogle) setStatus("Cuenta conectada · preparando sincronización", "working");
})();
