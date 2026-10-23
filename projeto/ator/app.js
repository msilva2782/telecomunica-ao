"use strict";
// Página de quem faz o papel do robô (modo ator).
// Entra no servidor com o token do ROBÔ: quando o cliente abre a tela do robô, o servidor manda
// "iniciar" e esta página cria a oferta WebRTC: envia a sua voz (com efeito robótico) e recebe a
// câmera e o microfone do cliente. Pelo canal de dados chegam as legendas do que o cliente fala e a
// expressão mostrada; daqui saem expressões escolhidas à mão e frases para a voz sintetizada.

const $ = (id) => document.getElementById(id);

const EXPRESSOES = [
  ["neutro", "Neutro", "0"], ["feliz", "Feliz", "1"], ["rindo", "Rindo", "2"], ["triste", "Triste", "3"],
  ["surpreso", "Surpreso", "4"], ["pensativo", "Pensativo", "5"], ["preocupado", "Preocupado", "6"],
];
const FRASES = [
  "Olá! Eu sou um robô assistente. Como você se chama?",
  "Que legal! Me conta mais sobre isso.",
  "Entendi.",
  "Hmm, deixa eu pensar um pouco.",
  "Pode repetir, por favor? Não entendi direito.",
  "Sinto muito por isso. Quer falar sobre o assunto?",
  "Foi um prazer conversar com você!",
];

let ws = null, pc = null, canal = null, iceServers = [];
let tentativas = 0, timerWs = null, timerKeepalive = null, timerPing = null, ultimoPong = 0;
let fila = Promise.resolve();          // mensagens tratadas em ordem (oferta antes dos ICE)
let clientePresente = false;
let usuarioSaiu = false;
const historico = [];                  // {hora, quem, texto, emocao}

// ---------------------------------------------------------------- utilidades
function log(texto) {
  const l = $("log");
  l.textContent += `[${new Date().toLocaleTimeString()}] ${texto}\n`;
  l.scrollTop = l.scrollHeight;
}
function selo(id, texto, classe) { const e = $(id); e.textContent = texto; e.className = "selo " + classe; }
function enviar(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function enviarCanal(obj) {
  if (canal && canal.readyState === "open") { canal.send(JSON.stringify(obj)); return true; }
  return false;
}

// ---------------------------------------------------------------- áudio: microfone + voz robótica
const ctx = new (window.AudioContext || window.webkitAudioContext)();
let micStream = null, mudo = false;
const no = {};                          // nós do grafo de áudio

function montarVoz(stream) {
  const fonte = ctx.createMediaStreamSource(stream);
  no.passaAlta = new BiquadFilterNode(ctx, { type: "highpass", frequency: 110 });
  no.passaBaixa = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 6500 });
  fonte.connect(no.passaAlta).connect(no.passaBaixa);

  // caminho limpo
  no.seco = new GainNode(ctx, { gain: 1 });
  no.passaBaixa.connect(no.seco);

  // modulação em anel (o "timbre de robô") + pente metálico
  no.anel = new GainNode(ctx, { gain: 0 });
  no.osc = new OscillatorNode(ctx, { type: "sine", frequency: 55 });
  no.osc.connect(no.anel.gain);
  no.osc.start();
  no.passaBaixa.connect(no.anel);
  no.atraso = new DelayNode(ctx, { delayTime: 0.008 });
  no.retorno = new GainNode(ctx, { gain: 0.35 });
  no.anel.connect(no.atraso);
  no.atraso.connect(no.retorno).connect(no.atraso);
  no.molhado = new GainNode(ctx, { gain: 0 });
  no.anel.connect(no.molhado);
  no.atraso.connect(no.molhado);

  no.compressor = new DynamicsCompressorNode(ctx, { threshold: -24, ratio: 4, attack: 0.003, release: 0.2 });
  no.saida = new GainNode(ctx, { gain: 1.25 });
  no.seco.connect(no.compressor);
  no.molhado.connect(no.compressor);
  no.compressor.connect(no.saida);
  no.destino = ctx.createMediaStreamDestination();
  no.saida.connect(no.destino);

  no.monitor = new GainNode(ctx, { gain: 0 });
  no.saida.connect(no.monitor).connect(ctx.destination);

  no.medidor = new AnalyserNode(ctx, { fftSize: 512 });
  no.saida.connect(no.medidor);
  ajustarVoz();
  return no.destino.stream.getAudioTracks()[0];
}

function ajustarVoz() {
  if (!no.seco) return;
  const robotica = $("chkRobotica").checked;
  const k = robotica ? Number($("intensidade").value) / 100 : 0;
  const t = ctx.currentTime;
  no.seco.gain.setTargetAtTime(1 - 0.8 * k, t, 0.05);
  no.molhado.gain.setTargetAtTime(k * 1.1, t, 0.05);
  no.osc.frequency.setTargetAtTime(38 + 34 * k, t, 0.05);
  no.retorno.gain.setTargetAtTime(0.15 + 0.35 * k, t, 0.05);
  no.saida.gain.setTargetAtTime(mudo ? 0 : 1.25, t, 0.02);
  no.monitor.gain.setTargetAtTime($("chkMonitor").checked ? 1 : 0, t, 0.05);
}

function alternarMudo() {
  mudo = !mudo;
  ajustarVoz();
  $("btnMudo").textContent = mudo ? "Microfone SILENCIADO (M para voltar)" : "Silenciar microfone (M)";
  $("btnMudo").classList.toggle("mudo", mudo);
}

