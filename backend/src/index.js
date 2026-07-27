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
    if (url.pathname === "/api/backups" && request.method === "GET") return listBackups(session, request, env);
    const backupMatch = url.pathname.match(/^\/api\/backups\/(\d+)$/);
    const restoreMatch = url.pathname.match(/^\/api\/backups\/(\d+)\/restore$/);
    if (backupMatch && request.method === "GET") return getBackup(session, backupMatch[1], request, env);
    if (restoreMatch && request.method === "POST") return restoreBackup(session, restoreMatch[1], request, env);
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
      const result = await syncCalendar(incoming, session, env);
      normalized = { ...incoming, tasks: result.tasks };
      calendar = result.pending > 0 ? { ok: false, reason: "partial", pending: result.pending } : { ok: true };
    } catch (error) {
      console.error("Calendar sync failed", error);
      calendar = { ok: false, reason: "sync_failed" };
    }
  }
  const updatedAt = new Date().toISOString();
  const writes = [];
  if (oldRow?.state_json) {
    writes.push(env.DB.prepare(`
      INSERT INTO state_backups (user_email, version, state_json, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(session.email, currentVersion, oldRow.state_json, updatedAt));
  }
  writes.push(env.DB.prepare("UPDATE users SET state_json = ?, updated_at = ? WHERE email = ?")
    .bind(JSON.stringify(normalized), updatedAt, session.email));
  await env.DB.batch(writes);
  if (oldRow?.state_json) await pruneBackups(session.email, updatedAt, env);
  return json({ ok: true, state: normalized, version: currentVersion + 1, updatedAt, calendar }, 200, request, env);
}

async function listBackups(session, request, env) {
  const result = await env.DB.prepare(`
    SELECT id, version, created_at,
      COALESCE(json_array_length(state_json, '$.tasks'), 0) AS task_count
    FROM state_backups
    WHERE user_email = ?
    ORDER BY created_at DESC, id DESC
  `).bind(session.email).all();
  const backups = (result.results || []).map((row) => ({
    id: Number(row.id),
    version: Number(row.version),
    createdAt: row.created_at,
    taskCount: Number(row.task_count || 0),
  }));
  return json({ backups }, 200, request, env);
}

async function getBackup(session, id, request, env) {
  const row = await env.DB.prepare(`
    SELECT id, version, state_json, created_at
    FROM state_backups
    WHERE user_email = ? AND id = ?
  `).bind(session.email, Number(id)).first();
  if (!row) return json({ error: "backup_not_found" }, 404, request, env);
  const state = JSON.parse(row.state_json);
  return json({
    backup: {
      id: Number(row.id),
      version: Number(row.version),
      createdAt: row.created_at,
      taskCount: Array.isArray(state.tasks) ? state.tasks.length : 0,
      state,
    },
  }, 200, request, env);
}

async function restoreBackup(session, id, request, env) {
  const backup = await env.DB.prepare(`
    SELECT id, version, state_json, created_at
    FROM state_backups
    WHERE user_email = ? AND id = ?
  `).bind(session.email, Number(id)).first();
  if (!backup) return json({ error: "backup_not_found" }, 404, request, env);

  let restored;
  try { restored = JSON.parse(backup.state_json); }
  catch { return json({ error: "invalid_backup" }, 422, request, env); }
  if (!validState(restored)) return json({ error: "invalid_backup" }, 422, request, env);

  const current = await env.DB.prepare("SELECT state_json, state_version, updated_at FROM users WHERE email = ?")
    .bind(session.email).first();
  const currentVersion = Number(current?.state_version || 0);
  const claimed = await env.DB.prepare(`
    UPDATE users SET state_version = state_version + 1
    WHERE email = ? AND state_version = ?
  `).bind(session.email, currentVersion).run();
  if (!claimed.meta?.changes) {
    return json({ error: "version_conflict" }, 409, request, env);
  }

  let calendar = { ok: false, reason: "not_connected" };
  let normalized = restored;
  if (session.encryptedRefreshToken) {
    try {
      const result = await syncCalendar(restored, session, env);
      normalized = { ...restored, tasks: result.tasks };
      calendar = result.pending > 0 ? { ok: false, reason: "partial", pending: result.pending } : { ok: true };
    } catch (error) {
      console.error("Calendar sync failed", error);
      calendar = { ok: false, reason: "sync_failed" };
    }
  }

  const updatedAt = new Date().toISOString();
  const writes = [];
  if (current?.state_json) {
    writes.push(env.DB.prepare(`
      INSERT INTO state_backups (user_email, version, state_json, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(session.email, currentVersion, current.state_json, updatedAt));
  }
  writes.push(env.DB.prepare("UPDATE users SET state_json = ?, updated_at = ? WHERE email = ?")
    .bind(JSON.stringify(normalized), updatedAt, session.email));
  await env.DB.batch(writes);
  if (current?.state_json) await pruneBackups(session.email, updatedAt, env);

  return json({
    ok: true,
    state: normalized,
    version: currentVersion + 1,
    updatedAt,
    restoredFrom: Number(backup.id),
    calendar,
  }, 200, request, env);
}

async function pruneBackups(email, now, env) {
  await env.DB.prepare(`
    DELETE FROM state_backups
    WHERE user_email = ?
      AND id NOT IN (
        SELECT id FROM (
          SELECT id
          FROM state_backups
          WHERE user_email = ?
            AND julianday(created_at) >= julianday(?, '-24 hours')
          ORDER BY created_at DESC, id DESC
          LIMIT 20
        )
        UNION
        SELECT id FROM (
          SELECT id,
            ROW_NUMBER() OVER (
              PARTITION BY substr(created_at, 1, 10)
              ORDER BY created_at DESC, id DESC
            ) AS day_rank
          FROM state_backups
          WHERE user_email = ?
            AND julianday(created_at) >= julianday(?, '-30 days')
        )
        WHERE day_rank = 1
      )
  `).bind(email, email, now, email, now).run();
}

function validState(value) {
  return value && typeof value === "object" && Array.isArray(value.artists) && Array.isArray(value.tasks) && Array.isArray(value.feed)
    && (!value.ideas || (Array.isArray(value.ideas) && value.ideas.length <= 300))
    && (!value.releases || (Array.isArray(value.releases) && value.releases.length <= 50))
    && (!value.lexicon || (Array.isArray(value.lexicon) && value.lexicon.length <= 250))
    && value.tasks.length <= 5000 && value.artists.length <= 100 && value.feed.length <= 1000;
}

// La verdad de qué evento corresponde a cada tarea vive en calendar_sync, no en el
// estado del usuario: así un PUT que se queda sin presupuesto de subpeticiones puede
// reanudarse en el siguiente sin recrear eventos ni perder los que ya se sincronizaron.
async function loadCalendarSync(env, email) {
  const result = await env.DB.prepare(`
    SELECT task_id, event_id, signature, meeting_status FROM calendar_sync WHERE user_email = ?
  `).bind(email).all();
  return new Map((result.results || []).map((row) => [String(row.task_id), {
    eventId: row.event_id,
    signature: row.signature || "",
    meetingStatus: row.meeting_status || "",
  }]));
}

// Prioriza borrados (baratos y evitan eventos zombis), luego lo más próximo en el
// tiempo, y deja al final resolver el link de Meet: es lo único que no bloquea al
// usuario si el presupuesto de la petición se agota.
function planCalendarActions(tasks, syncRows) {
  const seen = new Set();
  const actions = [];
  for (const task of tasks) {
    const id = String(task.id);
    seen.add(id);
    const row = syncRows.get(id);
    if (!task.due) {
      if (row?.eventId) actions.push({ op: "delete", taskId: id, eventId: row.eventId, due: "" });
      continue;
    }
    const signature = calendarSignature(task);
    if (!row?.eventId) {
      actions.push({ op: "create", taskId: id, task, due: task.due });
    } else if (row.signature !== signature) {
      actions.push({ op: "update", taskId: id, task, eventId: row.eventId, due: task.due });
    } else if (
      task.meetingRequested && task.start && !taskMeetingLink(task) &&
      row.meetingStatus !== "ready" && row.meetingStatus !== "failed"
    ) {
      actions.push({ op: "resolve-meeting", taskId: id, task, eventId: row.eventId, due: task.due });
    }
  }
  for (const [id, row] of syncRows) {
    if (!seen.has(id) && row.eventId) actions.push({ op: "delete", taskId: id, eventId: row.eventId, due: "" });
  }
  const rank = { delete: 0, create: 1, update: 1, "resolve-meeting": 2 };
  actions.sort((a, b) => rank[a.op] - rank[b.op] || String(a.due).localeCompare(String(b.due)));
  return actions;
}

async function syncCalendar(incoming, session, env) {
  const refreshToken = await decryptText(session.encryptedRefreshToken, env.TOKEN_ENCRYPTION_KEY);
  const accessToken = await getGoogleAccessToken(refreshToken, env);
  const calendarId = encodeURIComponent(env.CALENDAR_ID || "primary");
  const syncRows = await loadCalendarSync(env, session.email);
  const actions = planCalendarActions(incoming.tasks, syncRows);
  // El presupuesto de subpeticiones de un Worker es ~50; -1 ya se gastó en el refresh
  // de arriba. Lo que no cabe queda "pending" y se reintenta en el próximo guardado.
  const budget = { remaining: Math.max(1, Number(env.CALENDAR_BUDGET) || 40) - 1 };
  const upserts = [];
  const deletes = [];
  let pending = 0;

  for (const action of actions) {
    if (budget.remaining <= 0) { pending += 1; continue; }
    try {
      if (action.op === "delete") {
        budget.remaining -= 1;
        await calendarDelete(calendarId, action.eventId, accessToken);
        deletes.push(action.taskId);
      } else if (action.op === "create") {
        budget.remaining -= 1;
        const requestConference = action.task.meetingRequested === true && Boolean(action.task.start);
        let event = await calendarCreate(calendarId, action.task, incoming, accessToken);
        if (requestConference) event = await resolveCalendarMeetingOnce(calendarId, event, accessToken, budget);
        applyCalendarEvent(action.task, event);
        upserts.push(syncRow(action, event));
      } else if (action.op === "update") {
        budget.remaining -= 1;
        const requestConference = action.task.meetingRequested === true && Boolean(action.task.start) && !taskMeetingLink(action.task);
        let event = await calendarUpdate(calendarId, action.eventId, action.task, incoming, accessToken, requestConference);
        if (requestConference) event = await resolveCalendarMeetingOnce(calendarId, event, accessToken, budget);
        applyCalendarEvent(action.task, event);
        upserts.push(syncRow(action, event));
      } else if (action.op === "resolve-meeting") {
        budget.remaining -= 1;
        let event = await calendarGet(calendarId, action.eventId, accessToken);
        const failed = event?.conferenceData?.createRequest?.status?.statusCode === "failure";
        if (!calendarMeetingLink(event) && !event?.conferenceData?.createRequest && !failed && budget.remaining > 0) {
          budget.remaining -= 1;
          event = await calendarUpdate(calendarId, action.eventId, action.task, incoming, accessToken, true);
          event = await resolveCalendarMeetingOnce(calendarId, event, accessToken, budget);
        }
        applyCalendarEvent(action.task, event);
        upserts.push(syncRow(action, event));
      }
    } catch (error) {
      console.error(`Calendar ${action.op} failed for task ${action.taskId}`, error);
      pending += 1;
    }
  }

  const now = new Date().toISOString();
  const writes = deletes
    .map((id) => env.DB.prepare("DELETE FROM calendar_sync WHERE user_email = ? AND task_id = ?").bind(session.email, id))
    .concat(upserts.map((item) => env.DB.prepare(`
      INSERT INTO calendar_sync (user_email, task_id, event_id, signature, meeting_status, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_email, task_id) DO UPDATE SET
        event_id = excluded.event_id, signature = excluded.signature,
        meeting_status = excluded.meeting_status, synced_at = excluded.synced_at
    `).bind(session.email, item.taskId, item.eventId, item.signature, item.meetingStatus, now)));
  if (writes.length) await env.DB.batch(writes);

  const merged = new Map(syncRows);
  for (const id of deletes) merged.delete(id);
  for (const item of upserts) merged.set(item.taskId, { eventId: item.eventId, signature: item.signature, meetingStatus: item.meetingStatus });
  const tasks = incoming.tasks.map((task) => {
    const row = merged.get(String(task.id));
    if (!task.due) { const { calendarEventId, ...rest } = task; return rest; }
    return row?.eventId ? { ...task, calendarEventId: row.eventId } : task;
  });
  return { tasks, pending };
}

function syncRow(action, event) {
  return {
    taskId: action.taskId,
    eventId: event.id || action.eventId,
    signature: calendarSignature(action.task),
    meetingStatus: action.task.meetingStatus || "",
  };
}

function calendarSignature(task) {
  return JSON.stringify([
    task.title,
    task.due,
    task.start,
    task.end,
    task.status,
    task.assignee,
    task.artistId,
    task.area,
    task.priority,
    task.meetingRequested === true,
    task.meetingRequestId || "",
    task.endEstimated === true,
  ]);
}

// Las marcas de la app son locales ("YYYY-MM-DDTHH:mm"); se envían con timeZone
// para que Google las interprete en la zona del usuario.
function calendarTiming(task, timeZone) {
  if (task.start) {
    const start = task.start.length === 16 ? `${task.start}:00` : task.start;
    const endStamp = task.end && task.end > task.start ? task.end : null;
    const end = endStamp
      ? (endStamp.length === 16 ? `${endStamp}:00` : endStamp)
      : new Date(new Date(`${start}Z`).getTime() + 60 * 60 * 1000).toISOString().slice(0, 19);
    return { start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone } };
  }
  const end = new Date(`${task.due}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: { date: task.due }, end: { date: end.toISOString().slice(0, 10) } };
}

function calendarBody(task, state, requestConference = false) {
  const project = (state.artists || []).find((item) => item.id === task.artistId)?.name || "Sin proyecto";
  const timeZone = state.timeZone || "America/Mexico_City";
  const timing = calendarTiming(task, timeZone);
  const body = {
    summary: task.meetingRequested ? task.title : `[ORI♡N LENTE] ${task.title}`,
    description: [
      `Proyecto: ${project}`,
      `Frente: ${task.area || "—"}`,
      `Responsable: ${task.assignee || "—"}`,
      task.endEstimated ? "Duración: estimada (1 hora)" : "",
      "Creado desde ORI♡N LENTE",
    ].filter(Boolean).join("\n"),
    ...timing,
    extendedProperties: { private: { orionTaskId: String(task.id) } },
  };
  if (requestConference) {
    body.conferenceData = {
      createRequest: {
        requestId: String(task.meetingRequestId || `orion-${task.id}`),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
  }
  return body;
}

async function calendarCreate(calendarId, task, state, accessToken) {
  const requestConference = task.meetingRequested === true && Boolean(task.start);
  const suffix = requestConference ? "?conferenceDataVersion=1" : "";
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events${suffix}`, {
    method: "POST",
    headers: googleHeaders(accessToken),
    body: JSON.stringify(calendarBody(task, state, requestConference)),
  });
  if (!response.ok) throw new Error(`Calendar create ${response.status}`);
  return response.json();
}

