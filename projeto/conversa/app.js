"use strict";
// Página do cliente no modo ator: tela cheia com o rosto do robô.
// Envia a câmera e o microfone ao ator, toca a voz do "robô" movendo a boca, entende o que a
// pessoa fala (reconhecimento de voz do Chrome/Edge) e muda a expressão do rosto conforme a emoção.
// Reconecta sozinha; nenhuma mensagem na tela revela que há uma pessoa do outro lado.

const $ = (id) => document.getElementById(id);
const rosto = new Rosto($("rosto"));
const params = new URLSearchParams(location.search);
const demoFala = params.has("demo") && params.has("falando");

let ws = null, pc = null, canal = null, iceServers = [];
let fila = Promise.resolve();
let midia = null;                    // câmera + microfone
let comecou = false;                 // clicou em Começar
let emConversa = false;              // o servidor aceitou e há (ou haverá) WebRTC
let atorOnline = false;
let tentativasWs = 0, timerWs = null, timerKeepalive = null, timerPedir = null;
let autoEmocao = true;               // o ator pode desligar
let manualAte = 0;                   // até quando a expressão escolhida pelo ator manda
let timerVoltaNeutro = null;
let robotFalouEm = 0, clienteFalouEm = 0;
let nivelRobo = null, nivelMic = null;   // analisadores de áudio
const ctxAudio = new (window.AudioContext || window.webkitAudioContext)();

// ---------------------------------------------------------------- utilidades
function enviar(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function enviarCanal(obj) { if (canal && canal.readyState === "open") canal.send(JSON.stringify(obj)); }

function ck(id, texto, classe) { const e = $(id); e.textContent = texto; e.className = "ck " + (classe || ""); }
function ponto(classe) { $("ponto").className = "ponto " + classe; }
function diag(id, texto) { $(id).textContent = texto; }
function aviso(texto) { $("avisoPreparo").textContent = texto || ""; }

function analisador(fluxo) {
  const a = ctxAudio.createAnalyser();
  a.fftSize = 512;
  ctxAudio.createMediaStreamSource(fluxo).connect(a);
  return { a, buf: new Uint8Array(a.fftSize) };
}
function rms(m) {
  if (!m) return 0;
  m.a.getByteTimeDomainData(m.buf);
  let s = 0;
  for (const v of m.buf) { const x = (v - 128) / 128; s += x * x; }
  return Math.sqrt(s / m.buf.length);
}

// ---------------------------------------------------------------- expressões
function aplicarExpressao(nome, intensidade, origem) {
  rosto.expressao(nome, intensidade);
  diag("dExpressao", `${nome} ${Math.round(intensidade * 100)}% (${origem})`);
  enviarCanal({ t: "rosto", nome, intensidade, origem });
  clearTimeout(timerVoltaNeutro);
  if (nome !== "neutro" && origem !== "fixa") {
    // a emoção se desfaz devagar, como num rosto de verdade
    timerVoltaNeutro = setTimeout(() => aplicarExpressao("neutro", 0, "tempo"), 6000 + intensidade * 5000);
  }
}

function reagirAFrase(texto, final) {
  const r = Emocao.analisar(texto);
  if (!autoEmocao || performance.now() < manualAte) return r;
  if (r.emocao === "neutro") return r;
  if (!final && (r.emocao === "pensativo" || r.intensidade < 0.6)) return r;  // parcial: só emoção clara
  let nome = r.emocao;
  if (nome === "feliz" && r.palavras.some((p) => /^(kkk|kkkk|haha|hahah|hehe|rs|rsrs|risad)/.test(p))) nome = "rindo";
  aplicarExpressao(nome, r.intensidade, "fala");
  return r;
}

// ---------------------------------------------------------------- câmera e microfone
const ERROS_MIDIA = {
  NotAllowedError: "Permissão negada. Clique no cadeado da barra de endereço e libere câmera e microfone.",
  NotFoundError: "Câmera ou microfone não encontrado.",
  NotReadableError: "A câmera ou o microfone está em uso por outro programa (feche Teams, Zoom etc.).",
  OverconstrainedError: "A câmera não aceitou a configuração pedida.",
  SecurityError: "O navegador bloqueou a câmera nesta página.",
};

// Microfone para voz: cancelamento de eco, supressão de ruído e ganho automático do navegador,
// mono a 48 kHz (o que o Opus usa). Sem "voiceIsolation": somado à limpeza do lado do ator, ela
// deixava a voz abafada e robótica.
const VOZ = {
  echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
};

async function ligarMidia() {
  if (midia) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    ck("ckCamera", "precisa de HTTPS", "ruim");
    ck("ckMic", "precisa de HTTPS", "ruim");
    aviso("O navegador só libera câmera e microfone em HTTPS. Abra o link https:// que o iniciar.bat mostrou.");
    return false;
  }
  try {
    midia = await navigator.mediaDevices.getUserMedia({
      // 640x480 a 15 quadros: basta para o ator ver a pessoa e deixa a rede livre para o áudio
      video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 20 }, facingMode: "user" },
      audio: VOZ,
    });
  } catch (e) {
    // sem câmera, tenta ao menos o microfone (e vice-versa)
    try {
      midia = await navigator.mediaDevices.getUserMedia({ audio: VOZ });
      ck("ckCamera", ERROS_MIDIA[e.name] ? "falhou" : e.name, "ruim");
      aviso(ERROS_MIDIA[e.name] || "Não consegui abrir a câmera (" + e.name + ").");
    } catch (e2) {
      ck("ckCamera", "falhou", "ruim");
      ck("ckMic", "falhou", "ruim");
      aviso(ERROS_MIDIA[e2.name] || "Não consegui abrir câmera nem microfone (" + e2.name + ").");
      midia = null;
      return false;
    }
  }
  const v = midia.getVideoTracks()[0], a = midia.getAudioTracks()[0];
  if (v) {
    const cfg = v.getSettings();
    ck("ckCamera", `ok ${cfg.width || "?"}x${cfg.height || "?"}`, "ok");
    $("previa").srcObject = midia;
    $("semPrevia").classList.add("oculto");
    v.onended = () => { ck("ckCamera", "desconectada", "ruim"); ponto("ruim"); };
  }
  if (a) {
    try { a.contentHint = "speech"; } catch (_) {}   // codificador otimizado para fala
    ck("ckMic", "ok", "ok");
    nivelMic = analisador(new MediaStream([a]));
    a.onended = () => { ck("ckMic", "desconectado", "ruim"); ponto("ruim"); };
  }
  return true;
}