let trilhaVoz = null;
async function prepararMicrofone() {
  if (trilhaVoz) return true;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
  } catch (e) {
    const msg = {
      NotAllowedError: "Permissão do microfone negada. Libere no cadeado da barra de endereço.",
      NotFoundError: "Nenhum microfone encontrado.",
      NotReadableError: "O microfone está em uso por outro programa.",
    }[e.name] || ("Não consegui abrir o microfone (" + e.name + ").");
    $("avisoInicio").textContent = msg + (window.isSecureContext ? "" : " Esta página precisa de HTTPS.");
    log(msg);
    return false;
  }
  trilhaVoz = montarVoz(micStream);
  micStream.getAudioTracks()[0].onended = () => log("o microfone foi desconectado!");
  return true;
}

// medidores
let medidorCliente = null;
function nivel(analisador, buf) {
  analisador.getByteTimeDomainData(buf);
  let s = 0;
  for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
  return Math.sqrt(s / buf.length);
}
const bufMic = new Uint8Array(512), bufCli = new Uint8Array(512);
// o aviso sobre o vídeo segue o que o elemento realmente mostra (eventos de faixa podem chegar antes)
for (const evento of ["resize", "playing", "loadeddata"]) {
  $("videoCliente").addEventListener(evento, () => {
    if ($("videoCliente").videoWidth > 0) $("semVideo").classList.add("oculto");
  });
}

// Quem está falando agora (usado para a IA esperar a vez dela)
const vez = {
  clienteTextoEm: -Infinity,   // última legenda do cliente (parcial ou final)
  clienteVozEm: -Infinity,     // último instante com voz no áudio do cliente
  atorVozEm: -Infinity,        // último instante com voz no seu microfone
  atorVozDesde: 0,             // início da sua fala atual (0 = calado)
  roboFalando: false, roboFalandoDesde: 0, roboParouEm: -Infinity,   // voz sintetizada na tela do robô
};
let ruidoCliente = 0.01;

function desenharNiveis() {
  const agora = performance.now();
  if (no.medidor) {
    const n = nivel(no.medidor, bufMic);
    $("nivelMic").style.width = Math.min(100, n * 300) + "%";
    if (!mudo && n > 0.04) { vez.atorVozEm = agora; if (!vez.atorVozDesde) vez.atorVozDesde = agora; }
    else if (agora - vez.atorVozEm > 400) vez.atorVozDesde = 0;
  }
  // eco: enquanto você ou a voz sintetizada falam, abaixa o que volta do cliente
  AudioCliente.abafar(agora - vez.atorVozEm < 250 || roboFalandoAgora(agora));
  if (medidorCliente) {
    const n = nivel(medidorCliente, bufCli);
    $("nivelCliente").style.width = Math.min(100, n * 300) + "%";
    ruidoCliente = n < ruidoCliente ? ruidoCliente * 0.9 + n * 0.1 : ruidoCliente * 1.002;   // piso de ruído
    // voz do cliente só conta quando o robô está calado (senão pode ser o eco do próprio robô)
    if (n > Math.max(0.03, ruidoCliente * 3) && !roboFalandoAgora(agora) && agora - vez.atorVozEm > 300) vez.clienteVozEm = agora;
  }
  requestAnimationFrame(desenharNiveis);
}
requestAnimationFrame(desenharNiveis);