async function calendarUpdate(calendarId, eventId, task, state, accessToken, requestConference = false) {
  const suffix = requestConference ? "?conferenceDataVersion=1" : "";
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}${suffix}`, {
    method: "PATCH",
    headers: googleHeaders(accessToken),
    body: JSON.stringify(calendarBody(task, state, requestConference)),
  });
  if (response.status === 404 || response.status === 410) {
    return calendarCreate(calendarId, task, state, accessToken);
  }
  if (!response.ok) throw new Error(`Calendar update ${response.status}`);
  return response.json();
}

async function calendarGet(calendarId, eventId, accessToken) {
  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`Calendar get ${response.status}`);
  return response.json();
}

// Como máximo un reintento inmediato: si Google no resolvió el link de Meet en ese
// instante, queda "pending" y se reintenta en el siguiente guardado (no bloquea el
// presupuesto de subpeticiones esperando a que Google termine de crear la sala).
async function resolveCalendarMeetingOnce(calendarId, event, accessToken, budget) {
  if (calendarMeetingLink(event) || event?.conferenceData?.createRequest?.status?.statusCode === "failure") return event;
  if (!event?.conferenceData?.createRequest || budget.remaining <= 0) return event;
  await new Promise((resolve) => setTimeout(resolve, 700));
  budget.remaining -= 1;
  return calendarGet(calendarId, event.id, accessToken);
}

function applyCalendarEvent(task, event) {
  task.calendarEventId = event.id || task.calendarEventId;
  if (!task.meetingRequested) return;
  if (!task.start) {
    task.meetingStatus = "requested";
    return;
  }
  const link = calendarMeetingLink(event);
  if (link) {
    const links = (Array.isArray(task.links) ? task.links : []).filter((item) => !isGoogleMeetUrl(item?.url));
    task.links = [...links.slice(0, 19), { url: link, label: "Google Meet" }];
    task.meetingStatus = "ready";
    return;
  }
  task.meetingStatus = event?.conferenceData?.createRequest?.status?.statusCode === "failure" ? "failed" : "pending";
}

function calendarMeetingLink(event) {
  if (isGoogleMeetUrl(event?.hangoutLink)) return event.hangoutLink;
  return event?.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video" && isGoogleMeetUrl(entry.uri))?.uri || "";
}

function taskMeetingLink(task) {
  return (Array.isArray(task.links) ? task.links : []).find((link) => isGoogleMeetUrl(link?.url))?.url || "";
}

function isGoogleMeetUrl(value) {
  try { return new URL(String(value || "")).hostname === "meet.google.com"; }
  catch { return false; }
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