// ---------------------------------------------------------------- reconhecimento de fala
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, falaAtiva = false, falaBloqueada = false, ultimoParcial = 0, errosSeguidos = 0;

function iniciarFala() {
  if (!SR) {
    ck("ckFala", "indisponível (use Chrome ou Edge)", "ruim");
    diag("dFala", "indisponível neste navegador");
    return;
  }
  if (rec) return;
  rec = new SR();
  rec.lang = "pt-BR";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.onstart = () => { ck("ckFala", "ok", "ok"); diag("dFala", "ouvindo"); enviarCanal({ t: "estadoFala", estado: "ativo" }); };
  rec.onresult = (ev) => {
    errosSeguidos = 0;
    let parcial = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      const texto = r[0].transcript.trim();
      if (!texto) continue;
      if (r.isFinal) tratarFrase(texto);
      else parcial += texto + " ";
    }
    parcial = parcial.trim();
    if (parcial && performance.now() - ultimoParcial > 250) {
      ultimoParcial = performance.now();
      diag("dTexto", parcial + " …");
      enviarCanal({ t: "fala", texto: parcial, final: false, sobreposta: roboFalandoAgora() });
      reagirAFrase(parcial, false);
    }
  };
  rec.onerror = (ev) => {
    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      falaBloqueada = true;
      ck("ckFala", "bloqueado pelo navegador", "ruim");
    } else if (ev.error === "network") {
      ck("ckFala", "sem internet para entender a fala", "aviso");
    } else if (ev.error === "audio-capture") {
      ck("ckFala", "sem microfone", "ruim");
    }
    diag("dFala", "erro: " + ev.error);
    if (ev.error !== "no-speech" && ev.error !== "aborted") {
      errosSeguidos++;
      enviarCanal({ t: "estadoFala", estado: "erro: " + ev.error });
    }
  };
  rec.onend = () => {   // o Chrome encerra sozinho após silêncio: reinicia (mais devagar se der erro)
    const espera = errosSeguidos ? Math.min(30000, 1000 * 2 ** Math.min(errosSeguidos, 5)) : 300;
    if (falaAtiva && !falaBloqueada) setTimeout(() => { try { rec.start(); } catch (_) {} }, espera);
    else diag("dFala", "parado");
  };
  falaAtiva = true;
  try { rec.start(); } catch (_) {}
}

