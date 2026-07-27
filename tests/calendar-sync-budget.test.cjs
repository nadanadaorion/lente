const assert = require("node:assert/strict");
const fs = require("node:fs");

function makeFakeDB() {
  const rows = [];
  function run(sql, args) {
    if (sql.startsWith("DELETE FROM calendar_sync")) {
      const [email, taskId] = args;
      const index = rows.findIndex((row) => row.user_email === email && row.task_id === taskId);
      if (index >= 0) rows.splice(index, 1);
      return { meta: { changes: index >= 0 ? 1 : 0 } };
    }
    if (sql.startsWith("\n    INSERT INTO calendar_sync") || sql.includes("INSERT INTO calendar_sync")) {
      const [email, taskId, eventId, signature, meetingStatus, syncedAt] = args;
      const existing = rows.find((row) => row.user_email === email && row.task_id === taskId);
      if (existing) Object.assign(existing, { event_id: eventId, signature, meeting_status: meetingStatus, synced_at: syncedAt });
      else rows.push({ user_email: email, task_id: taskId, event_id: eventId, signature, meeting_status: meetingStatus, synced_at: syncedAt });
      return { meta: { changes: 1 } };
    }
    throw new Error(`fake db: unsupported statement: ${sql}`);
  }
  function all(sql, args) {
    if (sql.includes("FROM calendar_sync WHERE user_email")) {
      const [email] = args;
      return { results: rows.filter((row) => row.user_email === email).map((row) => ({ ...row })) };
    }
    throw new Error(`fake db: unsupported query: ${sql}`);
  }
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return { all: async () => all(sql, args), run: async () => run(sql, args) };
        },
      };
    },
    async batch(writes) {
      const results = [];
      for (const write of writes) results.push(await write.run());
      return results;
    },
  };
}

function task(id, due, overrides = {}) {
  return { id, title: `Tarea ${id}`, due, start: "", end: "", status: "todo", assignee: "", artistId: "", area: "Música", priority: "low", meetingRequested: false, meetingRequestId: "", links: [], ...overrides };
}

(async () => {
  const source = fs.readFileSync(require.resolve("../backend/src/index.js"), "utf8")
    + "\nexport { syncCalendar, encryptText };";
  const backend = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

  const secret = "test-encryption-secret";
  const encryptedRefreshToken = await backend.encryptText("refresh-token-value", secret);
  const session = { email: "user@example.com", encryptedRefreshToken };

  let created = 0;
  let deleted = 0;
  let failNextCreate = false;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const href = String(url);
    if (href.includes("oauth2.googleapis.com/token")) return { ok: true, json: async () => ({ access_token: "access-token" }) };
    if (href.includes("/events") && options.method === "POST") {
      created += 1;
      if (failNextCreate) { failNextCreate = false; return { ok: false, status: 500 }; }
      return { ok: true, json: async () => ({ id: `evt-${created}` }) };
    }
    if (href.includes("/events") && options.method === "DELETE") {
      deleted += 1;
      return { ok: true, status: 200 };
    }
    throw new Error(`unexpected fetch: ${options.method || "GET"} ${href}`);
  };

  try {
    // 1) Presupuesto agotado: de 8 tareas nuevas solo caben 4 subpeticiones de Calendar.
    const db = makeFakeDB();
    const envTight = { DB: db, CALENDAR_ID: "primary", CALENDAR_BUDGET: "5", TOKEN_ENCRYPTION_KEY: secret, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" };
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`, `2026-08-0${i + 1}`));
    const first = await backend.syncCalendar({ artists: [], tasks, timeZone: "" }, session, envTight);

    assert.equal(created, 4, "solo debe haber creado 4 eventos, no 8");
    assert.equal(first.pending, 4, "las 4 tareas restantes deben quedar pendientes");
    assert.equal(db.rows.length, 4, "solo las tareas procesadas quedan registradas en calendar_sync");
    assert.equal(first.tasks.filter((t) => t.calendarEventId).length, 4, "solo 4 tareas deben tener evento asignado");

    // 2) Continuación: el siguiente guardado no debe recrear los eventos ya sincronizados.
    created = 0;
    const envWide = { ...envTight, CALENDAR_BUDGET: "20" };
    const second = await backend.syncCalendar({ artists: [], tasks: first.tasks, timeZone: "" }, session, envWide);

    assert.equal(created, 4, "solo deben crearse los 4 eventos que faltaban, sin duplicar los ya sincronizados");
    assert.equal(second.pending, 0, "no debe quedar nada pendiente tras la continuación");
    assert.equal(db.rows.length, 8, "las 8 tareas deben terminar registradas en calendar_sync");
    assert.equal(second.tasks.every((t) => t.calendarEventId), true, "todas las tareas deben tener evento asignado");

    // 3) Quitar la fecha de una tarea sincronizada debe borrar su evento y su fila de seguimiento.
    deleted = 0;
    const withoutDue = second.tasks.map((t) => (t.id === "t0" ? { ...t, due: "" } : t));
    const third = await backend.syncCalendar({ artists: [], tasks: withoutDue, timeZone: "" }, session, envWide);
    assert.equal(deleted, 1, "debe borrar exactamente el evento de la tarea sin fecha");
    assert.equal(db.rows.some((row) => row.task_id === "t0"), false, "la fila de seguimiento debe eliminarse");
    assert.equal(third.tasks.find((t) => t.id === "t0").calendarEventId, undefined, "la tarea sin fecha no debe conservar calendarEventId");

    // 4) Un fallo real de Google no debe dejar una fila fantasma ni impedir el reintento posterior.
    created = 0;
    const dbFail = makeFakeDB();
    const envFail = { ...envTight, CALENDAR_BUDGET: "20" };
    failNextCreate = true;
    const failed = await backend.syncCalendar({ artists: [], tasks: [task("f1", "2026-09-01")], timeZone: "" }, session, dbFail && { ...envFail, DB: dbFail });
    assert.equal(failed.pending, 1, "el intento fallido debe quedar pendiente");
    assert.equal(dbFail.rows.length, 0, "no debe registrarse una fila para un evento que no llegó a crearse");

    const retried = await backend.syncCalendar({ artists: [], tasks: failed.tasks, timeZone: "" }, session, { ...envFail, DB: dbFail });
    assert.equal(retried.pending, 0, "el reintento debe completarse");
    assert.equal(created, 2, "debe haber exactamente dos intentos de creación: el fallido y el reintento");
    assert.equal(dbFail.rows.length, 1, "solo debe quedar una fila de seguimiento, sin duplicados");

    console.log("Calendar sync budget and continuation: ok");
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