// ---------------------------------------------------------------- sinalização
function conectarWs() {
  clearTimeout(timerWs);
  const token = sessionStorage.getItem("token") || "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  selo("stServidor", "conectando…", "aviso");
  ws.onopen = () => {
    tentativas = 0;
    selo("stServidor", "conectado", "ok");
    log("conectado ao servidor; esperando o cliente");
    verificarIa();
    clearInterval(timerKeepalive);
    timerKeepalive = setInterval(() => enviar({ tipo: "ping" }), 20000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    fila = fila.then(() => tratarMensagem(msg)).catch((e) => log("erro: " + e));
  };
  ws.onclose = (ev) => {
    clearInterval(timerKeepalive);
    fecharPc();
    selo("stServidor", "desconectado", "ruim");
    selo("stCliente", "—", "neutro");
    if (usuarioSaiu) return;
    if (ev.code === 4401) {
      sessionStorage.removeItem("token");
      $("inicio").classList.remove("oculto");
      $("avisoInicio").textContent = "Código recusado. Use o link de ATOR (ROBÔ) que o iniciar.bat mostrou.";
      return;
    }
    if (ev.code === 4000) {
      selo("stServidor", "em outra janela", "aviso");
      log("o robô foi aberto em outra janela (ou o robô Python está ligado). Esta parou.");
      return;
    }
    const espera = Math.min(1000 * 2 ** tentativas++, 8000);
    log(`servidor indisponível; nova tentativa em ${Math.round(espera / 1000)}s`);
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
      clientePresente = !!msg.cliente;
      if (!pc) selo("stCliente", clientePresente ? "abrindo…" : "ausente", clientePresente ? "aviso" : "neutro");
      if (msg.operador && !msg.cliente) log("aviso: há um operador conectado (no modo ator ele não é usado)");
      break;
    case "iniciar":
      if (msg.com === "cliente") await iniciarSessao();
      else log("pedido de sessão do operador ignorado (modo ator)");
      break;
    case "answer":
      if (pc) await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      break;
    case "ice":
      if (pc && msg.candidato && msg.candidato.candidate) await pc.addIceCandidate(msg.candidato).catch((e) => log("ICE ignorado: " + e));
      break;
    case "encerrar":
      log("conversa encerrada (" + (msg.motivo || "-") + ")");
      fecharPc();
      registrar("sistema", "— conversa encerrada —");
      break;
    case "erro":
      log("servidor: " + msg.motivo);
      break;
  }
}

async function iniciarSessao() {
  fecharPc();
  log("cliente entrou; conectando…");
  pc = new RTCPeerConnection({ iceServers });
  const meuPc = pc;
  if (trilhaVoz) pc.addTrack(trilhaVoz, no.destino.stream);
  else pc.addTransceiver("audio", { direction: "recvonly" });
  pc.addTransceiver("video", { direction: "recvonly" });
  configurarCanal(pc.createDataChannel("ctrl"));

  const remoto = new MediaStream();
  $("videoCliente").srcObject = remoto;
  pc.ontrack = (ev) => {
    remoto.addTrack(ev.track);
    if (ev.track.kind === "video") {
      ev.track.onmute = () => {
        $("semVideo").textContent = "O cliente está sem câmera (ou ela travou).";
        $("semVideo").classList.remove("oculto");
      };
    } else {
      // áudio do cliente passa pela limpeza (audio_cliente.js) e sai tratado no seu fone
      const tratado = AudioCliente.ligar(ev.track);
      if (tratado) {
        $("videoCliente").muted = true;            // o som sai pelo tratamento, não pelo vídeo
        medidorCliente = tratado;
      } else {
        $("videoCliente").muted = false;           // sem tratamento: som direto, como antes
        const a = ctx.createAnalyser();
        a.fftSize = 512;
        ctx.createMediaStreamSource(new MediaStream([ev.track])).connect(a);
        medidorCliente = a;
      }
    }
    $("videoCliente").play().catch(() => {});
  };
  pc.onicecandidate = (ev) => enviar({ tipo: "ice", candidato: ev.candidate ? ev.candidate.toJSON() : null });
  pc.onconnectionstatechange = () => {
    if (pc !== meuPc) return;
    const s = pc.connectionState;
    log("conexão: " + s);
    if (s === "connected") { selo("stConexao", "conectado", "ok"); selo("stCliente", "na conversa", "ok"); }
    else if (s === "connecting") selo("stConexao", "conectando…", "aviso");
    else if (s === "disconnected") selo("stConexao", "instável", "aviso");
    else if (s === "failed") {
      selo("stConexao", "falhou", "ruim");
      enviar({ tipo: "encerrar", motivo: "falha_ice" });   // o cliente pede de novo sozinho
      fecharPc();
    }
  };
  await pc.setLocalDescription(await pc.createOffer());
  enviar({ tipo: "offer", sdp: opusParaVoz(pc.localDescription.sdp) });
}

// Pede ao navegador do cliente mais qualidade no áudio que ele envia: 64 kbit/s em vez de ~32,
// mono e com correção de perda de pacotes (useinbandfec). Só muda a cópia enviada ao cliente.
function opusParaVoz(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000/i);
  if (!m) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${m[1]} [^\\r\\n]*`), (linha) => {
    for (const [k, v] of [["useinbandfec", "1"], ["maxaveragebitrate", "64000"], ["stereo", "0"]]) {
      const re = new RegExp(`(^|[; ])${k}=[^;]*`);
      linha = re.test(linha) ? linha.replace(re, `$1${k}=${v}`) : `${linha};${k}=${v}`;
    }
    return linha;
  });
}

function fecharPc() {
  clearInterval(timerPing);
  if (canal) { try { canal.close(); } catch (_) {} canal = null; }
  if (pc) { pc.onconnectionstatechange = null; try { pc.close(); } catch (_) {} pc = null; }
  $("videoCliente").srcObject = null;
  $("semVideo").textContent = "Esperando o cliente abrir a tela do robô…";
  $("semVideo").classList.remove("oculto");
  $("legenda").classList.add("oculto");
  medidorCliente = null;
  AudioCliente.desligar();
  $("videoCliente").muted = false;
  $("nivelCliente").style.width = "0%";
  vez.roboFalando = false;
  selo("stConexao", "sem sessão", "neutro");
  selo("stRtt", "—", "neutro");
  selo("stCliente", clientePresente ? "abrindo…" : "ausente", clientePresente ? "aviso" : "neutro");
  $("rostoAgora").textContent = "—";
  conversaIa.length = 0;
  cancelarIa();
  Visao.zerar();
  Visao.desenhar($("camadaVisao"));
  olharEnviado = null;
}

// ---------------------------------------------------------------- canal de dados
function configurarCanal(c) {
  canal = c;
  c.onopen = () => {
    log("canal de controle aberto");
    enviarCanal({ t: "automatico", ligado: $("chkAuto").checked });
    clearInterval(timerPing);
    ultimoPong = performance.now();
    timerPing = setInterval(() => {
      enviarCanal({ t: "ping", ts: performance.now() });
      if (performance.now() - ultimoPong > 4000) selo("stRtt", "sem resposta", "ruim");
    }, 1000);
  };
  c.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === "pong") {
      ultimoPong = performance.now();
      const rtt = performance.now() - m.ts;
      selo("stRtt", `${rtt.toFixed(0)} ms`, rtt < 300 ? "ok" : rtt < 450 ? "aviso" : "ruim");
    } else if (m.t === "fala") {
      mostrarLegenda(String(m.texto || ""), !!m.final);
      if (!m.sobreposta) vez.clienteTextoEm = performance.now();
      if (m.final) { registrar("cliente", String(m.texto), m.emocao); aoClienteFalar(String(m.texto), !!m.sobreposta); }
    } else if (m.t === "falaRobo") {
      vez.roboFalando = !!m.ativo;
      if (m.ativo) vez.roboFalandoDesde = performance.now(); else vez.roboParouEm = performance.now();
    } else if (m.t === "rosto") {
      const pct = Math.round((m.intensidade || 0) * 100);
      $("rostoAgora").textContent = m.nome === "neutro" ? "neutro" : `${m.nome} ${pct}% (${m.origem})`;
      marcarBotao(m.nome);
    } else if (m.t === "estadoFala") {
      $("stFala").textContent = "reconhecimento de fala: " + m.estado;
      if (m.estado !== "ativo") log("reconhecimento de fala do cliente: " + m.estado);
    }
  };
  c.onclose = () => { if (canal === c) canal = null; };
}

let timerLegenda = null;
function mostrarLegenda(texto, final) {
  const e = $("legenda");
  e.textContent = texto;
  e.classList.toggle("parcial", !final);
  e.classList.remove("oculto");
  clearTimeout(timerLegenda);
  timerLegenda = setTimeout(() => e.classList.add("oculto"), final ? 6000 : 3000);
}

function registrar(quem, texto, emocao) {
  const hora = new Date().toLocaleTimeString();
  historico.push({ hora, quem, texto, emocao: emocao || "" });
  const lin = document.createElement("div");
  lin.className = "lin";
  const h = document.createElement("span"); h.className = "hora"; h.textContent = hora;
  const t = document.createElement("span");
  t.textContent = (quem === "robo" ? "robô (texto): " : quem === "ia" ? "robô (IA): " : "") + texto;
  if (quem === "robo") t.className = "robo";
  else if (quem === "ia") t.className = "ia";
  else if (quem === "sistema") t.className = "sistema";
  lin.append(h, t);
  if (emocao && emocao !== "neutro") {
    const e = document.createElement("span"); e.className = "emo " + emocao; e.textContent = emocao;
    lin.append(e);
  }
  $("historico").append(lin);
  $("historico").scrollTop = $("historico").scrollHeight;
}

// ---------------------------------------------------------------- controles do rosto e da fala
function marcarBotao(nome) {
  for (const b of $("expressoes").querySelectorAll("button")) b.classList.toggle("ativo", b.dataset.nome === nome);
}

function escolherExpressao(nome) {
  const ok = enviarCanal({ t: "expressao", nome, intensidade: 0.95, fixar: $("chkFixar").checked });
  if (!ok) log("sem conexão com a tela do robô");
}

for (const [nome, rotulo, tecla] of EXPRESSOES) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.nome = nome;
  b.innerHTML = `${rotulo} <kbd>${tecla}</kbd>`;
  b.onclick = () => escolherExpressao(nome);
  $("expressoes").append(b);
}

function falar(texto, origem) {
  texto = texto.trim();
  if (!texto) return;
  if (origem !== "ia") cancelarIa();   // quando você fala, a IA que estava pensando fica de lado
  if (enviarCanal({ t: "falar", texto })) {
    registrar(origem === "ia" ? "ia" : "robo", texto);
    anotarConversa("robo", texto);
  } else log("sem conexão com a tela do robô");
}
for (const f of FRASES) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = f;
  b.onclick = () => falar(f);
  $("frases").append(b);
}
$("formFalar").addEventListener("submit", (ev) => {
  ev.preventDefault();
  falar($("textoFalar").value);
  $("textoFalar").value = "";
});
$("btnCalar").onclick = () => enviarCanal({ t: "calar" });

$("chkAuto").onchange = () => enviarCanal({ t: "automatico", ligado: $("chkAuto").checked });
$("chkFixar").onchange = () => { if (!$("chkFixar").checked) enviarCanal({ t: "soltar" }); };
$("chkRobotica").onchange = ajustarVoz;
$("intensidade").oninput = ajustarVoz;
$("chkMonitor").onchange = ajustarVoz;
$("btnMudo").onclick = alternarMudo;

document.addEventListener("keydown", (ev) => {
  if (/^(INPUT|TEXTAREA)$/.test(ev.target.tagName) || ev.ctrlKey || ev.altKey || ev.metaKey) return;
  if (ev.key === "Enter" && !$("sugestaoIa").classList.contains("oculto")) { falarSugestao(); ev.preventDefault(); return; }
  const exp = EXPRESSOES.find((e) => e[2] === ev.key);
  if (exp) { escolherExpressao(exp[0]); ev.preventDefault(); }
  else if (ev.key === "m" || ev.key === "M") alternarMudo();
  else if (ev.key === "i" || ev.key === "I") alternarIa();
  else if (ev.key === "v" || ev.key === "V") perguntarOQueVe();
});

$("btnBaixar").onclick = () => {
  const linhas = historico.map((h) => `[${h.hora}] ${h.quem === "robo" ? "ROBÔ (texto)" : h.quem === "ia" ? "ROBÔ (IA)" : h.quem === "sistema" ? "--" : "CLIENTE"}: ${h.texto}` +
                                    (h.emocao && h.emocao !== "neutro" ? ` (${h.emocao})` : ""));
  const blob = new Blob([linhas.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `conversa-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};


