const assert = require("node:assert/strict");
const fs = require("node:fs");

require("../outputs/nlp-engine.js");

const NLP = global.OrionLenteNLP;
const activePhrase = "Crear llamada con Vabe sobre su nuevo EP a las 2 pm con duración de 2 horas";

const intentCases = [
  ["Reunión con Vabe hoy a las 2 pm de 1 hora", false],
  ["Tengo llamada con Vabe a las 2 pm", false],
  ["Agendar llamada con Vabe hoy a las 2 pm", true],
  ["Crear junta con Vabe hoy a las 2 pm", true],
  ["Programar meet con Vabe hoy a las 2 pm", true],
  ["Crear zoom con Vabe hoy a las 2 pm", true],
];

for (const [phrase, expected] of intentCases) {
  assert.equal(NLP.isMeetingRequest(phrase), expected, phrase);
}

assert.equal(NLP.isMeetingMention(intentCases[0][0]), true);
assert.equal(NLP.meetingParticipant(activePhrase), "Vabe");
assert.equal(NLP.meetingTitle(activePhrase), "VABE Nuevo EP");
assert.deepEqual(NLP.parseSchedule(activePhrase), {
  startMinutes: 14 * 60,
  endMinutes: 16 * 60,
  durationMinutes: 2 * 60,
  isNow: false,
});
assert.deepEqual(NLP.parseMeetingSchedule("Crear llamada con Vabe mañana a las 2 pm"), {
  startMinutes: 14 * 60,
  endMinutes: 15 * 60,
  durationMinutes: 60,
  isNow: false,
  endEstimated: true,
});
assert.deepEqual(NLP.parseMeetingSchedule("Reunión con Vabe mañana a las 2 pm"), {
  startMinutes: 14 * 60,
  endMinutes: null,
  durationMinutes: null,
  isNow: false,
  endEstimated: false,
});

(async () => {
  const source = fs.readFileSync(require.resolve("../backend/src/index.js"), "utf8")
    + "\nexport { calendarBody, calendarCreate, applyCalendarEvent };";
  const backend = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const state = {
    artists: [{ id: "vabe", name: "Vabe" }],
    timeZone: "America/Mexico_City",
  };
  const active = {
    id: "task-active",
    title: "VABE Nuevo EP",
    artistId: "vabe",
    area: "Management",
    assignee: "Vabe",
    due: "2026-07-26",
    start: "2026-07-26T14:00",
    end: "2026-07-26T16:00",
    meetingRequested: true,
    meetingRequestId: "meet-task-active",
    links: [],
  };
  const passive = {
    ...active,
    id: "task-passive",
    title: "Reunión",
    meetingRequested: false,
    meetingRequestId: "",
  };
  const estimated = {
    ...active,
    end: "2026-07-26T15:00",
    endEstimated: true,
  };

  const meetBody = backend.calendarBody(active, state, true);
  const passiveBody = backend.calendarBody(passive, state, false);
  const estimatedBody = backend.calendarBody(estimated, state, true);
  assert.equal(meetBody.summary, "VABE Nuevo EP");
  assert.equal(meetBody.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(passiveBody.summary, "[ORI♡N LENTE] Reunión");
  assert.equal(passiveBody.conferenceData, undefined);
  assert.match(estimatedBody.description, /Duración: estimada \(1 hora\)/);

  const originalFetch = global.fetch;
  let requestUrl = "";
  global.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        id: "calendar-event",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      }),
    };
  };
  try {
    const event = await backend.calendarCreate("primary", active, state, "token");
    backend.applyCalendarEvent(active, event);
  } finally {
    global.fetch = originalFetch;
  }

  assert.match(requestUrl, /\?conferenceDataVersion=1$/);
  assert.deepEqual(active.links, [{
    url: "https://meet.google.com/abc-defg-hij",
    label: "Google Meet",
  }]);
  assert.equal(active.meetingStatus, "ready");

  console.log("Meeting intent and Google Meet calendar flow: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