// O robô (voz do ator ou sintetizada) falou há menos de 0,7 s: o que o reconhecimento ouvir agora
// pode ser o eco dele. A página do ator usa isso para a IA não responder ao próprio robô.
function roboFalandoAgora() { return performance.now() - robotFalouEm < 700; }

function tratarFrase(texto) {
  const agora = performance.now();
  // Eco: se o robô acabou de falar e o microfone (com cancelamento de eco) não captou a pessoa,
  // o texto provavelmente é a própria voz do robô saindo da caixa de som.
  if (agora - robotFalouEm < 2500 && agora - clienteFalouEm > 3500) {
    diag("dTexto", "(eco ignorado) " + texto);
    return;
  }
  diag("dTexto", texto);
  const r = reagirAFrase(texto, true);
  enviarCanal({ t: "fala", texto, final: true, emocao: r.emocao, intensidade: r.intensidade, sobreposta: roboFalandoAgora() });
}

// ---------------------------------------------------------------- voz sintetizada (texto do ator)
let vozSintetica = null;
function escolherVoz() {
  const vozes = speechSynthesis.getVoices().filter((v) => /^pt(-|_)?BR/i.test(v.lang) || /^pt/i.test(v.lang));
  // prefere vozes neurais/online (soam melhor)
  vozSintetica = vozes.find((v) => /natural|online|neural/i.test(v.name)) || vozes.find((v) => /google/i.test(v.name)) || vozes[0] || null;
}
if ("speechSynthesis" in window) { escolherVoz(); speechSynthesis.onvoiceschanged = escolherVoz; }

function falarTexto(texto) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(String(texto).slice(0, 500));
  u.lang = "pt-BR";
  if (vozSintetica) u.voice = vozSintetica;
  u.rate = 1.02;
  u.pitch = 0.85;
  u.onboundary = () => { pulsoTts = 1; };
  u.onstart = () => enviarCanal({ t: "falaRobo", ativo: true });
  u.onend = u.onerror = () => { if (!speechSynthesis.speaking) enviarCanal({ t: "falaRobo", ativo: false }); };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
let pulsoTts = 0;

// ---------------------------------------------------------------- laço de áudio -> rosto
function laco() {
  const agora = performance.now();
  let fala = 0;
  const nr = rms(nivelRobo);
  if (nr > 0.012) fala = Math.min(1, (nr - 0.012) * 9);
  if ("speechSynthesis" in window && speechSynthesis.speaking) {
    pulsoTts = Math.max(0, pulsoTts - 0.06);
    fala = Math.max(fala, 0.25 + 0.45 * Math.abs(Math.sin(agora / 70)) * (0.6 + pulsoTts * 0.4));
  }
  if (fala > 0.12) robotFalouEm = agora;
  if (!demoFala) rosto.falando(fala);

  const nm = rms(nivelMic);
  if (nm > 0.025) clienteFalouEm = agora;
  rosto.ouvindo(agora - clienteFalouEm < 700 && fala < 0.1);
  const barra = $("nivelMic");
  if (barra && !$("preparo").classList.contains("oculto")) barra.style.width = Math.min(100, nm * 400) + "%";
  requestAnimationFrame(laco);
}
requestAnimationFrame(laco);

// ---------------------------------------------------------------- sinalização
function atualizarRostoEstado() {
  if (!comecou) { rosto.modo(atorOnline ? "procurando" : "dormindo"); return; }
  if (pc && pc.connectionState === "connected") rosto.modo("acordado");
  else rosto.modo(atorOnline ? "procurando" : "dormindo");
}

