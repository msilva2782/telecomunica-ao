"use strict";
// Áudio do cliente (o que o ator escuta), tratado na página do ator:
//
//   voz do cliente -> passa-alta 80 Hz -> [RNNoise, IA que separa voz de ruído] -> realce da voz
//     -> [portão: abaixa o chiado entre as falas] -> nivelador (falas fracas e longe sobem)
//     -> ganho -> limitador (nunca estoura) -> abafador de eco -> volume -> fone do ator
//
// Perfis: "natural" (só filtros e nivelador), "equilibrado" (+ RNNoise) e "máximo" (+ portão).
// O navegador do cliente já tira parte do ruído antes de enviar; empilhar limpezas demais deixa a
// voz robótica e picotada, por isso o portão só entra no perfil máximo.
// O RNNoise é procurado em ator/vendor/rnnoise (o preparar_portatil.bat baixa) e depois na internet.

const AudioCliente = (() => {
  const VERSAO_NS = "0.3.5";
  const CDN = `https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@${VERSAO_NS}/dist`;
  const FONTES_NS = [
    { nome: "local", worklet: "/ator/vendor/rnnoise/workletProcessor.js",
      wasm: "/ator/vendor/rnnoise/rnnoise.wasm", simd: "/ator/vendor/rnnoise/rnnoise_simd.wasm" },
    { nome: "internet", worklet: `${CDN}/rnnoise/workletProcessor.js`,
      wasm: `${CDN}/rnnoise.wasm`, simd: `${CDN}/rnnoise_simd.wasm` },
  ];
  const NOME_RNNOISE = "@sapphi-red/web-noise-suppressor/rnnoise";
  const PERFIS = {
    natural:     { reducao: false, portao: false, realce: true },
    equilibrado: { reducao: true,  portao: false, realce: true },
    maximo:      { reducao: true,  portao: true,  realce: true },
  };

  const CODIGO_WORKLETS = `
// Portão de ruído suave: mede o piso de ruído sozinho e abaixa (sem cortar) os trechos sem fala.
class PortaoRuido extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ligado", defaultValue: 1, minValue: 0, maxValue: 1 },
            { name: "profundidade", defaultValue: 0.35, minValue: 0, maxValue: 1 }];
  }
  constructor() { super(); this.env = 0; this.ruido = 0.004; this.ganho = 1; this.hold = 0; }
  process(entradas, saidas, p) {
    const ent = entradas[0], sai = saidas[0];
    if (!ent || !ent.length || !sai || !sai.length) return true;
    const n = ent[0].length;
    let s = 0;
    for (let i = 0; i < n; i++) s += ent[0][i] * ent[0][i];
    const rms = Math.sqrt(s / n);
    this.env = rms > this.env ? rms : this.env * 0.99;
    this.ruido = rms < this.ruido ? this.ruido * 0.9 + rms * 0.1 : this.ruido * 1.0025;
    this.ruido = Math.min(Math.max(this.ruido, 1e-5), 0.05);
    const aberto = this.env > Math.max(this.ruido * 2.2, 0.002);
    this.hold = aberto ? 0.4 * sampleRate : Math.max(0, this.hold - n);     // segura 400 ms após a fala
    const alvo = p.ligado[0] < 0.5 || aberto || this.hold > 0 ? 1 : p.profundidade[0];
    const kA = 1 - Math.exp(-1 / (0.002 * sampleRate)), kR = 1 - Math.exp(-1 / (0.25 * sampleRate));
    for (let i = 0; i < n; i++) {
      this.ganho += (alvo - this.ganho) * (alvo > this.ganho ? kA : kR);
      for (let c = 0; c < sai.length; c++) sai[c][i] = (ent[c] || ent[0])[i] * this.ganho;
    }
    return true;
  }
}
registerProcessor("portao-ruido", PortaoRuido);

// Gravador: junta as amostras e manda para a página em pedaços (para salvar em WAV).
class Gravador extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ativo = true; this.buf = new Float32Array(9600); this.n = 0;
    this.port.onmessage = () => { this.enviar(); this.ativo = false; this.port.postMessage("fim"); };
  }
  enviar() { if (this.n) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; } }
  process(entradas) {
    if (!this.ativo) return false;
    const c = entradas[0] && entradas[0][0];
    if (c) for (let i = 0; i < c.length; i++) { this.buf[this.n++] = c[i]; if (this.n === this.buf.length) this.enviar(); }
    return true;
  }
}
registerProcessor("gravador", Gravador);`;

  let ctx = null, no = null, fonte = null, rn = null, preparando = null;
  const opcoes = { reducao: true, portao: false, realce: true, volume: 1.6, abafarEco: true };
  const estado = { pronto: false, rnnoise: "carregando…", aoMudar: null };

  function montar() {
    const c = ctx;
    no = {
      entrada: new GainNode(c, { gain: 1, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" }),
      passaAlta: new BiquadFilterNode(c, { type: "highpass", frequency: 80, Q: 0.7 }),
      pos: new GainNode(c, { gain: 1 }),                    // depois do RNNoise (ou dele pulado)
      grave: new BiquadFilterNode(c, { type: "lowshelf", frequency: 200, gain: 0 }),
      presenca: new BiquadFilterNode(c, { type: "peaking", frequency: 2500, Q: 0.8, gain: 0 }),
      brilho: new BiquadFilterNode(c, { type: "highshelf", frequency: 6000, gain: 0 }),
      portao: new AudioWorkletNode(c, "portao-ruido", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }),
      // nivelador: quem fala baixo ou longe do microfone sobe; quem fala alto não estoura
      // (o compressor do navegador já soma um ganho automático; mais que isso sobe o ruído de fundo)
      nivelador: new DynamicsCompressorNode(c, { threshold: -32, knee: 10, ratio: 3, attack: 0.01, release: 0.3 }),
      ganho: new GainNode(c, { gain: 1 }),
      limitador: new DynamicsCompressorNode(c, { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.1 }),
      eco: new GainNode(c, { gain: 1 }),                    // abaixa enquanto você ou o robô falam
      volume: new GainNode(c, { gain: opcoes.volume }),
      medidor: new AnalyserNode(c, { fftSize: 512 }),
    };
    no.entrada.connect(no.passaAlta);
    no.pos.connect(no.grave).connect(no.presenca).connect(no.brilho).connect(no.portao)
      .connect(no.nivelador).connect(no.ganho).connect(no.limitador).connect(no.eco).connect(no.volume);
    no.volume.connect(c.destination);
    no.limitador.connect(no.medidor);     // o medidor mostra a voz do cliente, sem o abafador de eco
    ligarRnnoise();
    aplicar();
  }

  function ligarRnnoise() {
    if (!no) return;
    no.passaAlta.disconnect();
    if (rn) { try { rn.disconnect(); } catch (_) {} }
    if (rn && opcoes.reducao) { no.passaAlta.connect(rn); rn.connect(no.pos); }
    else no.passaAlta.connect(no.pos);
  }

  function aplicar() {
    if (!no) return;
    const t = ctx.currentTime;
    no.grave.gain.setTargetAtTime(opcoes.realce ? -2 : 0, t, 0.05);
    no.presenca.gain.setTargetAtTime(opcoes.realce ? 3 : 0, t, 0.05);
    // o RNNoise tira um pouco do agudo: devolve um pouco de brilho para não ficar abafado
    no.brilho.gain.setTargetAtTime(opcoes.realce ? (opcoes.reducao && rn ? 3 : 1.5) : 0, t, 0.05);
    no.portao.parameters.get("ligado").setValueAtTime(opcoes.portao ? 1 : 0, t);
    no.volume.gain.setTargetAtTime(opcoes.volume, t, 0.05);
  }

  async function carregarRnnoise() {
    const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
                                                      10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    let ultimoErro = null, registrado = false;
    for (const f of FONTES_NS) {
      try {
        const r = await fetch(simd ? f.simd : f.wasm);
        if (!r.ok) throw new Error(`HTTP ${r.status} em ${f.nome}`);
        const wasmBinary = await r.arrayBuffer();
        if (!registrado) { await ctx.audioWorklet.addModule(f.worklet); registrado = true; }
        rn = new AudioWorkletNode(ctx, NOME_RNNOISE, {
          processorOptions: { maxChannels: 1, wasmBinary },
          channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1],
        });
        return f.nome;
      } catch (e) { ultimoErro = e; console.warn("RNNoise:", f.nome, e); }
    }
    throw ultimoErro || new Error("RNNoise indisponível");
  }

  function wav(partes, taxa) {
    const total = partes.reduce((s, p) => s + p.length, 0);
    const dv = new DataView(new ArrayBuffer(44 + total * 2));
    const txt = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    txt(0, "RIFF"); dv.setUint32(4, 36 + total * 2, true); txt(8, "WAVE"); txt(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, taxa, true); dv.setUint32(28, taxa * 2, true); dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true); txt(36, "data"); dv.setUint32(40, total * 2, true);
    let o = 44;
    for (const p of partes) for (let i = 0; i < p.length; i++, o += 2) dv.setInt16(o, Math.max(-1, Math.min(1, p[i])) * 32767, true);
    return new Blob([dv.buffer], { type: "audio/wav" });
  }

  function gravarDe(origem, ms) {
    return new Promise((resolve) => {
      const g = new AudioWorkletNode(ctx, "gravador", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const mudo = new GainNode(ctx, { gain: 0 });
      const partes = [];
      g.port.onmessage = (ev) => {
        if (ev.data === "fim") { origem.disconnect(g); g.disconnect(); resolve(wav(partes, ctx.sampleRate)); }
        else partes.push(ev.data);
      };
      origem.connect(g); g.connect(mudo).connect(ctx.destination);
      setTimeout(() => g.port.postMessage("parar"), ms);
    });
  }

  return {
    estado,
    opcoes,
    PERFIS,
    // Chamar num clique (o navegador só libera áudio depois de uma ação da pessoa).
    preparar() {
      if (preparando) return preparando;
      preparando = (async () => {
        // 48 kHz: o RNNoise e o Opus trabalham nessa taxa. "balanced": buffer um pouco maior, para o
        // som não falhar quando o computador está ocupado (vídeo, detecção de rosto, servidor).
        ctx = new AudioContext({ sampleRate: 48000, latencyHint: "balanced" });
        if (ctx.state === "suspended") await ctx.resume();
        const url = URL.createObjectURL(new Blob([CODIGO_WORKLETS], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        montar();
        estado.pronto = true;
        carregarRnnoise()
          .then((origem) => { estado.rnnoise = `ligado (${origem})`; ligarRnnoise(); aplicar(); })
          .catch(() => { estado.rnnoise = "indisponível (sem internet e sem ator/vendor)"; })
          .finally(() => { if (estado.aoMudar) estado.aoMudar(); });
      })();
      return preparando;
    },

    // Passa a tratar esta faixa de áudio. Devolve o analisador (nível já limpo) ou null.
    ligar(trilha) {
      if (!estado.pronto) return null;
      if (fonte) { try { fonte.disconnect(); } catch (_) {} }
      fonte = ctx.createMediaStreamSource(new MediaStream([trilha]));
      fonte.connect(no.entrada);
      if (ctx.state === "suspended") ctx.resume();
      return no.medidor;
    },

    desligar() {
      if (fonte) { try { fonte.disconnect(); } catch (_) {} fonte = null; }
    },

    ajustar(novas) {
      const antes = opcoes.reducao;
      Object.assign(opcoes, novas);
      if (opcoes.reducao !== antes) ligarRnnoise();
      aplicar();
    },

    // Enquanto você (ou a voz sintetizada do robô) fala, o que volta do cliente é quase só eco
    // da sua própria voz saindo da caixa de som dele: abaixa ~10 dB nesses momentos.
    abafar(sim) {
      if (!no) return;
      const alvo = sim && opcoes.abafarEco ? 0.32 : 1;
      estado.abafando = alvo < 1;
      if (Math.abs(no.eco.gain.value - alvo) < 0.01) return;
      no.eco.gain.setTargetAtTime(alvo, ctx.currentTime, alvo < 1 ? 0.03 : 0.25);
    },

    // Grava `segundos` do áudio como chegou e como saiu do tratamento (dois WAV), para análise.
    async gravar(segundos = 10) {
      if (!estado.pronto || !fonte) throw new Error("não há áudio do cliente agora");
      const ms = segundos * 1000;
      const [original, tratado] = await Promise.all([gravarDe(no.entrada, ms), gravarDe(no.limitador, ms)]);
      return { original, tratado };
    },
  };
})();
