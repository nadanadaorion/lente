(() => {
  "use strict";

  const TOKEN_KEY = "orion-lente-cloud-session-v1";
  const API_KEY = "orion-lente-cloud-api-v1";
  const META_KEY = "orion-lente-cloud-meta-v2";
  const POLL_MS = 30_000;
  const configuredApi = String(window.ORION_LENTE_CONFIG?.apiBase || "").replace(/\/$/, "");
  let apiBase = configuredApi || localStorage.getItem(API_KEY) || "";
  let timer = null;
  let saving = false;
  let reconciling = false;
  let syncRequested = false;
  let pendingState = null;
  let changeSequence = 0;

  const syncButtons = [...document.querySelectorAll("#cloudSyncBtn, [data-cloud-sync]")];
  const logoutButtons = [...document.querySelectorAll("#cloudLogoutBtn, [data-cloud-logout]")];
  const statuses = [...document.querySelectorAll("#cloudStatus, [data-cloud-status]")];
  const token = () => localStorage.getItem(TOKEN_KEY) || "";
  const clone = (value) => value == null ? value : structuredClone(value);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const storedMeta = loadMeta();
  let serverVersion = Number.isInteger(storedMeta?.version) ? storedMeta.version : null;
  let lastSyncedState = storedMeta?.state || null;

  function loadMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || "null"); }
    catch { return null; }
  }

  function saveMeta(state, version, updatedAt) {
    lastSyncedState = clone(state);
    serverVersion = Number(version || 0);
    try {
      localStorage.setItem(META_KEY, JSON.stringify({ state: lastSyncedState, version: serverVersion, updatedAt }));
    } catch {
      localStorage.removeItem(META_KEY);
    }
  }

  function setStatus(text, kind = "local", title = "") {
    statuses.forEach((status) => {
      status.textContent = text;
      status.dataset.kind = kind;
      status.title = title;
    });
  }

  function refreshControls() {
    const connected = Boolean(token());
    syncButtons.forEach((button) => { button.textContent = connected ? "\u21bb Sincronizar" : "\u2601 Conectar Google"; });
    logoutButtons.forEach((button) => { button.hidden = !connected; });
    if (!apiBase) setStatus("Modo local \u00b7 backend pendiente", "local");
    else if (!connected) setStatus("Modo local \u00b7 conecta Google", "local");
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
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      refreshControls();
      throw new Error("unauthorized");
    }
    if (response.status === 409) {
      const error = new Error("version_conflict");
      error.data = data;
      throw error;
    }
    if (!response.ok) throw new Error(`http_${response.status}`);
    return data || {};
  }

  function mergeItems(baseItems = [], localItems = [], remoteItems = []) {
    const base = new Map(baseItems.map((item) => [String(item.id), item]));
    const local = new Map(localItems.map((item) => [String(item.id), item]));
    const remote = new Map(remoteItems.map((item) => [String(item.id), item]));
    const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
    const merged = [];

    ids.forEach((id) => {
      const before = base.get(id);
      const here = local.get(id);
      const there = remote.get(id);
      let result;
      if (same(here, there)) result = here;
      else if (same(here, before)) result = there;
      else if (same(there, before)) result = here;
      else if (!before) result = here || there;
      else if (!here || !there) result = here || there;
      else {
        result = { ...there, ...here };
        if (!result.calendarEventId && there.calendarEventId) result.calendarEventId = there.calendarEventId;
      }
      if (result) merged.push(clone(result));
    });
    return merged;
  }

  function mergeStates(base, local, remote) {
    if (!local) return clone(remote);
    if (!remote) return clone(local);
    const foundation = base || remote;
    return {
      ...remote,
      ...local,
      artists: mergeItems(foundation.artists, local.artists, remote.artists),
      tasks: mergeItems(foundation.tasks, local.tasks, remote.tasks),
      lexicon: mergeItems(foundation.lexicon, local.lexicon, remote.lexicon),
      feed: mergeItems(foundation.feed, local.feed, remote.feed)
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
        .slice(0, 1000),
      selectedArtist: local.selectedArtist || remote.selectedArtist || "all",
      areaFilter: local.areaFilter || remote.areaFilter || "Todos",
    };
  }

  function syncedLabel(updatedAt, calendarOk) {
    const time = updatedAt ? new Date(updatedAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) : "ahora";
    return calendarOk === false ? `Nube ${time} \u00b7 Calendar pendiente` : `Sincronizado \u00b7 ${time}`;
  }

  async function flush() {
    if (!token() || !pendingState || saving) return;
    if (serverVersion === null) {
      await reconcile(true);
      return;
    }

    saving = true;
    const state = clone(pendingState);
    const startedSequence = changeSequence;
    pendingState = null;
    setStatus("Guardando en la nube\u2026", "working");
    try {
      const data = await request("/api/state", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state, baseVersion: serverVersion }),
      });
      saveMeta(data.state, data.version, data.updatedAt);
      if (startedSequence === changeSequence && !pendingState) {
        window.OrionLente?.replaceState(data.state);
      } else {
        const current = window.OrionLente?.getState();
        const rebased = mergeStates(state, current, data.state);
        window.OrionLente?.replaceState(rebased);
        pendingState = rebased;
      }
      setStatus(syncedLabel(data.updatedAt, data.calendar?.ok), data.calendar?.ok === false ? "warning" : "ok", "Tus tareas estan guardadas en la nube");
    } catch (error) {
      if (error.message === "version_conflict" && error.data?.state) {
        const current = pendingState || window.OrionLente?.getState() || state;
        const merged = mergeStates(lastSyncedState || error.data.state, current, error.data.state);
        saveMeta(error.data.state, error.data.version, error.data.updatedAt);
        window.OrionLente?.replaceState(merged);
        pendingState = merged;
        setStatus("Combinando cambios de otro dispositivo\u2026", "working");
      } else {
        pendingState = pendingState || state;
        setStatus(error.message === "unauthorized" ? "Sesion vencida \u00b7 conecta Google" : "Sin conexion \u00b7 guardado local", "error");
      }
    } finally {
      saving = false;
      if (pendingState) {
        clearTimeout(timer);
        timer = setTimeout(flush, 900);
      }
      if (syncRequested) {
        syncRequested = false;
        setTimeout(() => reconcile(true), 0);
      }
    }
  }

  function queueSave(state) {
    pendingState = clone(state);
    changeSequence += 1;
    if (!token()) return;
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  }

  async function reconcile(pushChanges = true) {
    if (!token()) return;
    if (reconciling || saving) {
      syncRequested = true;
      return;
    }
    reconciling = true;
    setStatus("Leyendo cambios de la nube\u2026", "working");
    try {
      const local = pendingState || window.OrionLente?.getState();
      const locallyChanged = lastSyncedState && !same(local, lastSyncedState);
      const data = await request("/api/state");
      if (!data.state) {
        serverVersion = Number(data.version || 0);
        pendingState = local;
      } else if (pendingState || locallyChanged) {
        const merged = mergeStates(lastSyncedState || data.state, local, data.state);
        saveMeta(data.state, data.version, data.updatedAt);
        window.OrionLente?.replaceState(merged);
        pendingState = merged;
      } else {
        saveMeta(data.state, data.version, data.updatedAt);
        window.OrionLente?.replaceState(data.state);
        setStatus(syncedLabel(data.updatedAt), "ok", "Datos descargados desde la nube");
      }
    } catch (error) {
      setStatus(error.message === "unauthorized" ? "Sesion vencida \u00b7 conecta Google" : "Sin conexion \u00b7 usando datos locales", "error");
    } finally {
      reconciling = false;
    }
    if (pushChanges && pendingState) await flush();
  }

  function configureApiIfNeeded() {
    if (apiBase) return true;
    const value = prompt("Pega la URL del backend de ORI\u2661N LENTE (termina en workers.dev):", "https://orion-lente-api.tu-cuenta.workers.dev");
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
    await reconcile(true);
  }

  async function logout() {
    try { await request("/api/logout", { method: "POST" }); } catch {}
    localStorage.removeItem(TOKEN_KEY);
    pendingState = null;
    refreshControls();
  }

  window.OrionLenteCloud = { save: queueSave, sync: () => reconcile(true), mergeStates };
  syncButtons.forEach((button) => button.addEventListener("click", syncOrLogin));
  logoutButtons.forEach((button) => button.addEventListener("click", logout));
  window.addEventListener("online", () => token() && reconcile(true));
  document.addEventListener("visibilitychange", () => {
    if (!token()) return;
    if (document.visibilityState === "visible") reconcile(true);
    else if (pendingState) flush();
  });
  setInterval(() => token() && navigator.onLine && document.visibilityState === "visible" && reconcile(true), POLL_MS);

  const returnedFromGoogle = captureSession();
  const currentState = window.OrionLente?.getState();
  if (lastSyncedState && currentState && !same(currentState, lastSyncedState)) pendingState = currentState;
  refreshControls();
  if (token()) reconcile(true);
  if (returnedFromGoogle) setStatus("Cuenta conectada \u00b7 preparando sincronizacion", "working");
})();