// ---------------------------------------------------------------- respostas da IA
// O cliente fala -> (esta página) -> servidor (/ia/responder, onde fica a chave) -> resposta curta.
// "sugerir": aparece num quadro para você aprovar/editar; "automatica": o robô fala na hora.
let modoIa = "desligada", iaDisponivel = false;
let bufferIa = [], seqIa = 0;
let pedindo = false, pendente = null;     // pendente: resposta pronta esperando a vez de falar
const conversaIa = [];                 // {quem: "cliente"|"robo", texto} (contexto para a IA)

function anotarConversa(quem, texto) {
  conversaIa.push({ quem, texto });
  if (conversaIa.length > 20) conversaIa.shift();
}

function estadoIa(texto, erro) {
  const e = $("estadoIa");
  e.textContent = texto;
  e.classList.toggle("erro", !!erro);
}

async function chamarIa(caminho, corpo) {
  const ctl = new AbortController();
  const limite = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch("/ia/" + caminho, {
      method: corpo ? "POST" : "GET", signal: ctl.signal,
      headers: Object.assign({ "X-Token": sessionStorage.getItem("token") || "" },
                             corpo ? { "Content-Type": "application/json" } : {}),
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!r.ok) {
      let detalhe = "";
      try { detalhe = (await r.json()).detail; } catch (_) {}
      const e = new Error(typeof detalhe === "string" && detalhe ? detalhe : "erro " + r.status);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  } finally { clearTimeout(limite); }
}

async function verificarIa() {
  try {
    const e = await chamarIa("estado");
    iaDisponivel = !!e.disponivel;
    estadoIa(iaDisponivel ? `pronta (${e.modelo})` : "sem chave da API no servidor: veja o GUIA_IA.txt", !iaDisponivel);
  } catch (e) {
    iaDisponivel = false;
    estadoIa(e.status === 404 ? "este servidor ainda não tem o módulo de IA (veja o GUIA_IA.txt)"
                              : "não consegui verificar a IA: " + e.message, true);
  }
  $("btnModoIa").disabled = !iaDisponivel;
  if (!iaDisponivel) iaLigada = false;
  aplicarModoIa();
}

function esconderSugestao() { $("sugestaoIa").classList.add("oculto"); }

function cancelarIa() {
  seqIa++;
  bufferIa = [];
  pendente = null;
  esconderSugestao();
}

// ---- vez de falar: a IA só responde quando o cliente terminou e ninguém mais está falando
// "hum", "aham", "é", "tá": a pessoa está ouvindo ou pensando, não pediu resposta
const SO_ENCHIMENTO = /^(?:\s*(?:h+u+m+|h+m+|u+h*m+|a+h+n*|ã+|hã+|é+|e+h+|t[aá]|aham|uhum|unhum|uhm|hein|oh+|ah+)[\s.,!?…]*)+$/i;

function esperaSilencio() { return Number($("esperaIa").value); }
function roboFalandoAgora(agora) {
  return (vez.roboFalando && agora - vez.roboFalandoDesde < 30000) || agora - vez.roboParouEm < 500;
}
// Pode PEDIR a resposta (já vai pensando): o cliente parou há um instante e ninguém mais fala.
function podePedir(agora) {
  if (agora - vez.clienteTextoEm < Math.min(800, esperaSilencio())) return false;
  if (!$("chkEsperarVez").checked) return true;
  return agora - vez.atorVozEm > 800 && !roboFalandoAgora(agora);
}
// Pode FALAR a resposta: silêncio completo pelo tempo escolhido.
function vezLivre(agora) {
  const espera = esperaSilencio();
  if (agora - vez.clienteTextoEm < espera) return false;
  if (!$("chkEsperarVez").checked) return true;
  return agora - vez.clienteVozEm > espera * 0.75 && agora - vez.atorVozEm > 1200 && !roboFalandoAgora(agora);
}

function aoClienteFalar(texto, sobreposta) {
  anotarConversa("cliente", texto);
  if (modoIa === "desligada" || !iaDisponivel) return;
  if (sobreposta && $("chkEsperarVez").checked) {     // falou junto com o robô: quase sempre é eco
    log("IA ignorou (dito enquanto o robô falava): " + texto);
    return;
  }
  esconderSugestao();
  bufferIa.push(texto);                  // frases seguidas viram um só pedido
}

function tentarPendente(agora) {
  if (pendente.seq !== seqIa || modoIa !== "automatica") { pendente = null; return; }
  if (vez.clienteTextoEm > pendente.inicio || bufferIa.length) {
    pendente = null;
    estadoIa("o cliente voltou a falar: resposta descartada, esperando ele terminar…");
    return;
  }
  if (vezLivre(agora)) {
    const r = pendente.r;
    pendente = null;
    emocaoIa(r.emocao);
    falar(r.resposta, "ia");
  } else if (agora > pendente.ate) {
    const r = pendente.r;
    pendente = null;
    mostrarSugestao(r);
    estadoIa("não achei a vez de falar: a resposta ficou como sugestão");
  }
}

let ultimoAvisoVez = "";
setInterval(() => {
  const agora = performance.now();
  // você começou a responder pelo microfone: a vez é sua, a IA desiste
  if ($("chkAtorAssume").checked && vez.atorVozDesde && agora - vez.atorVozDesde > 700 &&
      (bufferIa.length || pedindo || pendente)) {
    cancelarIa();
    estadoIa("você respondeu: a IA ficou quieta");
  }
  if (pendente) tentarPendente(agora);
  if (!bufferIa.length || pedindo || pendente || modoIa === "desligada" || !iaDisponivel) { ultimoAvisoVez = ""; return; }
  if (podePedir(agora)) { ultimoAvisoVez = ""; pedirIa(); }
  else if (ultimoAvisoVez !== "esperando") { ultimoAvisoVez = "esperando"; estadoIa("esperando o cliente terminar de falar…"); }
}, 120);

function emocaoIa(nome) {
  if (nome && nome !== "neutro") enviarCanal({ t: "expressao", nome, intensidade: 0.8, fixar: false, origem: "ia" });
}

async function pedirIa() {
  const frases = bufferIa.slice();        // fica no buffer até a resposta valer
  if (!frases.length || modoIa === "desligada") return;
  const texto = frases.join(" ").slice(-500);
  if (SO_ENCHIMENTO.test(texto)) { bufferIa = []; estadoIa(`"${texto}": só um "hum", a IA não responde`); return; }
  pedindo = true;
  const meu = seqIa, inicio = performance.now();
  const historico = conversaIa.slice(0, Math.max(0, conversaIa.length - frases.length)).slice(-10);
  estadoIa("pensando…");
  try {
    const r = await chamarIa("responder", Object.assign({ texto, historico }, extrasVisao()));
    if (meu !== seqIa || modoIa === "desligada") return;       // ficou velha
    if (vez.clienteTextoEm > inicio || bufferIa.length !== frases.length) {
      estadoIa("o cliente continuou falando: esperando ele terminar…");   // pede de novo com a frase toda
      return;
    }
    bufferIa = [];
    estadoIa(`resposta em ${r.ms} ms`);
    if (modoIa === "automatica") pendente = { r, inicio, seq: seqIa, ate: performance.now() + 8000 };
    else mostrarSugestao(r);
  } catch (e) {
    if (meu !== seqIa) return;
    bufferIa = [];
    estadoIa("a IA falhou: " + (e.name === "AbortError" ? "demorou demais" : e.message), true);
    log("IA: " + e.message);
  } finally {
    pedindo = false;
  }
}

function mostrarSugestao(r) {
  const caixa = $("sugestaoIa");
  $("textoIa").value = r.resposta;
  caixa.dataset.original = r.resposta;
  caixa.dataset.emocao = r.emocao;
  $("emocaoIa").textContent = r.emocao === "neutro" ? "" : "(" + r.emocao + ")";
  caixa.classList.remove("oculto");
}

function falarSugestao() {
  const caixa = $("sugestaoIa");
  const texto = $("textoIa").value.trim();
  if (!texto) return;
  const original = caixa.dataset.original === texto;
  const emocao = caixa.dataset.emocao;
  esconderSugestao();
  emocaoIa(emocao);
  falar(texto, original ? "ia" : "robo");
}

// Manual <-> IA (botão no topo ou tecla I) e, dentro da IA, sugerir ou automática.
// Sempre começa em Manual: a IA nunca fala por você sem que você ligue.
let iaLigada = false, subIa = "sugerir";
try { if (localStorage.getItem("subIa") === "automatica") subIa = "automatica"; } catch (_) {}
document.querySelector(`input[name="subIa"][value="${subIa}"]`).checked = true;

function aplicarModoIa() {
  const anterior = modoIa;
  modoIa = iaLigada && iaDisponivel ? subIa : "desligada";
  if (modoIa === "desligada") cancelarIa();
  else if (anterior !== modoIa) esconderSugestao();
  $("btnModoManual").classList.toggle("ativo", modoIa === "desligada");
  $("btnModoManual").setAttribute("aria-pressed", String(modoIa === "desligada"));
  $("btnModoIa").classList.toggle("ativo", modoIa !== "desligada");
  $("btnModoIa").setAttribute("aria-pressed", String(modoIa !== "desligada"));
  const s = $("situacaoIa");
  s.className = "situacao " + (modoIa === "desligada" ? "manual" : "ia");
  s.textContent = modoIa === "desligada" ? "Manual: só você responde"
                : modoIa === "sugerir" ? "IA ligada: ela sugere e você aprova"
                : "IA ligada: o robô responde sozinho";
  if (anterior !== modoIa) log("quem responde: " + s.textContent);
}

function definirIa(ligada) {
  if (ligada && !iaDisponivel) { log("a IA não está disponível (veja o painel 'Respostas da IA')"); return; }
  iaLigada = ligada;
  aplicarModoIa();
}
function alternarIa() { definirIa(!iaLigada); }

$("btnModoManual").onclick = () => definirIa(false);
$("btnModoIa").onclick = () => definirIa(true);
for (const r of document.querySelectorAll('input[name="subIa"]')) {
  r.onchange = () => {
    subIa = r.value;
    try { localStorage.setItem("subIa", subIa); } catch (_) {}
    aplicarModoIa();
  };
}
$("btnFalarIa").onclick = falarSugestao;

function mostrarEspera() { $("esperaIaTxt").textContent = (esperaSilencio() / 1000).toFixed(1).replace(".", ",") + " s"; }
try { const v = localStorage.getItem("esperaIa"); if (v) $("esperaIa").value = v; } catch (_) {}
mostrarEspera();
$("esperaIa").oninput = () => { mostrarEspera(); try { localStorage.setItem("esperaIa", $("esperaIa").value); } catch (_) {} };

// ---- áudio do cliente (audio_cliente.js)
// (a chave "audioCliente2" é nova de propósito: descarta o ajuste antigo, que cortava demais)
const CHAVE_AUDIO = "audioCliente2";
function lerOpcoesAudio() {
  return {
    reducao: $("chkReducao").checked, portao: $("chkPortao").checked, realce: $("chkRealce").checked,
    abafarEco: $("chkAbafarEco").checked, volume: Number($("volumeCliente").value) / 100,
  };
}
function ajustarAudioCliente() {
  const o = lerOpcoesAudio();
  const perfil = Object.keys(AudioCliente.PERFIS).find((k) => {
    const p = AudioCliente.PERFIS[k];
    return p.reducao === o.reducao && p.portao === o.portao && p.realce === o.realce;
  });
  $("perfilAudio").value = perfil || "personalizado";
  AudioCliente.ajustar(o);
  try { localStorage.setItem(CHAVE_AUDIO, JSON.stringify(o)); } catch (_) {}
  mostrarEstadoAudio();
}
function escolherPerfil() {
  const p = AudioCliente.PERFIS[$("perfilAudio").value];
  if (!p) return;
  $("chkReducao").checked = p.reducao; $("chkPortao").checked = p.portao; $("chkRealce").checked = p.realce;
  ajustarAudioCliente();
}
function mostrarEstadoAudio() {
  const e = $("estadoAudio");
  e.classList.remove("erro");
  if (!AudioCliente.estado.pronto) return;
  e.textContent = "tratamento ligado; RNNoise: " + AudioCliente.estado.rnnoise;
  if (AudioCliente.estado.rnnoise.startsWith("indispon")) e.classList.add("erro");
}
AudioCliente.estado.aoMudar = mostrarEstadoAudio;
try {
  const salvo = JSON.parse(localStorage.getItem(CHAVE_AUDIO) || "null");
  if (salvo) {
    $("chkReducao").checked = !!salvo.reducao; $("chkPortao").checked = !!salvo.portao;
    $("chkRealce").checked = !!salvo.realce; $("chkAbafarEco").checked = salvo.abafarEco !== false;
    if (salvo.volume) $("volumeCliente").value = Math.round(salvo.volume * 100);
  }
} catch (_) {}
for (const id of ["chkReducao", "chkPortao", "chkRealce", "chkAbafarEco"]) $(id).onchange = ajustarAudioCliente;
$("volumeCliente").oninput = ajustarAudioCliente;
$("perfilAudio").onchange = escolherPerfil;

function baixar(blob, nome) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$("btnGravarAudio").onclick = async () => {
  const b = $("btnGravarAudio");
  if (b.disabled) return;
  b.disabled = true;
  b.textContent = "Gravando 10 s… peça para o cliente falar normalmente";
  try {
    const { original, tratado } = await AudioCliente.gravar(10);
    const quando = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    baixar(original, `cliente-original-${quando}.wav`);
    baixar(tratado, `cliente-tratado-${quando}.wav`);
    log("gravação salva (original e tratado). " + $("redeAudio").textContent);
  } catch (e) { log("não deu para gravar: " + e.message); }
  b.disabled = false;
  b.textContent = "Gravar 10 s para análise (antes/depois)";
};

// ---- qualidade da rede no áudio que chega do cliente (a cada 2 s)
// "reconstruído" = pedaços do áudio que se perderam e o navegador inventou para tapar o buraco:
// é isso que deixa a voz robótica e picotada. Acima de ~3% o problema é a rede, não o tratamento.
let statsAudioAnt = null;
setInterval(async () => {
  const alvo = $("redeAudio"), dica = $("dicaRede");
  if (!pc || pc.connectionState !== "connected") {
    statsAudioAnt = null; alvo.textContent = "—"; alvo.className = ""; dica.classList.add("oculto");
    return;
  }
  let a = null;
  try { (await pc.getStats()).forEach((r) => { if (r.type === "inbound-rtp" && r.kind === "audio") a = r; }); }
  catch (_) { return; }
  if (!a) return;
  const ant = statsAudioAnt;
  statsAudioAnt = { t: performance.now(), packetsReceived: a.packetsReceived || 0, packetsLost: a.packetsLost || 0,
                    totalSamplesReceived: a.totalSamplesReceived || 0, concealedSamples: a.concealedSamples || 0,
                    bytesReceived: a.bytesReceived || 0 };
  if (!ant) return;
  const recebidos = statsAudioAnt.packetsReceived - ant.packetsReceived;
  const perdidos = Math.max(0, statsAudioAnt.packetsLost - ant.packetsLost);
  const perda = recebidos + perdidos > 0 ? perdidos / (recebidos + perdidos) : 0;
  const amostras = statsAudioAnt.totalSamplesReceived - ant.totalSamplesReceived;
  const reconstruido = amostras > 0 ? Math.max(0, statsAudioAnt.concealedSamples - ant.concealedSamples) / amostras : 0;
  const kbps = ((statsAudioAnt.bytesReceived - ant.bytesReceived) * 8) / (statsAudioAnt.t - ant.t);
  const pct = (x) => (x * 100).toFixed(x < 0.1 ? 1 : 0) + "%";
  alvo.textContent = `perda ${pct(perda)} · reconstruído ${pct(reconstruido)} · jitter ${Math.round((a.jitter || 0) * 1000)} ms · ${Math.round(kbps)} kbit/s`;
  const nivelRede = reconstruido > 0.05 || perda > 0.03 ? "ruim" : reconstruido > 0.015 || perda > 0.01 ? "aviso" : "ok";
  alvo.className = nivelRede;
  if (nivelRede === "ok") dica.classList.add("oculto");
  else {
    dica.className = "dica " + nivelRede;
    dica.textContent = "A REDE está estragando o áudio (é isso que deixa a voz robótica e picotada). Aproxime os " +
      "computadores do roteador, use cabo de rede, prefira Wi-Fi 5 GHz e feche downloads/vídeos. Se não der, use -Internet.";
  }
}, 2000);

$("btnDescartarIa").onclick = esconderSugestao;
$("textoIa").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); falarSugestao(); }
});

