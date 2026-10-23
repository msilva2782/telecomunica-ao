"use strict";
// Interface do operador: sinalização por WebSocket + WebRTC (recebe vídeo/áudio do robô,
// envia o microfone do operador). Reconecta sozinha e retoma a sessão se ela estava ativa.

const $ = (id) => document.getElementById(id);
const META_MS = 300;

let ws = null;
let pc = null;
let canal = null;
let micStream = null;
let remoto = null;              // MediaStream com as faixas do robô
let sessaoDesejada = false;     // o operador quer a sessão ligada (retoma após quedas)
let tentativas = 0;
let timerWs = null;
let timerSessao = null;
let timerPing = null;
let ultimoPong = 0;
let roboPresente = false;
let usuarioSaiu = false;
let iceServers = [];            // enviado pelo servidor (STUN/TURN)
let timerKeepalive = null;
let clientePresente = false;    // atendimento a clientes
let pedidoPendente = false;
let emUsoPor = null;            // "operador" | "cliente" | null
let offsetRelogio = null;       // relógio do robô - relógio local (ms), estimado pelo ping
let melhorRtt = Infinity;       // RTT da amostra usada na estimativa acima
let timerStats = null;
let statsAnteriores = null;     // contadores da leitura anterior do getStats

// ---------- utilidades de interface ----------
function log(texto) {
  const l = $("log");
  const hora = new Date().toLocaleTimeString();
  l.textContent += `[${hora}] ${texto}\n`;
  l.scrollTop = l.scrollHeight;
}

function selo(id, texto, classe) {
  const e = $(id);
  e.textContent = texto;
  e.className = "selo " + classe;
}

function atualizarBotoes() {
  const servidorOk = ws && ws.readyState === WebSocket.OPEN;
  $("btnIniciar").disabled = !(servidorOk && roboPresente) || sessaoDesejada || emUsoPor === "cliente";
  $("btnEncerrar").disabled = !sessaoDesejada;
}

function mostrarMs(id, ms) {
  const e = $(id);
  if (ms == null) { e.textContent = "—"; e.className = "valor"; return; }
  e.textContent = ms.toFixed(0);
  e.className = "valor " + (ms < META_MS ? "ok" : ms < META_MS * 1.5 ? "aviso" : "ruim");
}

function mostrarLatencia(ms) { mostrarMs("latencia", ms); }

