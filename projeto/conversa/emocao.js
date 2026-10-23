"use strict";
// Detecta a emoção de uma frase em português por palavras-chave (roda no navegador, sem internet).
// analisar("hoje eu tô muito triste") -> { emocao: "triste", intensidade: 0.9, palavras: ["triste"] }
// Emoções: neutro, feliz, triste, surpreso, pensativo, preocupado.

(function (raiz) {
  // Radicais: casam com o começo da palavra ("chor" pega chorar, chorei, chorando).
  // Palavras com "=" na frente só casam inteiras ("=rs" não pega "rsrs" nem "orsa").
  const LEXICO = {
    triste: [
      "triste", "trist", "chor", "lagrima", "morre", "morri", "morte", "mort", "falec", "luto", "enterro",
      "saudade", "sozinh", "solida", "deprimi", "depress", "perdi", "perder", "perda", "doent", "doenc",
      "hospital", "cancer", "=dor", "=dores", "doi", "doendo", "sofr", "infeliz", "chatead", "desanim",
      "magoad", "magoou", "decepc", "=pena", "coitad", "abandon", "termine", "terminou", "separ", "divorc",
      "demiti", "demitid", "desempreg", "reprov", "fracass", "pessim", "horrivel", "=ruim", "=mal",
      "cansad", "exaust", "desist", "vazio", "falta", "arrepend", "culpa", "sofrimento", "brig", "=dificil",
      "dificuldade", "problema",
    ],
    feliz: [
      "feliz", "felic", "alegr", "content", "otim", "maravilh", "incrivel", "legal", "=bom", "=boa",
      "=bem", "gost", "ador", "=amo", "amei", "amor", "paixao", "lind", "parab", "consegu", "passei",
      "aprovad", "ganhei", "ganh", "venci", "vitoria", "festa", "ferias", "sorri", "=rir", "risad",
      "=haha", "hahah", "=hehe", "=kkk", "kkkk", "=rs", "=rsrs", "=show", "=top", "massa", "perfeit",
      "sucesso", "orgulh", "grat", "obrigad", "valeu", "divert", "engracad", "animad", "empolgad",
      "sonho", "realizad", "nasceu", "casamento", "casei", "namorad", "noiv", "aniversari", "presente",
      "excelente", "bacana", "fantastic", "sensacional", "uhu", "oba", "eba", "=oi", "=ola", "bom dia",
      "boa tarde", "boa noite", "prazer",
    ],
    surpreso: [
      "nossa", "=uau", "=uou", "=wow", "caramba", "=serio", "=jura", "inacredit", "nao acredito",
      "surpre", "chocad", "choque", "impression", "=mentira", "=eita", "=oxe", "=meu deus", "=nossa senhora",
      "do nada", "de repente", "acredita",
    ],
    preocupado: [
      "medo", "assust", "preocup", "ansios", "ansiedade", "nervos", "panico", "=tenso", "tensa", "receio",
      "perigo", "apavor", "estress", "raiva", "odio", "odeio", "irritad", "=brav", "furios", "injust",
      "absurdo", "droga", "merda", "porra", "=saco", "=chato", "chata", "revolt", "inseguro", "insegura",
      "urgente", "acidente", "assalt", "roubad", "roubaram", "violencia", "prova", "=enem",
      "vestibular", "entrevista",
    ],
  };
  const NEGACOES = new Set(["nao", "nem", "nunca", "jamais", "nada", "ninguem", "sem"]);
  const INTENSIFICADORES = new Set(["muito", "muita", "demais", "super", "tao", "bastante", "mega",
                                    "extremamente", "totalmente", "realmente"]);
  const INTERROGATIVOS = ["o que", "que", "como", "por que", "porque", "qual", "quais", "quem", "quando",
                          "onde", "sera", "voce acha", "voce sabe", "voce gosta", "voce pode", "voce e",
                          "me explica", "me diz", "me conta", "quantos", "quanto"];

  function normalizar(texto) {
    return String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9?! ]+/g, " ").replace(/\s+/g, " ").trim();
  }

  // Prepara as entradas: frases (com espaço) e palavras (exatas ou por radical).
  const ENTRADAS = [];
  for (const [emocao, lista] of Object.entries(LEXICO)) {
    for (let item of lista) {
      const exata = item.startsWith("=");
      if (exata) item = item.slice(1);
      ENTRADAS.push({ emocao, termo: item, exata, frase: item.includes(" ") });
    }
  }

  function negadoAntes(tokens, i) {
    for (let k = Math.max(0, i - 3); k < i; k++) if (NEGACOES.has(tokens[k])) return true;
    return false;
  }

  function intensificadoPerto(tokens, i) {
    for (let k = Math.max(0, i - 2); k <= Math.min(tokens.length - 1, i + 1); k++) {
      if (k !== i && INTENSIFICADORES.has(tokens[k])) return true;
    }
    return false;
  }

  function analisar(texto) {
    const norm = normalizar(texto);
    const tokens = norm.replace(/[?!]/g, " ").split(" ").filter(Boolean);
    const pontos = { feliz: 0, triste: 0, surpreso: 0, preocupado: 0 };
    const palavras = [];
    let reforco = 0;

    const marcar = (emocao, i, termo) => {
      let alvo = emocao;
      let peso = 1;
      if (i >= 0 && negadoAntes(tokens, i)) {
        // "não estou feliz" -> triste; "não estou triste" / "não tenho medo" -> alívio leve
        if (emocao === "feliz") { alvo = "triste"; peso = 0.8; }
        else if (emocao === "triste" || emocao === "preocupado") { alvo = "feliz"; peso = 0.4; }
        else return;
      }
      if (i >= 0 && intensificadoPerto(tokens, i)) { peso *= 1.5; reforco++; }
      pontos[alvo] += peso;
      palavras.push(termo);
    };

    const usados = new Set();
    for (const e of ENTRADAS) {
      if (e.frase) {
        const pos = (" " + tokens.join(" ") + " ").indexOf(" " + e.termo + " ");
        if (pos >= 0) {
          const i = tokens.join(" ").slice(0, pos).split(" ").filter(Boolean).length;
          marcar(e.emocao, i, e.termo);
          e.termo.split(" ").forEach((_, k) => usados.add(i + k));
        }
      }
    }
    tokens.forEach((tok, i) => {
      if (usados.has(i)) return;
      for (const e of ENTRADAS) {
        if (e.frase) continue;
        const casa = e.exata ? tok === e.termo : (tok.startsWith(e.termo) && (e.termo.length >= 4 || tok === e.termo));
        if (casa) { marcar(e.emocao, i, e.termo); break; }
      }
    });
    if (/!/.test(norm)) reforco++;

    let melhor = "neutro", maior = 0;
    for (const [emocao, p] of Object.entries(pontos)) {
      if (p > maior) { maior = p; melhor = emocao; }
    }
    // Empate entre feliz e triste ("estou feliz mas com saudade"): fica com a última dita.
    if (pontos.feliz > 0 && pontos.feliz === pontos.triste) {
      const ultima = palavras[palavras.length - 1];
      melhor = LEXICO.triste.some((t) => t.replace("=", "") === ultima) ? "triste" : "feliz";
    }

    if (melhor === "neutro") {
      const pergunta = /\?/.test(norm) ||
        INTERROGATIVOS.some((q) => norm === q || norm.startsWith(q + " "));
      if (pergunta) return { emocao: "pensativo", intensidade: 0.6, palavras: [] };
      return { emocao: "neutro", intensidade: 0, palavras: [] };
    }
    const intensidade = Math.min(1, 0.45 + 0.2 * maior + 0.1 * reforco);
    return { emocao: melhor, intensidade: Math.round(intensidade * 100) / 100, palavras };
  }

  const api = { analisar, normalizar };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.Emocao = api;
})(typeof window !== "undefined" ? window : globalThis);
