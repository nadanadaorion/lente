// ORI♡N LENTE: conflict-safe synchronization across devices.
const GOOGLE_SCOPE = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error(error);
      return json({ error: "internal_error", message: "No se pudo completar la operación." }, 500, request, env);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return corsResponse(request, env);
  if (url.pathname === "/health") return json({ ok: true, service: "orion-lente-api" }, 200, request, env);
  if (url.pathname === "/auth/google" && request.method === "GET") return beginGoogleAuth(env);
  if (url.pathname === "/auth/callback" && request.method === "GET") return finishGoogleAuth(request, env);

  if (url.pathname.startsWith("/api/")) {
    const session = await requireSession(request, env);
    if (!session) return json({ error: "unauthorized" }, 401, request, env);
    if (url.pathname === "/api/me" && request.method === "GET") {
      return json({ email: session.email, name: session.name, picture: session.picture }, 200, request, env);
    }
    if (url.pathname === "/api/state" && request.method === "GET") return getState(session, request, env);
    if (url.pathname === "/api/state" && request.method === "PUT") return putState(session, request, env);
    if (url.pathname === "/api/logout" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.tokenHash).run();
      return json({ ok: true }, 200, request, env);
    }
  }
  return json({ error: "not_found" }, 404, request, env);
}

async function beginGoogleAuth(env) {
  assertConfig(env);
  const state = randomToken(24);
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(new Date().toISOString()),
    env.DB.prepare("INSERT INTO oauth_states (state, expires_at) VALUES (?, ?)").bind(state, expires),
  ]);
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${trimSlash(env.WORKER_URL)}/auth/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
}

async function finishGoogleAuth(request, env) {
  assertConfig(env);
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const stateRow = await env.DB.prepare("SELECT state FROM oauth_states WHERE state = ? AND expires_at > ?")
    .bind(state, new Date().toISOString()).first();
  if (!code || !stateRow) return authError("La autorización caducó. Vuelve a intentarlo.");
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${trimSlash(env.WORKER_URL)}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) return authError("Google no pudo completar la autorización.");
  const tokens = await tokenResponse.json();
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) return authError("No pude leer tu cuenta de Google.");
  const profile = await profileResponse.json();
  const email = String(profile.email || "").toLowerCase();
  if (!email || email !== String(env.ALLOWED_EMAIL).toLowerCase()) {
    return authError("Esta aplicación está reservada para la cuenta configurada.", 403);
  }

  const now = new Date().toISOString();
  let encryptedRefreshToken = null;
  if (tokens.refresh_token) encryptedRefreshToken = await encryptText(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  await env.DB.prepare(`
    INSERT INTO users (email, display_name, picture_url, google_refresh_token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      display_name = excluded.display_name,
      picture_url = excluded.picture_url,
      google_refresh_token = COALESCE(excluded.google_refresh_token, users.google_refresh_token),
      updated_at = excluded.updated_at
  `).bind(email, profile.name || "", profile.picture || "", encryptedRefreshToken, now, now).run();

  const sessionToken = randomToken(32);
  const tokenHash = await sha256(sessionToken);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_email, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, email, expiresAt, now).run();
  const destination = new URL(env.FRONTEND_URL);
  destination.hash = new URLSearchParams({ orion_lente_session: sessionToken }).toString();
  return Response.redirect(destination.toString(), 302);
}