// ---------- sinalização ----------
function enviar(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function conectarWs() {
  clearTimeout(timerWs);
  const token = sessionStorage.getItem("token") || "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  selo("stServidor", "conectando…", "aviso");

  ws.onopen = () => {
    tentativas = 0;
    clearInterval(timerKeepalive);
    timerKeepalive = setInterval(() => enviar({ tipo: "ping" }), 25000);
    selo("stServidor", "conectado", "ok");
    log("conectado ao servidor");
    atualizarBotoes();
  };
  ws.onmessage = (ev) => tratarMensagem(JSON.parse(ev.data)).catch((e) => log("erro: " + e));
  ws.onclose = (ev) => {
    clearInterval(timerKeepalive);
    clientePresente = false;
    pedidoPendente = false;
    atualizarAtendimento(null);
    selo("stServidor", "desconectado", "ruim");
    roboPresente = false;
    selo("stRobo", "ausente", "ruim");
    fecharPc();
    atualizarBotoes();
    if (usuarioSaiu) return;
    if (ev.code === 4401) {
      log("token recusado pelo servidor");
      sessaoDesejada = false;
      atualizarBotoes();
      return;
    }
    if (ev.code === 4000) {   // outra janela/programa entrou como operador: não disputa a vaga
      log("o operador foi aberto em outra janela; esta parou. Clique em Entrar para assumir de novo.");
      selo("stServidor", "em outra janela", "aviso");
      sessaoDesejada = false;
      atualizarBotoes();
      return;
    }
    const espera = Math.min(1000 * 2 ** tentativas++, 10000);
    log(`servidor indisponível; nova tentativa em ${(espera / 1000).toFixed(0)}s`);
    timerWs = setTimeout(conectarWs, espera);
  };
  ws.onerror = () => {};
}

async function tratarMensagem(msg) {
  switch (msg.tipo) {
    case "config":
      iceServers = msg.ice || [];
      break;
    case "pong":
      break;
    case "presenca":
      const roboVoltou = msg.robo && !roboPresente;   // só a transição ausente -> online
      roboPresente = msg.robo;
      selo("stRobo", roboPresente ? "online" : "ausente", roboPresente ? "ok" : "ruim");
      clientePresente = !!msg.cliente;
      pedidoPendente = !!msg.pedido;
      atualizarAtendimento(msg.em_uso_por || null);
      // retoma a sessão automaticamente quando o robô volta
      if (roboVoltou && sessaoDesejada && !pc) pedirInicio();
      atualizarBotoes();
      break;
    case "offer":
      await tratarOferta(msg.sdp);
      break;
    case "ice":
      if (pc && msg.candidato && msg.candidato.candidate) {
        await pc.addIceCandidate(msg.candidato).catch((e) => log("ICE ignorado: " + e));
      }
      break;
    case "encerrar":
      log("robô encerrou a sessão (" + (msg.motivo || "-") + ")");
      fecharPc();
      if (sessaoDesejada && roboPresente) agendarReinicio(1500);
      break;
    case "status":
      if (msg.estado === "falhou") {
        log("robô reportou falha de conexão");
        fecharPc();
        if (sessaoDesejada) agendarReinicio(1500);
      }
      break;
    case "pedido":
      log("um cliente solicitou atendimento");
      avisoSonoro();
      break;
    case "pedido_cancelado":
      log("pedido de atendimento cancelado (" + (msg.motivo || "-") + ")");
      break;
    case "chat":
      chatAtendimento(msg.de === "cliente" ? "cliente: " + msg.texto : "robô: " + msg.texto,
                      msg.de === "cliente" ? "cli" : "robo");
      break;
    case "atendimento_fim":
      log("atendimento encerrado (" + (msg.motivo || "-") + ")");
      chatAtendimento("— atendimento encerrado (" + (msg.motivo || "-") + ") —", "sis");
      break;
    case "erro":
      log("servidor: " + msg.motivo);
      if (msg.motivo === "robo_em_uso" && sessaoDesejada) {
        sessaoDesejada = false;
        selo("stConexao", "robô em uso", "aviso");
        atualizarBotoes();
      }
      if (msg.motivo === "robo_ausente" && sessaoDesejada) selo("stConexao", "aguardando robô", "aviso");
      break;
  }
}

function pedirInicio() {
  selo("stConexao", "negociando…", "aviso");
  enviar({ tipo: "iniciar" });
}

function agendarReinicio(ms) {
  clearTimeout(timerSessao);
  timerSessao = setTimeout(() => { if (sessaoDesejada && !pc) pedirInicio(); }, ms);
}

// ---------- WebRTC ----------
async function garantirMicrofone() {
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }, video: false,
    });
    medirNivel(micStream, "nivelMic");
  } catch (e) {
    log("microfone indisponível (" + e.name + "); seguirá apenas recebendo");
    micStream = null;
  }
}

async function tratarOferta(sdp) {
  fecharPc();
  pc = new RTCPeerConnection({ iceServers });
  remoto = new MediaStream();
  $("video").srcObject = remoto;

  pc.ontrack = (ev) => {
    remoto.addTrack(ev.track);
    if (ev.track.kind === "video") {
      $("semVideo").classList.add("oculto");
      lerMarcaDeTempo(pc);
    } else {
      medirNivel(new MediaStream([ev.track]), "nivelRobo");
    }
  };
  pc.onicecandidate = (ev) => enviar({ tipo: "ice", candidato: ev.candidate ? ev.candidate.toJSON() : null });
  pc.ondatachannel = (ev) => configurarCanal(ev.channel);
  pc.onconnectionstatechange = () => {
    const s = pc ? pc.connectionState : "closed";
    log("conexão: " + s);
    if (s === "connected") {
      selo("stConexao", "conectado", "ok");
      clearInterval(timerStats);
      timerStats = setInterval(lerEstatisticas, 1000);
    }
    else if (s === "connecting") selo("stConexao", "conectando…", "aviso");
    else if (s === "disconnected") selo("stConexao", "instável", "aviso");
    else if (s === "failed") {
      selo("stConexao", "falhou", "ruim");
      fecharPc();
      enviar({ tipo: "encerrar", motivo: "falha_ice" });
      if (sessaoDesejada) agendarReinicio(1500);
    }
  };

  await pc.setRemoteDescription({ type: "offer", sdp });
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track.kind === "video") {
      t.direction = "recvonly";
    } else if (t.receiver.track.kind === "audio") {
      t.direction = micStream ? "sendrecv" : "recvonly";
      if (micStream) await t.sender.replaceTrack(micStream.getAudioTracks()[0]);
    }
  }
  const resposta = await pc.createAnswer();
  await pc.setLocalDescription(resposta);
  enviar({ tipo: "answer", sdp: pc.localDescription.sdp });
}

