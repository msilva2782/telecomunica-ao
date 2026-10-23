"use strict";
// Página do cliente: pede atendimento; se o operador aceitar, fala com o robô por
// áudio e chat (sem vídeo). Reconecta ao servidor sozinha.

const $ = (id) => document.getElementById(id);

const TEXTOS = {
  operador_recusou: "O operador não pôde atender agora. Tente novamente em instantes.",
  operador_ausente: "Não há operador online no momento.",
  robo_ausente: "O robô está offline.",
  robo_em_uso: "O robô está em uso por outra pessoa. Tente novamente em instantes.",
  operador_encerrou: "O operador encerrou o atendimento.",
  cliente: "Atendimento encerrado.",
  robo_desconectou: "O robô desconectou.",
  operador_desconectou: "O operador desconectou.",
  falha_ice: "A conexão falhou. Tente solicitar de novo.",
  servidor: "A conexão com o servidor foi perdida. Reconectando…",
};

let ws = null, pc = null, canal = null, micStream = null;
let iceServers = [];
let estado = "login";               // login | livre | aguardando | sessao
let robo = false, operador = false, ocupado = false;
let avisoTemp = "";                 // mensagem de um evento recente (recusa, fim…)
let tentativas = 0, timerWs = null, timerKeepalive = null, usuarioSaiu = false;

// ---------- interface ----------
function selo(id, ligado) {
  const e = $(id);
  e.textContent = ligado ? "online" : "offline";
  e.className = "selo " + (ligado ? "ok" : "ruim");
}

function mensagemFixa() {
  if (estado === "aguardando") return "Aguardando o operador aceitar o seu pedido…";
  if (estado === "sessao") return "Atendimento em andamento.";
  if (!robo) return "O robô está offline no momento.";
  if (!operador) return "Nenhum operador está online no momento.";
  if (ocupado) return "O robô está em uso por outra pessoa. Aguarde um pouco.";
  return "Tudo pronto. Clique em “Solicitar atendimento”.";
}

function atualizarUI() {
  $("telaLogin").classList.toggle("oculto", estado !== "login");
  $("telaPrincipal").classList.toggle("oculto", estado === "login");
  selo("stRobo", robo);
  selo("stOperador", operador);
  const wsAberto = ws && ws.readyState === WebSocket.OPEN;
  $("btnPedir").classList.toggle("oculto", estado !== "livre" && estado !== "aguardando");
  $("btnPedir").disabled = !(estado === "livre" && wsAberto && robo && operador && !ocupado);
  $("btnCancelar").classList.toggle("oculto", estado !== "aguardando");
  $("painelSessao").classList.toggle("oculto", estado !== "sessao");
  $("mensagem").textContent = (estado === "livre" && avisoTemp) ? avisoTemp : mensagemFixa();
}

function definirEstado(novo, aviso) {
  estado = novo;
  avisoTemp = aviso || "";
  if (novo === "login") desligarCamera();   // saiu da conta: solta a câmera
  atualizarUI();
}

// ---------- sinalização ----------
function enviar(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function conectarWs() {
  clearTimeout(timerWs);
  const token = sessionStorage.getItem("token") || "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    tentativas = 0;
    clearInterval(timerKeepalive);
    timerKeepalive = setInterval(() => enviar({ tipo: "ping" }), 25000);
    if (estado === "login") definirEstado("livre");
    else atualizarUI();
  };
  ws.onmessage = (ev) => tratarMensagem(JSON.parse(ev.data)).catch((e) => console.error(e));
  ws.onclose = (ev) => {
    clearInterval(timerKeepalive);
    robo = operador = ocupado = false;
    const emAtendimento = estado === "sessao" || estado === "aguardando";
    fecharPc();
    if (usuarioSaiu) return;
    if (ev.code === 4401) {
      sessionStorage.removeItem("token");
      definirEstado("login");
      $("erroLogin").textContent = "Código de acesso inválido.";
      return;
    }
    if (ev.code === 4409) {
      definirEstado("login");
      $("erroLogin").textContent = "Já existe outro cliente em atendimento. Tente mais tarde.";
      return;
    }
    if (ev.code === 4000) {
      definirEstado("login");
      $("erroLogin").textContent = "Esta página foi aberta em outra janela.";
      return;
    }
    if (emAtendimento) definirEstado("livre", TEXTOS.servidor);
    else atualizarUI();
    const espera = Math.min(1000 * 2 ** tentativas++, 10000);
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
      robo = !!msg.robo; operador = !!msg.operador; ocupado = !!msg.ocupado;
      atualizarUI();
      break;
    case "aguardando":
      definirEstado("aguardando");
      break;
    case "aceito":
      definirEstado("sessao");
      limparTerminal();
      termEscrever("atendimento aceito; conectando ao robô…", "sis");
      if (!micStream) termEscrever("sem microfone: você poderá só ouvir o robô e usar a conversa por texto.", "sis");
      break;
    case "recusado":
      definirEstado("livre", TEXTOS[msg.motivo] || TEXTOS.operador_recusou);
      break;
    case "offer":
      if (estado === "sessao") await tratarOferta(msg.sdp);
      break;
    case "ice":
      if (pc && msg.candidato && msg.candidato.candidate) {
        await pc.addIceCandidate(msg.candidato).catch(() => {});
      }
      break;
    case "encerrar":
      encerrarLocal(TEXTOS[msg.motivo] || "Atendimento encerrado.");
      break;
    case "status":
      if (msg.estado === "falhou") encerrarLocal(TEXTOS.falha_ice);
      break;
    case "chat":
      termEscrever((msg.de === "operador" ? "operador: " : "robô: ") + String(msg.texto),
                   msg.de === "operador" ? "op" : "robo");
      break;
    case "erro":
      if (TEXTOS[msg.motivo]) definirEstado("livre", TEXTOS[msg.motivo]);
      break;
  }
}

