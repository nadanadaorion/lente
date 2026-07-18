(function (root) {
  "use strict";

  const STOP_WORDS = new Set([
    "a", "al", "algo", "ante", "antes", "con", "contra", "cual", "cuando", "de", "del", "desde", "donde",
    "el", "ella", "en", "entre", "esa", "ese", "esta", "este", "esto", "la", "las", "le", "les", "lo",
    "los", "me", "mi", "mis", "nos", "o", "para", "pero", "por", "que", "se", "sin", "su", "sus", "te",
    "tu", "tus", "un", "una", "uno", "unos", "unas", "y", "ya",
  ]);

  const DATE_WORDS = new Set([
    "hoy", "manana", "pasado", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
    "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
    "noviembre", "diciembre", "semana", "semanas", "mes", "meses", "proximo", "siguiente",
  ]);

  const IRREGULAR = new Map(Object.entries({
    hecho: "hac", hecha: "hac", hechos: "hac", hechas: "hac", hice: "hac", hizo: "hac", hicimos: "hac",
    hicieron: "hac", hago: "hac", hacen: "hac", haga: "hac", hagan: "hac", listo: "list", lista: "list",
    listos: "list", listas: "list", mueve: "mov", muevo: "mov", mueven: "mov", movemos: "mov",
    movia: "mov", movian: "mov", fue: "ser", fueron: "ser", sera: "ser", seria: "ser", esta: "est",
    estuvo: "est", queda: "qued", quedo: "qued", quedara: "qued", salio: "sal", sale: "sal",
  }));

  const BUILTINS = {
    intent: {
      complete: [
        "terminar", "acabar", "completar", "finalizar", "cerrar", "entregar", "resolver", "concluir",
        "liquidar", "despachar", "quedar listo", "estar hecho", "ya quedo", "ya salio", "dar por terminado",
      ],
      move: [
        "mover", "cambiar de fecha", "posponer", "aplazar", "recorrer", "reprogramar", "reagendar",
        "pasar para", "dejar para", "se va al", "ahora sera", "ahora es",
      ],
      create: [
        "crear", "hacer", "preparar", "armar", "necesitar", "tener que", "hay que", "deber", "gestionar",
        "encargar", "organizar", "producir",
      ],
    },
    area: {
      "Música": [
        "musica", "mezclar", "mezcla", "master", "masterizar", "grabar", "grabacion", "sesion", "demo",
        "cancion", "track", "vocal", "voces", "tirar voces", "beat", "estudio", "ensayo", "producir",
        "produccion musical", "componer", "composicion", "afinar", "bounce", "stem", "instrumental",
      ],
      "Diseño": [
        "diseno", "disenar", "portada", "arte", "artwork", "poster", "afiche", "logo", "foto", "fotografia",
        "visualizer", "story", "historia", "identidad", "tipografia", "miniatura", "thumbnail", "flyer",
      ],
      "Video": [
        "video", "rodaje", "filmar", "grabar video", "editar video", "edicion de video", "teaser", "reel",
        "tiktok", "animacion", "clip", "videoclip", "corte", "colorizar", "subtitulos", "render de video",
      ],
      "Management": [
        "management", "contrato", "reunion", "junta", "presupuesto", "booking", "prensa", "sello", "factura",
        "pago", "estrategia", "lanzamiento", "distribucion", "correo", "mail", "cotizacion", "agenda",
        "campana", "marketing", "planificacion", "llamada", "tramite",
      ],
    },
  };

  function normalize(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[’']/g, " ")
      .replace(/[^a-z0-9ñ\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stem(value) {
    let word = normalize(value);
    if (!word) return "";
    if (IRREGULAR.has(word)) return IRREGULAR.get(word);
    if (word.length > 7) word = word.replace(/(?:melo|mela|melos|melas|selo|sela|selos|selas|nos|les|lo|la|los|las|me|te|se)$/u, "");
    if (IRREGULAR.has(word)) return IRREGULAR.get(word);
    if (word.endsWith("uciones")) word = word.slice(0, -7) + "ucion";
    else if (word.endsWith("iciones")) word = word.slice(0, -7) + "icion";
    else if (word.endsWith("aciones")) word = word.slice(0, -7) + "acion";
    else if (word.endsWith("ciones")) word = word.slice(0, -6) + "cion";
    else if (word.endsWith("ces") && word.length > 5) word = word.slice(0, -3) + "z";

    const suffixes = [
      "ariamos", "eriamos", "iriamos", "aremos", "eremos", "iremos", "aseis", "ieseis", "abamos", "iamos",
      "arian", "erian", "irian", "arias", "erias", "irias", "ando", "iendo", "yendo", "ados", "idas", "idos",
      "aron", "ieron", "aran", "eran", "iran", "ases", "ieses", "aste", "iste", "aba", "aban", "abas",
      "ada", "ado", "ida", "ido", "aria", "eria", "iria", "amos", "emos", "imos", "ais", "eis",
      "ando", "endo", "ar", "er", "ir", "an", "en", "as", "es", "a", "e", "o",
    ];
    for (const suffix of suffixes) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
        word = word.slice(0, -suffix.length);
        break;
      }
    }
    if (word.length > 5 && /[os]$/.test(word)) word = word.slice(0, -1);
    if (word.length > 5 && /[a]$/.test(word)) word = word.slice(0, -1);
    return IRREGULAR.get(word) || word;
  }

  function rawTokens(text) {
    return normalize(text).split(" ").filter(Boolean);
  }

  const ACTION_STEMS = new Set(
    Object.values(BUILTINS.intent).flat().flatMap((phrase) => rawTokens(phrase).map(stem))
  );

  function learnedEntries(dictionary, kind) {
    return (Array.isArray(dictionary) ? dictionary : []).filter((entry) => entry && entry.kind === kind && entry.phrase && entry.value);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function tokens(text, options = {}) {
    const dictionary = options.dictionary || [];
    const result = rawTokens(text)
      .filter((word) => !STOP_WORDS.has(word) && !DATE_WORDS.has(word) && !/^\d+$/.test(word))
      .map(stem)
      .filter((word) => word.length > 1);

    for (const entry of learnedEntries(dictionary, "term")) {
      if (aliasScore(text, entry.phrase) >= 0.72) {
        result.push(...rawTokens(entry.value).map(stem));
      }
    }
    return unique(options.forMatch ? result.filter((word) => !ACTION_STEMS.has(word)) : result);
  }

  function setScore(a, b) {
    const left = new Set(a);
    const right = new Set(b);
    if (!left.size || !right.size) return 0;
    const shared = [...left].filter((word) => right.has(word)).length;
    const containment = shared / Math.min(left.size, right.size);
    const union = new Set([...left, ...right]).size;
    return containment * 0.72 + (shared / union) * 0.28;
  }

  function trigrams(value) {
    const text = `  ${normalize(value)}  `;
    const grams = [];
    for (let i = 0; i < text.length - 2; i += 1) grams.push(text.slice(i, i + 3));
    return grams;
  }

  function dice(a, b) {
    const left = trigrams(a);
    const right = trigrams(b);
    if (!left.length || !right.length) return 0;
    const counts = new Map();
    left.forEach((gram) => counts.set(gram, (counts.get(gram) || 0) + 1));
    let shared = 0;
    right.forEach((gram) => {
      const count = counts.get(gram) || 0;
      if (!count) return;
      shared += 1;
      counts.set(gram, count - 1);
    });
    return (2 * shared) / (left.length + right.length);
  }

  function aliasScore(text, alias) {
    const input = normalize(text);
    const phrase = normalize(alias);
    if (!input || !phrase) return 0;
    if (input === phrase) return 1;
    if (` ${input} `.includes(` ${phrase} `)) return Math.min(0.99, 0.88 + Math.min(0.1, phrase.length / 100));
    const meaningful = (value) => rawTokens(value).filter((word) => !STOP_WORDS.has(word) && !DATE_WORDS.has(word)).map(stem);
    const wordScore = setScore(meaningful(input), meaningful(phrase));
    return wordScore * 0.82 + dice(input, phrase) * 0.18;
  }

  function bestLearned(text, kind, dictionary) {
    let best = null;
    let score = 0;
    for (const entry of learnedEntries(dictionary, kind)) {
      const candidate = aliasScore(text, entry.phrase);
      if (candidate > score) {
        score = candidate;
        best = entry;
      }
    }
    return best && score >= 0.62 ? { value: best.value, score, source: "learned", entry: best } : null;
  }

  function bestBuiltin(text, groups) {
    let result = null;
    for (const [value, aliases] of Object.entries(groups)) {
      for (const alias of aliases) {
        const score = aliasScore(text, alias);
        if (!result || score > result.score) result = { value, score, source: "builtin", alias };
      }
    }
    return result && result.score >= 0.68 ? result : null;
  }

  function detectIntent(text, dictionary = []) {
    const learned = bestLearned(text, "intent", dictionary);
    if (learned && learned.score >= 0.82) return learned;
    const builtin = bestBuiltin(text, BUILTINS.intent);
    if (learned && (!builtin || learned.score >= builtin.score)) return learned;
    if (!builtin) return learned;
    const input = normalize(text);
    if (builtin.value === "create" && /\b(ya|quedo|quedaron|esta|estan|salio)\b/.test(input)) {
      const complete = Object.fromEntries([["complete", BUILTINS.intent.complete]]);
      const completion = bestBuiltin(text, complete);
      if (completion) return completion;
    }
    return builtin;
  }

  function detectArea(text, dictionary = []) {
    const learned = bestLearned(text, "area", dictionary);
    if (learned && learned.score >= 0.78) return learned;
    const builtin = bestBuiltin(text, BUILTINS.area);
    if (learned && (!builtin || learned.score >= builtin.score)) return learned;
    return builtin;
  }

  function detectProject(text, dictionary = []) {
    return bestLearned(text, "project", dictionary);
  }

  function similarity(a, b, dictionary = []) {
    const left = tokens(a, { dictionary, forMatch: true });
    const right = tokens(b, { dictionary, forMatch: true });
    if (!left.length || !right.length) return dice(a, b) * 0.55;
    const wordScore = setScore(left, right);
    const normalizedA = normalize(a);
    const normalizedB = normalize(b);
    const contained = normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA) ? 0.12 : 0;
    return Math.min(1, wordScore * 0.8 + dice(a, b) * 0.2 + contained);
  }

  function confidence(score) {
    if (score >= 0.78) return "high";
    if (score >= 0.5) return "medium";
    return "low";
  }

  root.OrionLenteNLP = {
    BUILTINS,
    normalize,
    stem,
    tokens,
    aliasScore,
    similarity,
    detectIntent,
    detectArea,
    detectProject,
    confidence,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