function configurarCanal(c) {
  canal = c;
  c.onopen = () => {
    termHabilitar(true);
    if ($("termSaida").childNodes.length) termEscrever("— nova sessão —", "sis");
    termEscrever("conectado ao robô. Digite 'ajuda' para ver os comandos.", "sis");
    clearInterval(timerPing);
    ultimoPong = performance.now();
    timerPing = setInterval(() => {
      if (c.readyState === "open") c.send(JSON.stringify({ t: "ping", ts: performance.now(), tw: Date.now() }));
      if (performance.now() - ultimoPong > 3000) mostrarLatencia(null);
      // janela minimizada/oculta não desenha quadros: não deixa um valor velho na tela
      if (performance.now() - ultimaAmostraAtraso > 3000) mostrarMs("atrasoVideo", null);
    }, 500);
  };
  c.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === "pong") {
      ultimoPong = performance.now();
      const rtt = performance.now() - m.ts;
      mostrarLatencia(rtt);
      // diferença entre relógios (como no NTP): vale a amostra de menor RTT; erro máximo = RTT/2
      if (typeof m.agora === "number" && typeof m.tw === "number" && rtt <= melhorRtt) {
        melhorRtt = rtt;
        offsetRelogio = m.agora - (m.tw + Date.now()) / 2;
      }
    } else if (m.t === "chat") {
      termEscrever("robô: " + String(m.texto), "robo");
    }
  };
  c.onclose = () => {
    clearInterval(timerPing);
    termHabilitar(false);
  };
}

// ---------- terminal de conversa com o robô ----------
const historico = [];
let posHistorico = 0;

function termEscrever(texto, classe) {
  const saida = $("termSaida");
  const linha = document.createElement("div");
  linha.className = "lin " + classe;
  linha.textContent = texto;   // textContent: nunca interpreta HTML
  saida.appendChild(linha);
  while (saida.childNodes.length > 500) saida.removeChild(saida.firstChild);
  saida.scrollTop = saida.scrollHeight;
}

function termHabilitar(ativo) {
  const campo = $("termEntrada");
  campo.disabled = !ativo;
  campo.placeholder = ativo ? "Digite uma mensagem ou 'ajuda'" : "Inicie a sessão para conversar com o robô";
  if (ativo) campo.focus();
}

$("termForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const campo = $("termEntrada");
  const texto = campo.value.trim();
  if (!texto) return;
  if (!canal || canal.readyState !== "open") {
    termEscrever("sem conexão com o robô", "sis");
    return;
  }
  canal.send(JSON.stringify({ t: "chat", texto }));
  termEscrever("> " + texto, "eu");
  historico.push(texto);
  posHistorico = historico.length;
  campo.value = "";
});

$("termEntrada").addEventListener("keydown", (ev) => {
  if (ev.key === "ArrowUp" && posHistorico > 0) {
    ev.preventDefault();
    $("termEntrada").value = historico[--posHistorico];
  } else if (ev.key === "ArrowDown") {
    ev.preventDefault();
    posHistorico = Math.min(posHistorico + 1, historico.length);
    $("termEntrada").value = historico[posHistorico] || "";
  }
});

function fecharPc() {
  clearInterval(timerPing);
  clearInterval(timerStats);
  statsAnteriores = null;
  offsetRelogio = null;
  melhorRtt = Infinity;
  mostrarLatencia(null);
  mostrarMs("atrasoVideo", null);
  for (const id of ["mFps", "mPerda", "mJitter", "mBuffer"]) metrica(id, "—");
  termHabilitar(false);
  if (canal) { try { canal.close(); } catch (_) {} canal = null; }
  if (pc) {
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch (_) {}
    pc = null;
  }
  $("video").srcObject = null;
  $("semVideo").classList.remove("oculto");
  $("nivelRobo").style.width = "0%";
  selo("stConexao", sessaoDesejada ? "aguardando…" : "sem sessão", sessaoDesejada ? "aviso" : "neutro");
}

// ---------- atraso do vídeo (captura no robô -> tela) ----------
// Com MARCAR_TIMESTAMP=1 o robô grava a hora da captura nos pixels da primeira linha
// (56 blocos de 10 px: 48 bits de ms + 8 de verificação, ver comum/marca.py).
const MARCA_BITS = 56, MARCA_BLOCO = 10;
const telaMarca = document.createElement("canvas");
telaMarca.width = MARCA_BITS * MARCA_BLOCO;
telaMarca.height = MARCA_BLOCO;
const ctxMarca = telaMarca.getContext("2d", { willReadFrequently: true });
let amostrasAtraso = [];
let ultimaAmostraAtraso = 0;    // performance.now() da última leitura