// ---------- microfone ----------
async function garantirMicrofone() {
  if (micStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    avisoTemp = "Seu navegador não liberou o microfone neste endereço (é preciso HTTPS). " +
                "Você poderá ouvir o robô e usar a conversa por texto.";
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }, video: false,
    });
    medirNivel(micStream, "nivelMic");
  } catch (e) {
    micStream = null;
    avisoTemp = "Não consegui usar o microfone (" + e.name + "). Você poderá ouvir o robô e usar a conversa.";
  }
}

function pararMicrofone() {
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  delete medidores["nivelMic"];
  $("nivelMic").style.width = "0%";
}

// ---------- câmera do cliente (só prévia local: nada é enviado) ----------
const AVISO_CAMERA_PADRAO = "Só você vê esta imagem: ela não é enviada ao robô nem ao operador.";
const ERROS_CAMERA = {
  NotAllowedError: "A câmera está bloqueada. Libere a permissão no navegador e tente de novo.",
  NotFoundError: "Nenhuma câmera foi encontrada neste aparelho.",
  NotReadableError: "A câmera está sendo usada por outro programa. Feche-o e tente de novo.",
  OverconstrainedError: "A câmera não aceitou a configuração pedida.",
  SecurityError: "O navegador não permitiu usar a câmera nesta página.",
};
let camStream = null;

function avisoCamera(texto, erro) {
  const e = $("avisoCamera");
  e.textContent = texto || AVISO_CAMERA_PADRAO;
  e.classList.toggle("erro", !!erro);
}

function atualizarCamera() {
  $("btnCamera").textContent = camStream ? "Desligar câmera" : "Ligar câmera";
  $("semCamera").classList.toggle("oculto", !!camStream);
}

async function ligarCamera() {
  if (camStream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    avisoCamera("O navegador só libera a câmera em HTTPS (ou no próprio computador). " +
                "Abra o link seguro (https://) para usar a câmera.", true);
    return;
  }
  $("btnCamera").disabled = true;
  try {
    const fluxo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    if (estado === "login") { fluxo.getTracks().forEach((t) => t.stop()); return; }  // saiu enquanto pedia
    camStream = fluxo;
    fluxo.getVideoTracks()[0].onended = () => desligarCamera("A câmera foi desconectada.", true);
    const v = $("minhaCamera");
    v.srcObject = fluxo;
    v.play().catch(() => {});
    avisoCamera();
  } catch (e) {
    camStream = null;
    avisoCamera(ERROS_CAMERA[e.name] || "Não consegui abrir a câmera (" + e.name + ").", true);
  } finally {
    $("btnCamera").disabled = false;
    atualizarCamera();
  }
}

function desligarCamera(aviso, erro) {
  if (camStream) { camStream.getTracks().forEach((t) => { t.onended = null; t.stop(); }); camStream = null; }
  $("minhaCamera").srcObject = null;
  avisoCamera(aviso, erro);
  atualizarCamera();
}

$("btnCamera").onclick = () => { if (camStream) desligarCamera(); else ligarCamera(); };