// ---------------------------------------------------------------- visão do robô (câmera do cliente)
// ator/visao.js detecta rostos no vídeo do cliente, aqui no navegador. Com isso o robô:
//  - move os olhos na direção da pessoa (mensagem "olhar" para a tela do robô);
//  - sorri de volta quando a pessoa sorri e se espanta junto quando ela se surpreende;
//  - com a IA ligada, cumprimenta quem acabou de aparecer na frente da câmera;
//  - manda à IA uma foto do momento e um resumo ("1 pessoa, perto, sorrindo") a cada pergunta,
//    para ela poder responder "o que você está vendo?", "de que cor é minha blusa?" etc.
let olharEnviado = null, ultimoOlhar = 0, ultimaReacao = 0, sorrisoDesde = 0, surpresaDesde = 0;
let ultimoCumprimento = -Infinity, ultimaInfo = 0;

function extrasVisao() {
  const extras = { visao: Visao.descrever() };
  if ($("chkIaVe").checked) {
    const foto = Visao.foto();
    if (foto) extras.imagem = foto;
  }
  return extras;
}

function reagirRosto(nome, intensidade) {
  ultimaReacao = performance.now();
  enviarCanal({ t: "expressao", nome, intensidade, fixar: false, origem: "camera" });
}

function aoVisaoAtualizar(e) {
  Visao.desenhar($("camadaVisao"));
  const agora = performance.now();
  if (agora - ultimaInfo > 400) { ultimaInfo = agora; $("infoVisao").textContent = Visao.descrever() || "—"; }
  if (!canal) return;

  // olhar: imagem da câmera sem espelhar -> pessoa à esquerda da imagem fica à DIREITA de quem olha a tela
  if ($("chkOlhar").checked && e.pessoas > 0) {
    if (agora - ultimoOlhar > 150) {
      ultimoOlhar = agora;
      const x = Math.max(-1, Math.min(1, (0.5 - e.x) * 2.2));
      const y = Math.max(-1, Math.min(1, (e.y - 0.45) * 2));
      enviarCanal({ t: "olhar", x: +x.toFixed(3), y: +y.toFixed(3) });
      olharEnviado = true;
    }
  } else if (olharEnviado) {
    enviarCanal({ t: "olhar", x: null });            // volta a olhar em volta sozinho
    olharEnviado = null;
  }

  // espelhar o rosto da pessoa (no máximo uma reação a cada 7 s)
  if ($("chkEspelhar").checked && e.presente) {
    sorrisoDesde = e.sorriso > 0.55 ? (sorrisoDesde || agora) : 0;
    surpresaDesde = e.surpresa > 0.55 ? (surpresaDesde || agora) : 0;
    if (agora - ultimaReacao > 7000) {
      if (sorrisoDesde && agora - sorrisoDesde > 700) reagirRosto("feliz", 0.75);
      else if (surpresaDesde && agora - surpresaDesde > 500) reagirRosto("surpreso", 0.7);
    }
  }
}

