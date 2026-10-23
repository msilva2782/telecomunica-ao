"use strict";
// Visão do robô (modo ator): analisa o vídeo do cliente AQUI, no navegador do ator.
//  - Detecta rostos com o MediaPipe Face Landmarker (Google, roda no próprio navegador, sem enviar
//    imagem para lugar nenhum): quantas pessoas, onde estão, distância, sorriso e surpresa.
//  - Avisa quando alguém chega ou sai da frente da câmera.
//  - Tira uma foto (JPEG pequeno) para a IA descrever o ambiente quando ela for responder.
// Ele NÃO reconhece quem a pessoa é: só detecta que há um rosto e a expressão dele.
//
// Os arquivos do MediaPipe são procurados primeiro na pasta ator/vendor (o preparar_portatil.bat
// baixa para lá, e então funciona sem internet) e, se não estiverem lá, na internet (CDN).

const Visao = (() => {
  const VERSAO_MP = "0.10.14";
  const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSAO_MP}`;
  const FONTES = [
    { nome: "local", lib: "/ator/vendor/vision_bundle.mjs", wasm: "/ator/vendor/wasm",
      modelo: "/ator/vendor/face_landmarker.task" },
    { nome: "internet", lib: `${CDN}/vision_bundle.mjs`, wasm: `${CDN}/wasm`,
      modelo: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task" },
  ];
  const INTERVALO_MS = 200;          // 5 análises por segundo: leve, sobra processador para o áudio
  const CHEGOU_QUADROS = 4;          // rosto visto em 4 análises seguidas = pessoa chegou
  const SAIU_MS = 2500;              // sem rosto por 2,5 s = pessoa saiu

  let detector = null, video = null, timer = null, ultimoTs = 0;
  let aoAtualizar = () => {}, aoEvento = () => {};
  let seguidos = 0, ultimoVisto = 0;
  const estado = {
    pronta: false, presente: false, pessoas: 0,
    x: 0.5, y: 0.5, largura: 0,       // rosto principal, em fração da imagem (0..1)
    virado: 0,                         // -1..1: rosto virado para um lado
    sorriso: 0, surpresa: 0,           // 0..1, suavizados
    caixas: [],                        // [{x0,y0,x1,y1}] de todos os rostos (para desenhar)
  };

  async function criar(fonte, delegate) {
    const mp = await import(fonte.lib);
    const arquivos = await mp.FilesetResolver.forVisionTasks(fonte.wasm);
    return mp.FaceLandmarker.createFromOptions(arquivos, {
      baseOptions: { modelAssetPath: fonte.modelo, delegate },
      runningMode: "VIDEO", numFaces: 4, outputFaceBlendshapes: true,
      minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
  }

  async function carregar() {
    let ultimoErro = null;
    for (const fonte of FONTES) {
      for (const delegate of ["GPU", "CPU"]) {      // GPU é mais leve; alguns computadores só aceitam CPU
        try { detector = await criar(fonte, delegate); return `${fonte.nome}, ${delegate}`; }
        catch (e) { ultimoErro = e; console.warn("Visão:", fonte.nome, delegate, e); }
      }
    }
    throw ultimoErro || new Error("MediaPipe indisponível");
  }

  function pontuacao(categorias, nome) {
    const c = categorias.find((k) => k.categoryName === nome);
    return c ? c.score : 0;
  }

  function analisar() {
    if (!detector || !video || video.readyState < 2 || !video.videoWidth) return;
    let ts = performance.now();
    if (ts <= ultimoTs) ts = ultimoTs + 1;           // o MediaPipe exige tempo sempre crescente
    ultimoTs = ts;
    let r;
    try { r = detector.detectForVideo(video, ts); } catch (e) { console.warn("Visão:", e); return; }

    const rostos = (r.faceLandmarks || []).map((pts, i) => {
      let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      const cats = (r.faceBlendshapes && r.faceBlendshapes[i] && r.faceBlendshapes[i].categories) || [];
      const nariz = pts[1] || { x: (x0 + x1) / 2 };
      return { x0, y0, x1, y1, largura: x1 - x0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
               virado: Math.max(-1, Math.min(1, ((nariz.x - (x0 + x1) / 2) / Math.max(0.01, x1 - x0)) * 4)),
               sorriso: (pontuacao(cats, "mouthSmileLeft") + pontuacao(cats, "mouthSmileRight")) / 2,
               surpresa: Math.min(1, (pontuacao(cats, "browInnerUp") + pontuacao(cats, "jawOpen") * 0.8 +
                                      (pontuacao(cats, "eyeWideLeft") + pontuacao(cats, "eyeWideRight")) * 0.3) / 1.6) };
    });

    const agora = performance.now();
    estado.pessoas = rostos.length;
    estado.caixas = rostos;
    if (rostos.length) {
      const p = rostos.reduce((a, b) => (b.largura > a.largura ? b : a));   // o mais perto manda
      const k = 0.35;                                                        // suavização
      estado.x += (p.cx - estado.x) * k; estado.y += (p.cy - estado.y) * k;
      estado.largura += (p.largura - estado.largura) * k;
      estado.virado += (p.virado - estado.virado) * k;
      estado.sorriso += (p.sorriso - estado.sorriso) * 0.4;
      estado.surpresa += (p.surpresa - estado.surpresa) * 0.4;
      seguidos++;
      ultimoVisto = agora;
      if (!estado.presente && seguidos >= CHEGOU_QUADROS) { estado.presente = true; aoEvento("chegou", estado); }
    } else {
      seguidos = 0;
      estado.sorriso *= 0.8; estado.surpresa *= 0.8;
      if (estado.presente && agora - ultimoVisto > SAIU_MS) { estado.presente = false; aoEvento("saiu", estado); }
    }
    aoAtualizar(estado);
  }

  return {
    estado,
    // Começa a analisar o elemento <video>. Devolve uma frase sobre de onde o MediaPipe veio.
    async iniciar(elementoVideo, { atualizar, evento } = {}) {
      video = elementoVideo;
      if (atualizar) aoAtualizar = atualizar;
      if (evento) aoEvento = evento;
      const origem = await carregar();
      estado.pronta = true;
      clearInterval(timer);
      timer = setInterval(analisar, INTERVALO_MS);
      return origem;
    },

    // Esquece a pessoa atual (fim da conversa).
    zerar() {
      seguidos = 0; ultimoVisto = 0;
      Object.assign(estado, { presente: false, pessoas: 0, caixas: [], sorriso: 0, surpresa: 0 });
    },

    // Frase curta para a IA sobre o que a câmera mostra agora (sem identificar ninguém).
    descrever() {
      if (!video || !video.videoWidth) return "a câmera da pessoa está desligada ou sem imagem";
      if (!estado.pronta) return "";
      if (!estado.pessoas) return "nenhum rosto aparece na câmera agora";
      const partes = [estado.pessoas === 1 ? "1 pessoa na frente da câmera" : `${estado.pessoas} pessoas na frente da câmera`];
      partes.push(estado.largura > 0.3 ? "bem perto" : estado.largura > 0.15 ? "a uma distância normal" : "mais longe");
      // imagem da câmera sem espelhar: esquerda da imagem = esquerda do robô
      if (estado.x < 0.38) partes.push("mais à esquerda do robô");
      else if (estado.x > 0.62) partes.push("mais à direita do robô");
      if (Math.abs(estado.virado) > 0.45) partes.push("com o rosto virado para o lado");
      if (estado.sorriso > 0.5) partes.push("sorrindo");
      else if (estado.surpresa > 0.5) partes.push("com cara de surpresa");
      return partes.join(", ");
    },

    // Foto do vídeo em JPEG (base64 sem o prefixo "data:"), com o lado maior em `maxLado` pixels.
    foto(maxLado = 640, qualidade = 0.7) {
      if (!video || !video.videoWidth) return null;
      const esc = Math.min(1, maxLado / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(video.videoWidth * esc);
      c.height = Math.round(video.videoHeight * esc);
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", qualidade);
      return url.slice(url.indexOf(",") + 1);
    },

    // Desenha os quadros dos rostos num <canvas> por cima do vídeo (object-fit: contain).
    desenhar(canvas) {
      const g = canvas.getContext("2d");
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      g.clearRect(0, 0, w, h);
      if (!video || !video.videoWidth || !estado.caixas.length) return;
      const esc = Math.min(w / video.videoWidth, h / video.videoHeight);
      const vw = video.videoWidth * esc, vh = video.videoHeight * esc;
      const ox = (w - vw) / 2, oy = (h - vh) / 2;
      g.lineWidth = 2;
      const principal = estado.caixas.reduce((a, b) => (b.largura > a.largura ? b : a));
      estado.caixas.forEach((b) => {
        g.strokeStyle = b === principal ? "rgba(63,185,80,.9)" : "rgba(139,152,165,.8)";
        g.strokeRect(ox + b.x0 * vw, oy + b.y0 * vh, (b.x1 - b.x0) * vw, (b.y1 - b.y0) * vh);
      });
    },
  };
})();