function agendarPedido(ms) {
  clearTimeout(timerPedir);
  timerPedir = setTimeout(() => {
    if (comecou && !emConversa && atorOnline && ws && ws.readyState === WebSocket.OPEN) enviar({ tipo: "pedir" });
  }, ms);
}

function conectarWs() {
  clearTimeout(timerWs);
  const token = sessionStorage.getItem("token") || "";
  if (!token) { $("blocoToken").classList.remove("oculto"); ck("ckServidor", "falta o código", "aviso"); return; }
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ck("ckServidor", "conectando…", "aviso");
  ws.onopen = () => {
    tentativasWs = 0;
    ck("ckServidor", "ok", "ok");
    clearInterval(timerKeepalive);
    timerKeepalive = setInterval(() => enviar({ tipo: "ping" }), 20000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    fila = fila.then(() => tratarMensagem(msg)).catch((e) => console.error(e));   // em ordem: oferta antes dos ICE
  };
  ws.onclose = (ev) => {
    clearInterval(timerKeepalive);
    atorOnline = false;
    encerrarConversa();
    ck("ckServidor", "desconectado", "ruim");
    ck("ckAtor", "—", "");
    ponto("ruim");
    diag("dConexao", "servidor desconectado");
    if (ev.code === 4401) {
      sessionStorage.removeItem("token");
      $("blocoToken").classList.remove("oculto");
      mostrarPreparo("Código de acesso inválido. Use o link de CLIENTE que o iniciar.bat mostrou.");
      return;
    }
    if (ev.code === 4000) { mostrarPreparo("Esta tela foi aberta em outra janela."); return; }
    const espera = ev.code === 4409 ? 3000 : Math.min(1000 * 2 ** tentativasWs++, 8000);
    timerWs = setTimeout(conectarWs, espera);
  };
  ws.onerror = () => {};
}

async function tratarMensagem(msg) {
  switch (msg.tipo) {
    case "config":
      iceServers = msg.ice || [];
      break;
    case "presenca":
      atorOnline = !!msg.robo;
      ck("ckAtor", atorOnline ? "online" : "offline", atorOnline ? "ok" : "aviso");
      if (!emConversa) {
        ponto(atorOnline ? "aviso" : "ruim");
        diag("dConexao", atorOnline ? "ator online; conectando" : "esperando o ator");
        if (atorOnline) agendarPedido(400);
      }
      atualizarRostoEstado();
      break;
    case "aceito":
      emConversa = true;
      diag("dConexao", "aceito; negociando mídia");
      break;
    case "offer":
      if (emConversa) await tratarOferta(msg.sdp);
      break;
    case "ice":
      if (pc && msg.candidato && msg.candidato.candidate) await pc.addIceCandidate(msg.candidato).catch(() => {});
      break;
    case "encerrar":
      encerrarConversa();
      agendarPedido(1500);
      break;
    case "recusado":
      emConversa = false;
      agendarPedido(3000);
      break;
    case "erro":
      if (msg.motivo === "operador_ausente") {
        mostrarPreparo("O servidor não está no modo ator. Feche tudo e rode: iniciar.bat -Ator");
      } else if (msg.motivo === "robo_em_uso" || msg.motivo === "robo_ausente") {
        agendarPedido(3000);
      }
      break;
  }
}

async function tratarOferta(sdp) {
  fecharPc();
  pc = new RTCPeerConnection({ iceServers });
  const meuPc = pc;
  pc.ontrack = (ev) => {
    if (ev.track.kind !== "audio") return;
    const fluxo = new MediaStream([ev.track]);
    $("vozRobo").srcObject = fluxo;
    $("vozRobo").play().catch(() => {});
    nivelRobo = analisador(fluxo);
  };
  pc.onicecandidate = (ev) => enviar({ tipo: "ice", candidato: ev.candidate ? ev.candidate.toJSON() : null });
  pc.ondatachannel = (ev) => configurarCanal(ev.channel);
  pc.onconnectionstatechange = () => {
    if (pc !== meuPc) return;
    const s = pc.connectionState;
    diag("dConexao", "mídia: " + s);
    if (s === "connected") { ponto("ok"); }
    else if (s === "disconnected") { ponto("aviso"); }
    else if (s === "failed") {
      enviar({ tipo: "encerrar" });
      encerrarConversa();
      agendarPedido(1500);
    }
    atualizarRostoEstado();
  };
  await pc.setRemoteDescription({ type: "offer", sdp });
  const audio = midia && midia.getAudioTracks()[0];
  const video = midia && midia.getVideoTracks()[0];
  for (const t of pc.getTransceivers()) {
    const tipo = t.receiver.track.kind;
    if (tipo === "audio") {
      t.direction = audio ? "sendrecv" : "recvonly";
      if (audio) await t.sender.replaceTrack(audio);
    } else if (tipo === "video") {
      t.direction = video ? "sendonly" : "inactive";
      if (video) await t.sender.replaceTrack(video);
    }
  }
  await pc.setLocalDescription(await pc.createAnswer());
  enviar({ tipo: "answer", sdp: pc.localDescription.sdp });
  // na rede, o áudio passa na frente do vídeo; o vídeo é limitado a 600 kbit/s
  for (const t of pc.getTransceivers()) {
    const snd = t.sender;
    if (!snd || !snd.track) continue;
    try {
      const p = snd.getParameters();
      if (!p.encodings || !p.encodings.length) continue;
      for (const e of p.encodings) {
        e.priority = e.networkPriority = snd.track.kind === "audio" ? "high" : "low";
        if (snd.track.kind === "video") e.maxBitrate = 600000;
      }
      await snd.setParameters(p);
    } catch (_) {}
  }
}

function configurarCanal(c) {
  canal = c;
  c.onopen = () => {
    enviarCanal({ t: "estadoFala", estado: rec ? (falaBloqueada ? "bloqueado" : "ativo") : (SR ? "parado" : "indisponível") });
    enviarCanal({ t: "rosto", nome: rosto.nome, intensidade: rosto.intensidade, origem: "inicio" });
  };
  c.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === "ping") enviarCanal({ t: "pong", ts: m.ts });
    else if (m.t === "olhar") {
      rosto.olharPara(m.x, m.y);                    // a câmera achou a pessoa: olha para ela
    } else if (m.t === "expressao" && m.origem === "camera") {
      // reação ao rosto da pessoa (sorriso, surpresa): não passa por cima do que o ator escolheu
      if (autoEmocao && performance.now() >= manualAte && rosto.nome === "neutro") {
        aplicarExpressao(m.nome, m.intensidade ?? 0.7, "camera");
      }
    } else if (m.t === "expressao") {
      const fixa = !!m.fixar && m.nome !== "neutro";
      // Neutro devolve o rosto ao automático na hora; as outras mandam por 8 s (ou até soltar)
      // a expressão que acompanha a resposta da IA não bloqueia a reação automática ao cliente
      if (m.origem !== "ia") manualAte = fixa ? Infinity : m.nome === "neutro" ? 0 : performance.now() + 8000;
      aplicarExpressao(m.nome, m.intensidade ?? 0.9, m.origem === "ia" ? "ia" : fixa ? "fixa" : "ator");
    } else if (m.t === "soltar") {
      manualAte = 0;
      aplicarExpressao("neutro", 0, "ator");
    } else if (m.t === "automatico") {
      autoEmocao = !!m.ligado;
    } else if (m.t === "falar" && m.texto) {
      falarTexto(m.texto);
    } else if (m.t === "calar") {
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      enviarCanal({ t: "falaRobo", ativo: false });
    }
  };
  c.onclose = () => { if (canal === c) canal = null; };
}