function lerMarca(video) {
  if (video.videoWidth < telaMarca.width || video.videoHeight < MARCA_BLOCO) return null;
  ctxMarca.drawImage(video, 0, 0, telaMarca.width, MARCA_BLOCO, 0, 0, telaMarca.width, MARCA_BLOCO);
  const px = ctxMarca.getImageData(0, MARCA_BLOCO / 2, telaMarca.width, 1).data;
  let ts = 0, ck = 0;
  for (let i = 0; i < MARCA_BITS; i++) {
    const x = i * MARCA_BLOCO + MARCA_BLOCO / 2;
    const bit = (px[x * 4] + px[x * 4 + 1] + px[x * 4 + 2]) / 3 > 127 ? 1 : 0;
    if (i < 48) ts = ts * 2 + bit; else ck = ck * 2 + bit;
  }
  return ts > 0 && ts % 251 === ck ? ts : null;
}

function lerMarcaDeTempo(pcDaSessao) {
  const video = $("video");
  if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) {
    $("dicaAtraso").textContent = "Meta: abaixo de 300 ms. Este navegador não informa o atraso do vídeo.";
    return;
  }
  amostrasAtraso = [];
  const aoQuadro = () => {
    if (pc !== pcDaSessao) return;          // sessão terminou: para de ler
    const ts = lerMarca(video);
    if (ts !== null && offsetRelogio !== null) {
      if (performance.now() - ultimaAmostraAtraso > 3000) amostrasAtraso = [];  // voltou de uma pausa
      ultimaAmostraAtraso = performance.now();
      // idade = agora (relógio local) - captura (relógio do robô convertido para o local)
      amostrasAtraso.push(Date.now() - (ts - offsetRelogio));
      if (amostrasAtraso.length > 10) amostrasAtraso.shift();
      const ordenadas = [...amostrasAtraso].sort((a, b) => a - b);
      mostrarMs("atrasoVideo", Math.max(0, ordenadas[Math.floor(ordenadas.length / 2)]));
    }
    video.requestVideoFrameCallback(aoQuadro);
  };
  video.requestVideoFrameCallback(aoQuadro);
}

// ---------- qualidade: FPS, perda de pacotes, jitter, buffer ----------
function metrica(id, texto, classe) {
  $(id).textContent = texto;
  $(id).className = classe || "";
}

async function lerEstatisticas() {
  if (!pc) return;
  let relatorio;
  try { relatorio = await pc.getStats(); } catch (_) { return; }
  const atual = { recebidos: 0, perdidos: 0, atrasoBuffer: 0, emitidos: 0 };
  let fps = null, jitterAudio = null;
  relatorio.forEach((r) => {
    if (r.type !== "inbound-rtp") return;
    atual.recebidos += r.packetsReceived || 0;
    atual.perdidos += Math.max(0, r.packetsLost || 0);
    if (r.kind === "video") {
      fps = r.framesPerSecond ?? null;
      atual.atrasoBuffer += r.jitterBufferDelay || 0;
      atual.emitidos += r.jitterBufferEmittedCount || 0;
    } else if (r.kind === "audio" && r.jitter != null) {
      jitterAudio = r.jitter * 1000;
    }
  });
  const ant = statsAnteriores || { recebidos: 0, perdidos: 0, atrasoBuffer: 0, emitidos: 0 };
  statsAnteriores = atual;

  metrica("mFps", fps != null ? fps.toFixed(1) + " FPS" : "—", fps != null && fps < 4 ? "aviso" : "");
  const rec = atual.recebidos - ant.recebidos, perd = atual.perdidos - ant.perdidos;
  if (rec + perd > 0) {
    const pct = 100 * perd / (rec + perd);
    metrica("mPerda", pct.toFixed(1) + "%", pct >= 5 ? "ruim" : pct >= 1 ? "aviso" : "");
  }
  metrica("mJitter", jitterAudio != null ? jitterAudio.toFixed(0) + " ms" : "—",
          jitterAudio != null && jitterAudio > 50 ? "aviso" : "");
  const emit = atual.emitidos - ant.emitidos;
  if (emit > 0) {
    const ms = 1000 * (atual.atrasoBuffer - ant.atrasoBuffer) / emit;
    metrica("mBuffer", ms.toFixed(0) + " ms", ms > 150 ? "aviso" : "");
  }
}

// ---------- indicadores de áudio ----------
const ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
const medidores = {};

function medirNivel(stream, idBarra) {
  if (medidores[idBarra]) { try { medidores[idBarra].source.disconnect(); } catch (_) {} }
  if (ctxAudio.state === "suspended") ctxAudio.resume();
  const analisador = ctxAudio.createAnalyser();
  analisador.fftSize = 512;
  const source = ctxAudio.createMediaStreamSource(stream);
  source.connect(analisador);
  medidores[idBarra] = { source, analisador, buf: new Uint8Array(analisador.fftSize) };
}