function aoVisaoEvento(tipo, e) {
  if (!pc) return;                                   // só durante uma conversa
  if (tipo === "chegou") {
    registrar("sistema", e.pessoas > 1 ? `— ${e.pessoas} pessoas apareceram na câmera —` : "— uma pessoa apareceu na câmera —");
    if ($("chkCumprimentar").checked && modoIa !== "desligada" && performance.now() - ultimoCumprimento > 60000 &&
        vezLivre(performance.now()) && !bufferIa.length && !pedindo) {
      ultimoCumprimento = performance.now();
      pedirIaEvento("Uma pessoa acabou de aparecer na frente do robô. Cumprimente com uma frase curta e simpática " +
                    "e, se fizer sentido, comente algo que você vê.", false);
    }
  } else if (tipo === "saiu") {
    registrar("sistema", "— a pessoa saiu da frente da câmera —");
  }
}

// Pedido à IA que não é fala do cliente (cumprimento, "o que você vê").
// sugerirSempre: mostra no quadro de sugestão mesmo com a IA em Manual ou Automática.
async function pedirIaEvento(texto, sugerirSempre) {
  if (!iaDisponivel) { log("a IA não está disponível (veja o painel 'Respostas da IA')"); return; }
  if (!sugerirSempre && modoIa === "desligada") return;
  cancelarIa();
  const meu = seqIa, inicio = performance.now();
  estadoIa("olhando…");
  try {
    const r = await chamarIa("responder", Object.assign({ texto, evento: true, historico: conversaIa.slice(-10) }, extrasVisao()));
    if (meu !== seqIa) return;
    estadoIa(`resposta em ${r.ms} ms`);
    if (!sugerirSempre && modoIa === "automatica") pendente = { r, inicio, seq: seqIa, ate: performance.now() + 8000 };
    else mostrarSugestao(r);
  } catch (e) {
    if (meu !== seqIa) return;
    estadoIa("a IA falhou: " + (e.name === "AbortError" ? "demorou demais" : e.message), true);
    log("IA: " + e.message);
  }
}