function fecharPc() {
  if (canal) { try { canal.close(); } catch (_) {} canal = null; }
  if (pc) { pc.onconnectionstatechange = null; try { pc.close(); } catch (_) {} pc = null; }
  $("vozRobo").srcObject = null;
  nivelRobo = null;
}

function encerrarConversa() {
  emConversa = false;
  fecharPc();
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  manualAte = 0;
  aplicarExpressao("neutro", 0, "fim");
  atualizarRostoEstado();
}

// ---------------------------------------------------------------- tela de preparo / começar
function mostrarPreparo(texto) {
  comecou = false;
  $("preparo").classList.remove("oculto");
  document.body.classList.remove("sem-cursor");
  aviso(texto);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function lerTokenDigitado() {
  const t = $("token").value.trim();
  if (t) {
    sessionStorage.setItem("token", t);
    $("blocoToken").classList.add("oculto");
    if (ws) { ws.onclose = null; try { ws.close(); } catch (_) {} }
    conectarWs();
  }
  return !!sessionStorage.getItem("token");
}

$("btnTestar").onclick = async () => {
  if (ctxAudio.state === "suspended") ctxAudio.resume();
  lerTokenDigitado();
  aviso("");
  await ligarMidia();
  if (!SR) ck("ckFala", "indisponível (use Chrome ou Edge)", "ruim");
  else if (!rec) ck("ckFala", "liga ao começar", "");
};

$("btnComecar").onclick = async () => {
  if (ctxAudio.state === "suspended") await ctxAudio.resume();
  if (!lerTokenDigitado()) { aviso("Falta o código de acesso: abra o link de CLIENTE completo."); return; }
  const ok = await ligarMidia();
  if (!ok && !midia) {
    aviso(($("avisoPreparo").textContent || "") + " Mesmo assim, clique em Começar de novo para seguir sem câmera e microfone.");
    if (!$("btnComecar").dataset.insistiu) { $("btnComecar").dataset.insistiu = "1"; return; }
  }
  iniciarFala();
  comecou = true;
  $("preparo").classList.add("oculto");
  aviso("");
  document.documentElement.requestFullscreen?.().catch(() => {});
  manterTelaLigada();
  atualizarRostoEstado();
  if (atorOnline) agendarPedido(100);
};

let travaTela = null;
async function manterTelaLigada() {
  try { travaTela = await navigator.wakeLock?.request("screen"); } catch (_) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && comecou) manterTelaLigada();
});