function desenharNiveis() {
  for (const [id, m] of Object.entries(medidores)) {
    m.analisador.getByteTimeDomainData(m.buf);
    let soma = 0;
    for (const v of m.buf) { const x = (v - 128) / 128; soma += x * x; }
    const rms = Math.sqrt(soma / m.buf.length);
    $(id).style.width = Math.min(100, rms * 300) + "%";
  }
  requestAnimationFrame(desenharNiveis);
}

// ---------- ações do usuário ----------
$("btnEntrar").onclick = () => {
  const token = $("token").value.trim();
  if (!token) return;
  sessionStorage.setItem("token", token);
  usuarioSaiu = false;
  if (ws) { ws.onclose = null; ws.close(); }
  tentativas = 0;
  conectarWs();
};

$("btnIniciar").onclick = async () => {
  if (pedidoPendente && !confirm("Um cliente está aguardando atendimento. Iniciar a sua sessão agora " +
                                 "recusa o pedido dele. Continuar?")) return;
  sessaoDesejada = true;
  atualizarBotoes();
  await garantirMicrofone();
  pedirInicio();
};

$("btnEncerrar").onclick = () => {
  sessaoDesejada = false;
  clearTimeout(timerSessao);
  enviar({ tipo: "encerrar", motivo: "operador" });
  fecharPc();
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  $("nivelMic").style.width = "0%";
  delete medidores["nivelMic"];
  atualizarBotoes();
  log("sessão encerrada");
};

window.addEventListener("beforeunload", () => { usuarioSaiu = true; });

// ---------- atendimento a clientes ----------
function chatAtendimento(texto, classe) {
  const caixa = $("chatAtendimento");
  const linha = document.createElement("div");
  linha.className = "lin " + classe;
  linha.textContent = texto;   // textContent: nunca interpreta HTML
  caixa.appendChild(linha);
  while (caixa.childNodes.length > 300) caixa.removeChild(caixa.firstChild);
  caixa.scrollTop = caixa.scrollHeight;
}

function atualizarAtendimento(novoEmUso) {
  const antes = emUsoPor;
  emUsoPor = novoEmUso;
  if (emUsoPor === "cliente" && antes !== "cliente") {
    $("chatAtendimento").textContent = "";
    chatAtendimento("— atendimento iniciado —", "sis");
  }
  if (!clientePresente) selo("stCliente", "ausente", "ruim");
  else if (emUsoPor === "cliente") selo("stCliente", "em atendimento", "ok");
  else if (pedidoPendente) selo("stCliente", "aguardando você", "aviso");
  else selo("stCliente", "online", "neutro");
  $("caixaPedido").classList.toggle("oculto", !pedidoPendente);
  $("caixaAtendimento").classList.toggle("oculto", emUsoPor !== "cliente");
  atualizarBotoes();
}

function avisoSonoro() {
  try {
    if (ctxAudio.state === "suspended") ctxAudio.resume();
    const osc = ctxAudio.createOscillator();
    const ganho = ctxAudio.createGain();
    osc.frequency.value = 880;
    ganho.gain.setValueAtTime(0.15, ctxAudio.currentTime);
    ganho.gain.exponentialRampToValueAtTime(0.001, ctxAudio.currentTime + 0.5);
    osc.connect(ganho).connect(ctxAudio.destination);
    osc.start();
    osc.stop(ctxAudio.currentTime + 0.5);
  } catch (_) {}
}

$("btnAceitar").onclick = () => enviar({ tipo: "aceitar" });
$("btnRecusar").onclick = () => enviar({ tipo: "recusar" });
$("btnEncerrarAtendimento").onclick = () => enviar({ tipo: "encerrar_atendimento" });
$("formMensagem").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const campo = $("msgOperador");
  const texto = campo.value.trim();
  if (!texto) return;
  enviar({ tipo: "mensagem", texto });
  chatAtendimento("você (operador): " + texto, "eu");
  campo.value = "";
});

// ---------- início ----------
desenharNiveis();
// Login por link: .../operador/?token=XXXX (o token é removido da barra de endereço)
try {
  const doLink = new URLSearchParams(location.search).get("token");
  if (doLink) {
    sessionStorage.setItem("token", doLink);
    history.replaceState(null, "", location.pathname);
  }
} catch (_) {}
if (sessionStorage.getItem("token")) {
  $("token").value = sessionStorage.getItem("token");
  conectarWs();
}
