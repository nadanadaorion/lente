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
        "letra", "letras", "lirica", "topline", "coro", "verso", "arreglo", "maqueta",
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

  function textVariants(text, dictionary) {
    const variants = [text];
    const seen = new Set([normalize(text)]);
    for (const entry of learnedEntries(dictionary, "term")) {
      if (aliasScore(text, entry.phrase) >= 0.72) {
        const key = normalize(entry.value);
        if (key && !seen.has(key)) {
          seen.add(key);
          variants.push(entry.value);
        }
      }
    }
    return variants;
  }

  function bestLearned(text, kind, dictionary) {
    let best = null;
    let score = 0;
    const variants = textVariants(text, dictionary);
    for (const entry of learnedEntries(dictionary, kind)) {
      for (const variant of variants) {
        const candidate = aliasScore(variant, entry.phrase);
        if (candidate > score) {
          score = candidate;
          best = entry;
        }
      }
    }
    return best && score >= 0.62 ? { value: best.value, score, source: "learned", entry: best } : null;
  }

  function bestBuiltin(text, groups, dictionary = []) {
    let result = null;
    const variants = textVariants(text, dictionary);
    for (const [value, aliases] of Object.entries(groups)) {
      for (const alias of aliases) {
        for (const variant of variants) {
          const score = aliasScore(variant, alias);
          if (!result || score > result.score) result = { value, score, source: "builtin", alias };
        }
      }
    }
    return result && result.score >= 0.68 ? result : null;
  }

  function detectIntent(text, dictionary = []) {
    const learned = bestLearned(text, "intent", dictionary);
    if (learned && learned.score >= 0.82) return learned;
    const builtin = bestBuiltin(text, BUILTINS.intent, dictionary);
    if (learned && (!builtin || learned.score >= builtin.score)) return learned;
    if (!builtin) return learned;
    const input = normalize(text);
    if (builtin.value === "create" && /\b(ya|quedo|quedaron|esta|estan|salio)\b/.test(input)) {
      const complete = Object.fromEntries([["complete", BUILTINS.intent.complete]]);
      const completion = bestBuiltin(text, complete, dictionary);
      if (completion) return completion;
    }
    return builtin;
  }

  function detectArea(text, dictionary = []) {
    const learned = bestLearned(text, "area", dictionary);
    if (learned && learned.score >= 0.78) return learned;
    const builtin = bestBuiltin(text, BUILTINS.area, dictionary);
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

  const NUMBER_WORDS = {
    un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
    nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40,
    "cuarenta y cinco": 45, sesenta: 60, noventa: 90,
  };

  function wordToNumber(value) {
    const clean = normalize(value);
    if (!clean) return null;
    if (/^\d+$/.test(clean)) return Number(clean);
    return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, clean) ? NUMBER_WORDS[clean] : null;
  }

  // "a las 3" sin meridiano: 1-7 se asume tarde, 8-12 se asume mañana.
  function applyMeridiem(hour, meridiem) {
    if (meridiem === "pm") return hour === 12 ? 12 : hour + 12;
    if (meridiem === "am") return hour === 12 ? 0 : hour;
    if (hour >= 1 && hour <= 7) return hour + 12;
    return hour;
  }

  function readMeridiem(value) {
    const clean = normalize(value);
    if (/^(pm|p m|de la tarde|de la noche)$/.test(clean)) return "pm";
    if (/^(am|a m|de la manana)$/.test(clean)) return "am";
    return null;
  }

  const CLOCK = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\s*m|p\\s*m|de\\s+la\\s+manana|de\\s+la\\s+tarde|de\\s+la\\s+noche)?";

  function clockToMinutes(hourText, minuteText, meridiemText) {
    const rawHour = Number(hourText);
    if (!Number.isFinite(rawHour) || rawHour > 23) return null;
    const minute = minuteText ? Number(minuteText) : 0;
    if (minute > 59) return null;
    return applyMeridiem(rawHour, readMeridiem(meridiemText || "")) * 60 + minute;
  }

  // Duración explícita: "de dos horas", "de media hora", "de 90 minutos".
  function parseDuration(text) {
    const input = normalize(text);
    if (/\bde\s+media\s+hora\b|\bmedia\s+hora\b/.test(input)) return 30;
    if (/\bde\s+un\s+cuarto\s+de\s+hora\b|\bcuarto\s+de\s+hora\b/.test(input)) return 15;
    if (/\bhora\s+y\s+media\b/.test(input)) return 90;
    let match = input.match(/\b(?:de\s+|dura(?:cion)?\s+(?:de\s+)?)?(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s*(?:horas?|hrs?|h)\b/);
    if (match) {
      const hours = wordToNumber(match[1]);
      if (hours) return hours * 60;
    }
    match = input.match(/\b(?:de\s+|dura(?:cion)?\s+(?:de\s+)?)?(\d+|quince|veinte|treinta|cuarenta|sesenta|noventa)\s*(?:minutos?|mins?|min)\b/);
    if (match) {
      const minutes = wordToNumber(match[1]);
      if (minutes) return minutes;
    }
    return null;
  }

  function mentionsNow(text) {
    return /\b(en\s+este\s+momento|ahora\s+mismo|ahorita|justo\s+ahora|empezando\s+ya|arrancando\s+ya)\b/.test(normalize(text));
  }

  // Estado explícito pedido en la frase: "en espera de…", "en este momento…".
  function detectStatusHint(text, dictionary = []) {
    const input = normalize(text);
    if (/\b(en\s+espera\s+de|a\s+la\s+espera\s+de|esperando|pendiente\s+de\s+(?:respuesta|confirmacion|aprobacion|que)|bloqueado\s+por|detenido\s+por|trabado\s+por)\b/.test(input)) {
      return { value: "waiting", source: "builtin" };
    }
    if (mentionsNow(text) || /\b(estoy\s+en|arrancando|empezando|ya\s+empece|ya\s+arranque|en\s+curso)\b/.test(input)) {
      return { value: "doing", source: "builtin" };
    }
    const learned = bestLearned(text, "status", dictionary);
    return learned ? { value: learned.value, source: "learned" } : null;
  }

  // Devuelve minutos desde medianoche para inicio/fin, y duración cuando se declara.
  function parseSchedule(text) {
    const input = normalize(text);
    const duration = parseDuration(input);

    const range = input.match(new RegExp(`\\b(?:de|desde)\\s+${CLOCK}\\s+(?:a|hasta)\\s+(?:las\\s+)?${CLOCK}`));
    if (range) {
      const start = clockToMinutes(range[1], range[2], range[3]);
      let end = clockToMinutes(range[4], range[5], range[6]);
      // "de 4 a 6" sin meridiano: el fin hereda la franja del inicio.
      if (start !== null && end !== null && !range[6] && end < start) end += 12 * 60;
      if (start !== null && end !== null && end > start) {
        return { startMinutes: start, endMinutes: end, durationMinutes: end - start, isNow: false };
      }
    }

    const at = input.match(new RegExp(`\\ba\\s+las?\\s+${CLOCK}`)) || input.match(new RegExp(`(?:^|\\s)${CLOCK}(?=\\s|$)`));
    if (at && /\b(?:a\s+las?\s+\d|\d\s*(?::\d{2}|am|pm|hrs))/.test(input)) {
      const start = clockToMinutes(at[1], at[2], at[3]);
      if (start !== null) {
        return {
          startMinutes: start,
          endMinutes: duration ? start + duration : null,
          durationMinutes: duration,
          isNow: false,
        };
      }
    }

    if (mentionsNow(input)) {
      return { startMinutes: null, endMinutes: null, durationMinutes: duration, isNow: true };
    }
    return duration ? { startMinutes: null, endMinutes: null, durationMinutes: duration, isNow: false } : null;
  }

  // Fragmentos que describen cuándo/para quién ocurre algo: se muestran en la
  // tarjeta como campos propios, así que sobran dentro del título.
  const SUMMARY_STRIPPERS = [
    // Encabezados de estado.
    /^(?:ya\s+)?(?:estoy\s+en|en)\s+espera\s+de\s+(?:la|el|los|las|una?|un)?\s*/i,
    /^a\s+la\s+espera\s+de\s+(?:la|el|los|las|una?|un)?\s*/i,
    /^esperando\s+(?:la|el|los|las|una?|un|a|por)?\s*/i,
    /^pendiente\s+de\s+(?:la|el|los|las|una?|un)?\s*/i,
    // Horas, duraciones y momentos.
    /\b(?:de|desde)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s+(?:a|hasta)\s+(?:las\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?/gi,
    /\ba\s+las?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm|hrs?|horas?)?(?:\s+de\s+la\s+(?:mañana|tarde|noche))?/gi,
    /\b\d{1,2}:\d{2}\s*(?:am|pm)?/gi,
    /\b\d{1,2}\s*(?:am|pm)\b/gi,
    /\bde\s+(?:media\s+hora|un\s+cuarto\s+de\s+hora|hora\s+y\s+media)\b/gi,
    /\bde\s+(?:\d+|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)\s*(?:horas?|hrs?)\b/gi,
    /\bde\s+(?:\d+|quince|veinte|treinta|cuarenta|sesenta|noventa)\s*(?:minutos?|mins?)\b/gi,
    /\b(?:en\s+este\s+momento|ahora\s+mismo|ahorita|justo\s+ahora|en\s+curso)\b/gi,
    // Muletillas de encargo.
    /^(?:tengo(?:\s+que)?|hay\s+que|necesito(?:\s+que)?|debo|tenemos\s+que|quiero|vamos\s+a|me\s+toca)\s+/i,
    /\bpor\s+favor\b/gi,
  ];

  // Artículo + sustantivo genérico que no aporta ("un archivo de letra" → "archivo de letra").
  const LEADING_ARTICLE = /^(?:el|la|los|las|un|una|unos|unas)\s+/i;
  // Verbo de encargo al inicio: se elimina porque toda tarjeta ya es un pendiente.
  const LEADING_VERB = /^(?:crear|hacer|realizar|armar|preparar|generar|elaborar|producir|montar|redactar|escribir|enviar|mandar|revisar|editar|grabar|disenar|diseñar|gestionar|organizar|agendar|coordinar|subir|entregar|definir|terminar|cerrar)\s+/i;
  // "el single «X»" → «X»: el tipo de release es ruido cuando el nombre va entrecomillado.
  const RELEASE_NOUN = /\b(?:el\s+|la\s+|los\s+|las\s+|un\s+|una\s+)?(?:single|sencillo|track|tema|album|álbum|ep|disco|video|videoclip)\s+(?=[«"“][^»"”]+[»"”])/gi;
  // Cola que queda colgando al quitar el artista: "…video para el single [de Roxo]".
  const DANGLING_RELEASE = /\s+\b(?:de|del|para|en)\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:proximo|próximo|nuevo|siguiente)?\s*(?:single|sencillo|track|tema|album|álbum|ep|disco)\s*$/i;
  // Preposición huérfana al final: "…portada de", "…mezcla para".
  const DANGLING_PREPOSITION = /\s+(?:de|del|para|con|en|a|por|sobre)\s*$/i;

  function tidy(value) {
    return String(value || "")
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/^[\s,.;:·\-–—]+|[\s,.;:·\-–—]+$/g, "")
      .trim();
  }

  /**
   * Reescribe una frase a un título corto y legible: quita fechas, horas,
   * artista, responsable y muletillas, y deja una frase nominal coherente.
   */
  function summarize(text, options = {}) {
    const names = (options.names || []).filter(Boolean);
    const assignee = options.assignee || "";
    const stripDates = options.stripDates;
    let value = String(text || "").trim();
    if (!value) return "";

    if (typeof stripDates === "function") value = stripDates(value);

    for (const rule of SUMMARY_STRIPPERS) value = value.replace(rule, " ");

    // El artista y el responsable ya se muestran en la tarjeta.
    for (const name of [...names, assignee]) {
      if (!name) continue;
      const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      value = value.replace(new RegExp(`\\s*\\b(?:de|para|con|del)\\s+${escaped}\\b`, "gi"), " ");
      value = value.replace(new RegExp(`\\s*\\b${escaped}\\b\\s*$`, "gi"), " ");
    }

    value = value.replace(RELEASE_NOUN, "");
    value = tidy(value);
    value = value.replace(LEADING_VERB, "");
    value = tidy(value);
    value = value.replace(LEADING_ARTICLE, "");
    value = tidy(value);
    // Se aplican al final y en bucle: quitar una cola puede destapar la siguiente.
    for (let pass = 0; pass < 3; pass += 1) {
      const before = value;
      value = tidy(value.replace(DANGLING_RELEASE, ""));
      value = tidy(value.replace(DANGLING_PREPOSITION, ""));
      if (value === before) break;
    }

    // Corta en el límite natural más cercano si quedó largo.
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length > 10) value = tidy(words.slice(0, 10).join(" ")) + "…";

    if (!value) return "";
    return value[0].toLocaleUpperCase("es") + value.slice(1);
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
    detectStatusHint,
    parseSchedule,
    parseDuration,
    summarize,
    confidence,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