// esconde o cursor parado
let timerCursor = null;
document.addEventListener("mousemove", () => {
  document.body.classList.remove("sem-cursor");
  clearTimeout(timerCursor);
  if (comecou) timerCursor = setTimeout(() => document.body.classList.add("sem-cursor"), 2500);
});

document.addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "INPUT") return;
  if (ev.key === "d" || ev.key === "D") $("diag").classList.toggle("oculto");
  else if (ev.key === "f" || ev.key === "F") document.documentElement.requestFullscreen?.().catch(() => {});
  else if (ev.key === "p" || ev.key === "P") { if (comecou) mostrarPreparo(""); }
});

// ---------------------------------------------------------------- início
try {
  const doLink = params.get("token");
  if (doLink) { sessionStorage.setItem("token", doLink); history.replaceState(null, "", location.pathname); }
} catch (_) {}

if (params.has("demo")) {
  // demonstração sem conexão: passa pelas expressões (útil para ver o rosto)
  $("preparo").classList.add("oculto");
  comecou = true;
  rosto.modo("acordado");
  const fixa = params.get("expressao");
  if (fixa) aplicarExpressao(fixa, Number(params.get("intensidade") || 1), "fixa");
  else {
    const lista = ["feliz", "triste", "surpreso", "pensativo", "preocupado", "rindo", "neutro"];
    let i = 0;
    setInterval(() => aplicarExpressao(lista[i++ % lista.length], 1, "demo"), 3500);
  }
  if (params.has("falando")) setInterval(() => falarDemo(), 50);
} else {
  if (sessionStorage.getItem("token")) conectarWs();
  else { $("blocoToken").classList.remove("oculto"); ck("ckServidor", "falta o código", "aviso"); }
  if (!SR) ck("ckFala", "indisponível (use Chrome ou Edge)", "ruim");
  atualizarRostoEstado();
}

function falarDemo() {
  const t = performance.now() / 1000;
  rosto.falando(Math.max(0, Math.sin(t * 9) * 0.5 + Math.sin(t * 23) * 0.3 + 0.2));
}