// ---------- WebRTC ----------
async function tratarOferta(sdp) {
  fecharPc();
  pc = new RTCPeerConnection({ iceServers });
  pc.ontrack = (ev) => {
    if (ev.track.kind !== "audio") return;
    const fluxo = new MediaStream([ev.track]);
    $("audioRobo").srcObject = fluxo;
    $("audioRobo").play().catch(() => {});
    medirNivel(fluxo, "nivelRobo");
  };
  pc.onicecandidate = (ev) => enviar({ tipo: "ice", candidato: ev.candidate ? ev.candidate.toJSON() : null });
  pc.ondatachannel = (ev) => configurarCanal(ev.channel);
  pc.onconnectionstatechange = () => {
    const s = pc ? pc.connectionState : "closed";
    if (s === "connected") termEscrever("conectado. Você já pode falar com o robô.", "sis");
    else if (s === "disconnected") termEscrever("conexão instável…", "sis");
    else if (s === "failed") {
      enviar({ tipo: "encerrar" });
      encerrarLocal(TEXTOS.falha_ice);
    }
  };

  await pc.setRemoteDescription({ type: "offer", sdp });
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track.kind !== "audio") continue;
    t.direction = micStream ? "sendrecv" : "recvonly";
    if (micStream) await t.sender.replaceTrack(micStream.getAudioTracks()[0]);
  }
  await pc.setLocalDescription(await pc.createAnswer());
  enviar({ tipo: "answer", sdp: pc.localDescription.sdp });
  $("btnMudo").disabled = !micStream;
}

function configurarCanal(c) {
  canal = c;
  c.onopen = () => {
    const campo = $("termEntrada");
    campo.disabled = false;
    campo.placeholder = "Digite uma mensagem ou “ajuda”";
    campo.focus();
  };
  c.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.t === "chat") termEscrever("robô: " + String(m.texto), "robo");
  };
  c.onclose = () => {
    $("termEntrada").disabled = true;
    $("termEntrada").placeholder = "Aguardando conexão…";
  };
}

function fecharPc() {
  if (canal) { try { canal.close(); } catch (_) {} canal = null; }
  if (pc) {
    pc.onconnectionstatechange = null;
    try { pc.close(); } catch (_) {}
    pc = null;
  }
  $("audioRobo").srcObject = null;
  delete medidores["nivelRobo"];
  $("nivelRobo").style.width = "0%";
  $("termEntrada").disabled = true;
  $("btnMudo").disabled = true;
}

function encerrarLocal(aviso) {
  fecharPc();
  pararMicrofone();
  $("btnMudo").textContent = "Silenciar microfone";
  definirEstado("livre", aviso);
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
    $(id).style.width = Math.min(100, Math.sqrt(soma / m.buf.length) * 300) + "%";
  }
  requestAnimationFrame(desenharNiveis);
}

// ---------- terminal ----------
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

function limparTerminal() { $("termSaida").textContent = ""; }

$("termForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const campo = $("termEntrada");
  const texto = campo.value.trim();
  if (!texto) return;
  if (!canal || canal.readyState !== "open") { termEscrever("sem conexão com o robô", "sis"); return; }
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

// ---------- ações ----------
$("formLogin").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const token = $("token").value.trim();
  if (!token) return;
  $("erroLogin").textContent = "";
  sessionStorage.setItem("token", token);
  usuarioSaiu = false;
  if (ws) { ws.onclose = null; ws.close(); }
  tentativas = 0;
  conectarWs();
});

$("btnPedir").onclick = async () => {
  avisoTemp = "";
  $("btnPedir").disabled = true;
  await garantirMicrofone();   // precisa do clique para o navegador permitir
  if (ctxAudio.state === "suspended") ctxAudio.resume();
  enviar({ tipo: "pedir" });
  atualizarUI();
};

$("btnCancelar").onclick = () => {
  enviar({ tipo: "cancelar" });
  pararMicrofone();
  definirEstado("livre");
};

$("btnEncerrar").onclick = () => {
  enviar({ tipo: "encerrar" });
  encerrarLocal("Atendimento encerrado.");
};

$("btnMudo").onclick = () => {
  if (!micStream) return;
  const track = micStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $("btnMudo").textContent = track.enabled ? "Silenciar microfone" : "Ativar microfone";
};

window.addEventListener("beforeunload", () => { usuarioSaiu = true; });

// ---------- início ----------
desenharNiveis();
try {   // login por link: .../cliente/?token=XXXX (o token sai da barra de endereço)
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
atualizarUI();