function perguntarOQueVe() {
  if (!$("videoCliente").videoWidth) { log("ainda não há vídeo do cliente"); return; }
  pedirIaEvento("Descreva em até duas frases curtas o que você vê na câmera agora: a pessoa (sem tentar dizer " +
                "quem ela é) e o ambiente.", true);
}
$("btnOQueVe").onclick = perguntarOQueVe;
$("chkOlhar").onchange = () => { if (!$("chkOlhar").checked && olharEnviado) { enviarCanal({ t: "olhar", x: null }); olharEnviado = null; } };

async function iniciarVisao() {
  const e = $("estadoVisao");
  e.classList.remove("erro");
  e.textContent = "carregando a detecção de rosto…";
  try {
    const origem = await Visao.iniciar($("videoCliente"), { atualizar: aoVisaoAtualizar, evento: aoVisaoEvento });
    e.textContent = `detecção de rosto ligada (${origem})`;
  } catch (erro) {
    e.textContent = "detecção de rosto indisponível (sem internet e sem a pasta ator/vendor; rode o preparar_portatil.bat). " +
                    "A IA ainda recebe a foto da câmera.";
    e.classList.add("erro");
    log("visão: " + (erro && erro.message ? erro.message : erro));
  }
}

// ---------------------------------------------------------------- começar
$("btnComecar").onclick = async () => {
  const digitado = $("token").value.trim();
  if (digitado) sessionStorage.setItem("token", digitado);
  if (!sessionStorage.getItem("token")) { $("avisoInicio").textContent = "Falta o código: abra o link de ATOR completo."; return; }
  if (ctx.state === "suspended") await ctx.resume();
  if (!(await prepararMicrofone())) return;
  try { await AudioCliente.preparar(); ajustarAudioCliente(); }
  catch (e) {
    $("estadoAudio").textContent = "tratamento do áudio indisponível neste navegador; o som vai direto";
    $("estadoAudio").classList.add("erro");
    log("áudio do cliente: " + e.message);
  }
  $("inicio").classList.add("oculto");
  usuarioSaiu = false;
  conectarWs();
  if (!Visao.estado.pronta) iniciarVisao();
};

window.addEventListener("beforeunload", () => { usuarioSaiu = true; });

try {
  const doLink = new URLSearchParams(location.search).get("token");
  if (doLink) { sessionStorage.setItem("token", doLink); history.replaceState(null, "", location.pathname); }
} catch (_) {}
if (sessionStorage.getItem("token")) $("token").classList.add("oculto");