async function requireSession(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const tokenHash = await sha256(auth.slice(7));
  const row = await env.DB.prepare(`
    SELECT s.token_hash, s.user_email, u.display_name, u.picture_url, u.google_refresh_token
    FROM sessions s JOIN users u ON u.email = s.user_email
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).bind(tokenHash, new Date().toISOString()).first();
  if (!row) return null;
  return {
    tokenHash,
    email: row.user_email,
    name: row.display_name,
    picture: row.picture_url,
    encryptedRefreshToken: row.google_refresh_token,
  };
}

async function getState(session, request, env) {
  const row = await env.DB.prepare("SELECT state_json, state_version, updated_at FROM users WHERE email = ?")
    .bind(session.email).first();
  return json({
    state: row?.state_json ? JSON.parse(row.state_json) : null,
    version: Number(row?.state_version || 0),
    updatedAt: row?.updated_at || null,
  }, 200, request, env);
}

async function putState(session, request, env) {
  const text = await request.text();
  if (text.length > 1_000_000) return json({ error: "too_large" }, 413, request, env);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "invalid_json" }, 400, request, env); }
  const incoming = body?.state;
  if (!validState(incoming)) return json({ error: "invalid_state" }, 400, request, env);

  const oldRow = await env.DB.prepare("SELECT state_json, state_version, updated_at FROM users WHERE email = ?")
    .bind(session.email).first();
  const previous = oldRow?.state_json ? JSON.parse(oldRow.state_json) : null;
  const currentVersion = Number(oldRow?.state_version || 0);
      const baseVersion = body?.baseVersion;
  if (!Number.isInteger(baseVersion) || baseVersion !== currentVersion) {
    return json({
      error: "version_conflict",
      state: previous,
      version: currentVersion,
      updatedAt: oldRow?.updated_at || null,
    }, 409, request, env);
  }

  const claimed = await env.DB.prepare(`
    UPDATE users SET state_version = state_version + 1
    WHERE email = ? AND state_version = ?
  `).bind(session.email, currentVersion).run();
  if (!claimed.meta?.changes) {
    const latest = await env.DB.prepare("SELECT state_json, state_version, updated_at FROM users WHERE email = ?")
      .bind(session.email).first();
    return json({
      error: "version_conflict",
      state: latest?.state_json ? JSON.parse(latest.state_json) : null,
      version: Number(latest?.state_version || 0),
      updatedAt: latest?.updated_at || null,
    }, 409, request, env);
  }

  let calendar = { ok: false, reason: "not_connected" };
  let normalized = incoming;
  if (session.encryptedRefreshToken) {
    try {
      normalized = await syncCalendar(previous, incoming, session, env);
      calendar = { ok: true };
    } catch (error) {
      console.error("Calendar sync failed", error);
      calendar = { ok: false, reason: "sync_failed" };
    }
  }
  const updatedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE users SET state_json = ?, updated_at = ? WHERE email = ?")
    .bind(JSON.stringify(normalized), updatedAt, session.email).run();
  return json({ ok: true, state: normalized, version: currentVersion + 1, updatedAt, calendar }, 200, request, env);
}

function validState(value) {
  return value && typeof value === "object" && Array.isArray(value.artists) && Array.isArray(value.tasks) && Array.isArray(value.feed)
    && value.tasks.length <= 5000 && value.artists.length <= 100 && value.feed.length <= 1000;
}

async function syncCalendar(previous, incoming, session, env) {
  const refreshToken = await decryptText(session.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
  const accessToken = await getGoogleAccessToken(refreshToken, env);
  const oldTasks = new Map((previous?.tasks || []).map((task) => [String(task.id), task]));
  const newTasks = incoming.tasks.map((task) => ({ ...task }));
  const calendarId = encodeURIComponent(env.CALENDAR_ID || "primary");

  for (const task of newTasks) {
    const old = oldTasks.get(String(task.id));
    oldTasks.delete(String(task.id));
    const shouldExist = Boolean(task.due) && task.status !== "done";
    const eventId = task.calendarEventId || old?.calendarEventId;
    if (!shouldExist) {
      if (eventId) await calendarDelete(calendarId, eventId, accessToken);
      delete task.calendarEventId;
      continue;
    }
    const changed = !old || calendarSignature(old) !== calendarSignature(task);
    if (eventId && changed) {
      task.calendarEventId = await calendarUpdate(calendarId, eventId, task, incoming, accessToken);
    } else if (!eventId) {
      task.calendarEventId = await calendarCreate(calendarId, task, incoming, accessToken);
    } else {
      task.calendarEventId = eventId;
    }
  }
  for (const old of oldTasks.values()) {
    if (old.calendarEventId) await calendarDelete(calendarId, old.calendarEventId, accessToken);
  }
  return { ...incoming, tasks: newTasks };
}

function calendarSignature(task) {
  return JSON.stringify([task.title, task.due, task.status, task.assignee, task.artistId, task.area, task.priority]);
}

function calendarBody(task, state) {
  const project = (state.artists || []).find((item) => item.id === task.artistId)?.name || "Sin proyecto";
  const end = new Date(`${task.due}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const endDate = end.toISOString().slice(0, 10);
  return {
    summary: `[ORI♡N LENTE] ${task.title}`,
    description: [`Proyecto: ${project}`, `Frente: ${task.area || "—"}`, `Responsable: ${task.assignee || "—"}`, "Creado desde ORI♡N LENTE"].join("\n"),
    start: { date: task.due },
    end: { date: endDate },
    extendedProperties: { private: { orionTaskId: String(task.id) } },
  };
}

async function calendarCreate(calendarId, task, state, accessToken) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: googleHeaders(accessToken),
    body: JSON.stringify(calendarBody(task, state)),
  });
  if (!response.ok) throw new Error(`Calendar create ${response.status}`);
  return (await response.json()).id;
}

async function calendarUpdate(calendarId, eventId, task, state, accessToken) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
    method: "PUT",
    headers: googleHeaders(accessToken),
    body: JSON.stringify(calendarBody(task, state)),
  });
  if (response.status === 404 || response.status === 410) {
    return calendarCreate(calendarId, task, state, accessToken);
  }
  if (!response.ok) throw new Error(`Calendar update ${response.status}`);
  return eventId;
}

async function calendarDelete(calendarId, eventId, accessToken) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`Calendar delete ${response.status}`);
}

function googleHeaders(accessToken) {
  return { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
}

async function getGoogleAccessToken(refreshToken, env) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) throw new Error(`Google refresh ${response.status}`);
  return (await response.json()).access_token;
}

function assertConfig(env) {
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY", "ALLOWED_EMAIL", "FRONTEND_URL", "WORKER_URL"]) {
    if (!env[key] || String(env[key]).startsWith("REEMPLAZAR")) throw new Error(`Missing ${key}`);
  }
}

async function encryptText(plainText, secret) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plainText)));
  return bytesToBase64(concatBytes(iv, cipher));
}

async function decryptText(payload, secret) {
  const bytes = base64ToBytes(payload);
  const key = await encryptionKey(secret);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}

async function encryptionKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a); result.set(b, a.length); return result;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function trimSlash(value) { return String(value).replace(/\/$/, ""); }

function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  const configured = new URL(env.FRONTEND_URL).origin;
  return origin === configured ? origin : configured;
}

function corsHeaders(request, env) {
  return {
    "access-control-allow-origin": allowedOrigin(request, env),
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function corsResponse(request, env) { return new Response(null, { status: 204, headers: corsHeaders(request, env) }); }

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request, env), "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function authError(message, status = 400) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>ORI♡N LENTE</title><body style="font-family:Segoe UI;padding:32px"><h1>No pude conectar ORI♡N LENTE</h1><p>${escapeHtml(message)}</p><p>Puedes cerrar esta pestaña y volver a intentarlo.</p></body>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
