"use strict";
// Rosto animado do robô (canvas). Expressões com transição suave, piscadas, olhar que
// passeia, respiração, boca sincronizada com a voz e estados de "dormindo" e "procurando".
//
//   const rosto = new Rosto(canvas);
//   rosto.expressao("triste", 0.8);   // neutro | feliz | triste | surpreso | pensativo | preocupado | rindo
//   rosto.falando(0..1);              // abertura da boca a cada quadro (nível da voz)
//   rosto.ouvindo(true|false);        // a pessoa está falando: o robô presta atenção
//   rosto.modo("acordado" | "dormindo" | "procurando");

(function (raiz) {
  // Parâmetros de cada expressão (intensidade 1). O rosto mistura com o neutro pela intensidade.
  const NEUTRO = {
    abertura: 1, baixo: 0, caido: 0, bravo: 0, sobAltura: 0, sobAngulo: 0, sobAlfa: 0.0,
    curva: 0.18, largura: 1, redondo: 0, rubor: 0, inclina: 0, olharX: 0, olharY: 0,
    cor: [70, 225, 255], brilho: 1, escala: 1,
  };
  const EXPRESSOES = {
    neutro: {},
    feliz: { abertura: 0.95, baixo: 0.45, curva: 1, largura: 1.15, rubor: 0.55, sobAltura: 10, sobAlfa: 0.35,
             cor: [90, 255, 215], brilho: 1.15, escala: 1.02 },
    rindo: { abertura: 0.9, baixo: 0.85, curva: 1, largura: 1.25, redondo: 0.25, rubor: 0.8, sobAltura: 14,
             sobAlfa: 0.4, cor: [110, 255, 205], brilho: 1.25, escala: 1.03 },
    triste: { abertura: 0.78, caido: 0.55, curva: -0.75, largura: 0.85, sobAltura: 6, sobAngulo: 0.42,
              sobAlfa: 0.95, inclina: -0.06, olharY: 0.35, cor: [80, 150, 255], brilho: 0.8, escala: 0.98 },
    surpreso: { abertura: 1.22, curva: 0, largura: 0.55, redondo: 1, sobAltura: 34, sobAngulo: 0.08,
                sobAlfa: 0.95, cor: [150, 240, 255], brilho: 1.25, escala: 1.04 },
    pensativo: { abertura: 0.88, baixo: 0.12, curva: -0.05, largura: 0.7, sobAltura: 12, sobAngulo: -0.25,
                 sobAlfa: 0.7, inclina: 0.09, olharX: 0.55, olharY: -0.55, cor: [120, 200, 255], brilho: 0.95 },
    preocupado: { abertura: 1.05, caido: 0.25, curva: -0.35, largura: 0.75, sobAltura: 14, sobAngulo: 0.5,
                  sobAlfa: 1, olharY: 0.1, cor: [255, 205, 110], brilho: 1, escala: 0.99 },
  };
  const CHAVES = Object.keys(NEUTRO).filter((k) => k !== "cor");

  const lerp = (a, b, t) => a + (b - a) * t;
  const limitar = (v, a, b) => Math.max(a, Math.min(b, v));
  const ruido = (t, s) => Math.sin(t * 1.3 + s) * 0.5 + Math.sin(t * 0.7 + s * 2.1) * 0.3 + Math.sin(t * 2.9 + s * 0.4) * 0.2;

  function alvoDe(nome, intensidade) {
    const e = EXPRESSOES[nome] || {};
    const alvo = {};
    for (const k of CHAVES) alvo[k] = lerp(NEUTRO[k], e[k] ?? NEUTRO[k], intensidade);
    const cor = e.cor || NEUTRO.cor;
    alvo.cor = NEUTRO.cor.map((c, i) => lerp(c, cor[i], intensidade));
    return alvo;
  }

  class Rosto {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.nitido = document.createElement("canvas");
      this.brilho = document.createElement("canvas");
      this.p = alvoDe("neutro", 1);          // estado atual (vai até o alvo aos poucos)
      this.alvo = alvoDe("neutro", 1);
      this.nome = "neutro";
      this.intensidade = 0;
      this._modo = "procurando";
      this.fechamento = 0;                   // 0 = olho aberto, 1 = dormindo
      this.boca = 0;                         // abertura de fala suavizada
      this.bocaAlvo = 0;
      this.atencao = 0;
      this.ouvindoAgora = false;
      this.piscada = 0;
      this.proximaPiscada = 1.5;
      this.olhar = { x: 0, y: 0, ax: 0, ay: 0, prox: 1 };
      this.pessoa = null;                    // {x, y, ate}: onde a câmera viu a pessoa (-1..1)
      this.lagrimas = [];
      this.zs = [];
      this.t = 0;
      this.ultimo = performance.now();
      this._ajustar = this._ajustar.bind(this);
      window.addEventListener("resize", this._ajustar);
      this._ajustar();
      const quadro = (agora) => { this._passo(agora); requestAnimationFrame(quadro); };
      requestAnimationFrame(quadro);
    }

    expressao(nome, intensidade = 1) {
      if (!EXPRESSOES[nome]) nome = "neutro";
      this.nome = nome;
      this.intensidade = nome === "neutro" ? 0 : limitar(intensidade, 0, 1);
      this.alvo = alvoDe(nome, nome === "neutro" ? 1 : this.intensidade);
      if (nome === "surpreso") this.piscada = 0;     // surpresa: olhos arregalados, sem piscar
    }

    falando(nivel) { this.bocaAlvo = limitar(nivel, 0, 1); }
    ouvindo(sim) { this.ouvindoAgora = !!sim; }
    modo(m) { this._modo = m; }
    // A câmera viu a pessoa em (x, y), de -1 a 1 (x > 0 = direita de quem olha a tela).
    // null: ninguém à vista, volta a olhar em volta. Vale por 1,5 s se não vier outra posição.
    olharPara(x, y) {
      if (x == null || !isFinite(x)) { this.pessoa = null; return; }
      const novo = !this.pessoa;
      this.pessoa = { x: limitar(x, -1, 1), y: limitar(isFinite(y) ? y : 0, -1, 1), ate: performance.now() + 1500 };
      if (novo) this.olhar.prox = 0;           // achou alguém: vira o olhar na hora
    }

    _ajustar() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
      if (!w || !h) return;
      this.canvas.width = this.nitido.width = w;
      this.canvas.height = this.nitido.height = h;
      this.brilho.width = Math.max(1, Math.floor(w / 4));
      this.brilho.height = Math.max(1, Math.floor(h / 4));
    }

    _passo(agora) {
      const dt = Math.min(0.05, (agora - this.ultimo) / 1000);
      this.ultimo = agora;
      this.t += dt;
      const k = 1 - Math.pow(0.0015, dt);     // ~ mesma velocidade em 30 ou 60 FPS
      for (const c of CHAVES) this.p[c] = lerp(this.p[c], this.alvo[c], k);
      this.p.cor = this.p.cor.map((v, i) => lerp(v, this.alvo.cor[i], k));

      // dormir / acordar
      this.fechamento = lerp(this.fechamento, this._modo === "dormindo" ? 1 : 0, 1 - Math.pow(0.05, dt));

      // boca: abre rápido e fecha um pouco mais devagar, como a fala real
      const vel = this.bocaAlvo > this.boca ? 0.00001 : 0.002;
      this.boca = lerp(this.boca, this.bocaAlvo, 1 - Math.pow(vel, dt));
      this.atencao = lerp(this.atencao, this.ouvindoAgora ? 1 : 0, 1 - Math.pow(0.02, dt));

      // piscadas (às vezes duplas); não pisca dormindo nem surpreso
      this.proximaPiscada -= dt;
      if (this.proximaPiscada <= 0 && this._modo !== "dormindo" && this.nome !== "surpreso") {
        this.piscada = 1;
        this.proximaPiscada = Math.random() < 0.18 ? 0.28 : 2 + Math.random() * 4;
      }
      this.piscada = Math.max(0, this.piscada - dt * 7);

      // olhar: pequenos saltos (sacadas); ao ouvir, olha para a pessoa
      // com a câmera vendo a pessoa, os olhos apontam para ela (com pequenas sacadas em volta)
      if (this.pessoa && agora > this.pessoa.ate) this.pessoa = null;
      this.olhar.prox -= dt;
      if (this.pessoa && this._modo !== "dormindo") {
        if (this.olhar.prox <= 0) {
          this.olhar.prox = 0.25 + Math.random() * 0.5;
          this.olhar.jx = (Math.random() * 2 - 1) * 0.06;
          this.olhar.jy = (Math.random() * 2 - 1) * 0.04;
        }
        this.olhar.ax = this.pessoa.x * 0.8 + (this.olhar.jx || 0);
        this.olhar.ay = this.pessoa.y * 0.6 + (this.olhar.jy || 0);
      } else if (this.olhar.prox <= 0) {
        const amp = this.ouvindoAgora ? 0.12 : this._modo === "procurando" ? 0.9 : 0.35;
        this.olhar.ax = (Math.random() * 2 - 1) * amp;
        this.olhar.ay = (Math.random() * 2 - 1) * amp * 0.5;
        this.olhar.prox = this._modo === "procurando" ? 0.7 + Math.random() * 0.6
          : this.ouvindoAgora ? 1.5 + Math.random() * 2 : 0.8 + Math.random() * 2.5;
      }
      this.olhar.x = lerp(this.olhar.x, this.olhar.ax, 1 - Math.pow(0.0000001, dt));
      this.olhar.y = lerp(this.olhar.y, this.olhar.ay, 1 - Math.pow(0.0000001, dt));

      this._particulas(dt);
      this._desenhar();
    }

    _particulas(dt) {
      // lágrima quando muito triste
      if (this.nome === "triste" && this.intensidade > 0.6 && this.fechamento < 0.5 && Math.random() < dt * 0.35
          && this.lagrimas.length < 2) {
        this.lagrimas.push({ lado: Math.random() < 0.5 ? -1 : 1, y: 0, v: 0, vida: 1 });
      }
      for (const l of this.lagrimas) { l.v += dt * 0.6; l.y += l.v * dt * 400; l.vida -= dt * 0.45; }
      this.lagrimas = this.lagrimas.filter((l) => l.vida > 0);
      // "Z z" dormindo
      if (this.fechamento > 0.8 && Math.random() < dt * 0.8 && this.zs.length < 3) {
        this.zs.push({ x: 0, y: 0, vida: 1, tam: 0.6 + Math.random() * 0.5 });
      }
      for (const z of this.zs) { z.y -= dt * 60; z.x += dt * 25; z.vida -= dt * 0.33; }
      this.zs = this.zs.filter((z) => z.vida > 0);
    }

    _desenhar() {
      const W = this.nitido.width, H = this.nitido.height;
      if (!W || !H) return;
      const c = this.nitido.getContext("2d");
      const p = this.p, t = this.t;
      c.clearRect(0, 0, W, H);
      const s = Math.min(W / 1000, H / 700);
      const respira = 1 + Math.sin(t * 1.6) * 0.008;
      const fala = this.boca;
      const cor = `rgb(${p.cor.map((v) => Math.round(limitar(v * p.brilho, 0, 255))).join(",")})`;

      c.save();
      c.translate(W / 2 + ruido(t * 0.4, 1) * 6 * s, H / 2 + ruido(t * 0.5, 2) * 5 * s - fala * 4 * s
                  + this.fechamento * 14 * s);
      c.rotate(p.inclina + ruido(t * 0.3, 3) * 0.012 + this.atencao * 0.035 * Math.sin(t * 0.8));
      c.scale(p.escala * respira * (1 + this.atencao * 0.015), p.escala * respira * (1 + this.atencao * 0.015));

      const gx = (p.olharX + this.olhar.x) * 26 * s, gy = (p.olharY + this.olhar.y) * 20 * s;
      const piscar = this.piscada > 0 ? Math.sin(this.piscada * Math.PI) : 0;
      const abertura = Math.max(0.035, p.abertura * (1 - piscar * 0.95) * (1 - this.fechamento * 0.965)
                       * (1 + this.atencao * 0.06));
      const ex = 205 * s, ey = -70 * s, ew = 175 * s, eh = 215 * s;

      c.fillStyle = cor;
      c.strokeStyle = cor;
      for (const lado of [-1, 1]) {
        this._olho(c, lado * ex + gx, ey + gy, ew, eh, abertura, lado, s);
        this._sobrancelha(c, lado * ex + gx * 0.6, ey + gy * 0.6, ew, eh, lado, s);
        if (p.rubor > 0.02) {
          c.save();
          c.globalAlpha = p.rubor * 0.55 * (1 - this.fechamento);
          c.fillStyle = "rgb(255,110,160)";
          c.beginPath();
          c.ellipse(lado * (ex + 40 * s), ey + eh * 0.62, 62 * s, 26 * s, 0, 0, Math.PI * 2);
          c.fill();
          c.restore();
        }
      }
      this._boca(c, gx * 0.35, 175 * s + gy * 0.3, s, fala, cor);

      // lágrimas
      for (const l of this.lagrimas) {
        c.save();
        c.globalAlpha = Math.max(0, l.vida) * 0.9;
        c.fillStyle = "rgb(120,190,255)";
        const x = l.lado * (ex + ew * 0.3) + gx, y = ey + eh * 0.35 + l.y * s;
        c.beginPath();
        c.moveTo(x, y - 16 * s);
        c.quadraticCurveTo(x + 12 * s, y + 6 * s, x, y + 12 * s);
        c.quadraticCurveTo(x - 12 * s, y + 6 * s, x, y - 16 * s);
        c.fill();
        c.restore();
      }
      // reticências do pensativo
      if (this.nome === "pensativo" && this.intensidade > 0.3 && this.fechamento < 0.5) {
        for (let i = 0; i < 3; i++) {
          const fase = (t * 1.6 - i * 0.35) % 2;
          c.globalAlpha = limitar(Math.sin(Math.max(0, fase) * Math.PI / 2), 0, 1) * 0.8 * this.intensidade;
          c.beginPath();
          c.arc((330 + i * 42) * s, (-250 - i * 34) * s, (9 + i * 4) * s, 0, Math.PI * 2);
          c.fill();
        }
        c.globalAlpha = 1;
      }
      // Z z
      for (const z of this.zs) {
        c.globalAlpha = Math.max(0, z.vida) * 0.85;
        c.font = `600 ${Math.round(60 * z.tam * s)}px system-ui, sans-serif`;
        c.fillText("z", (300 + z.x) * s, (-180 + z.y) * s);
      }
      c.globalAlpha = 1;
      c.restore();

      // brilho (bloom): cópia pequena e borrada somada por cima
      const b = this.brilho.getContext("2d");
      b.clearRect(0, 0, this.brilho.width, this.brilho.height);
      b.filter = "blur(6px)";
      b.drawImage(this.nitido, 0, 0, this.brilho.width, this.brilho.height);
      b.filter = "none";

      const ctx = this.ctx;
      ctx.globalCompositeOperation = "source-over";
      const fundo = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      fundo.addColorStop(0, "#0a1420");
      fundo.addColorStop(1, "#020407");
      ctx.fillStyle = fundo;
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.brilho, 0, 0, W, H);
      ctx.drawImage(this.brilho, 0, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(this.nitido, 0, 0);
      // linhas de "tela" bem discretas
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      for (let y = 0; y < H; y += Math.max(3, Math.round(4 * s))) ctx.fillRect(0, y, W, 1);
    }

    _olho(c, x, y, w, h, abertura, lado, s) {
      const p = this.p;
      const altura = h * abertura;
      const topo = -altura / 2;
      c.save();
      c.translate(x, y);
      // recorte: região abaixo da pálpebra de cima, inclinada
      // (triste/preocupado: cai para fora; bravo: cai para dentro)
      const dentroX = -lado * w / 2, foraX = lado * w / 2;
      const yDentro = topo + Math.max(0, p.bravo) * altura * 0.5;
      const yFora = topo + p.caido * altura * 0.6;
      c.beginPath();
      c.moveTo(dentroX - lado * w, yDentro - (yFora - yDentro));
      c.lineTo(dentroX, yDentro);
      c.lineTo(foraX, yFora);
      c.lineTo(foraX + lado * w, yFora + (yFora - yDentro));
      c.lineTo(foraX + lado * w, h * 2);
      c.lineTo(dentroX - lado * w, h * 2);
      c.closePath();
      c.clip();
      // recorte: bochecha subindo (sorriso com os olhos)
      if (p.baixo > 0.02) {
        const r = w * 1.05;
        const cy = altura / 2 + r - p.baixo * altura * 0.75;
        c.beginPath();
        c.rect(-w * 2, -h * 2, w * 4, h * 4);
        c.arc(0, cy, r, 0, Math.PI * 2, true);
        c.clip("evenodd");
      }
      const raio = Math.min(w, altura) * 0.32;
      c.beginPath();
      c.roundRect(-w / 2, -altura / 2, w, altura, raio);
      c.fill();
      // reflexo
      if (altura > h * 0.3) {
        c.globalAlpha = 0.28;
        c.fillStyle = "#ffffff";
        c.beginPath();
        c.ellipse(-w * 0.18, -altura * 0.22, w * 0.11, altura * 0.12, -0.4, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }

    _sobrancelha(c, x, y, w, h, lado, s) {
      const p = this.p;
      const alfa = p.sobAlfa * (1 - this.fechamento);
      if (alfa < 0.02) return;
      c.save();
      c.globalAlpha = alfa;
      c.lineCap = "round";
      c.lineWidth = 15 * s;
      c.translate(x, y - h / 2 - 48 * s - p.sobAltura * s * 1.6 - this.atencao * 6 * s);
      // ângulo positivo = ponta de dentro levantada (tristeza, preocupação)
      c.rotate(lado * p.sobAngulo);
      c.beginPath();
      c.moveTo(-w * 0.42, 0);
      c.quadraticCurveTo(0, -10 * s, w * 0.42, 0);
      c.stroke();
      c.restore();
    }

    _boca(c, x, y, s, fala, cor) {
      const p = this.p;
      const dormindo = this.fechamento;
      const largura = 230 * s * p.largura * (1 - fala * 0.12) * (1 - dormindo * 0.4);
      const curva = p.curva * 62 * s * (1 - dormindo);
      const abre = Math.max(fala * 80 * s, p.redondo * 70 * s) * (1 - dormindo);
      c.save();
      c.translate(x, y);
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = 14 * s;
      if (p.redondo > 0.5 && fala < 0.3) {
        // "O" de surpresa
        const rx = largura * 0.32, ry = abre * 0.62;
        c.beginPath();
        c.ellipse(0, 6 * s, rx, Math.max(ry, 14 * s), 0, 0, Math.PI * 2);
        c.stroke();
      } else {
        const l = largura / 2;
        const cantoY = -curva * 0.45;
        c.beginPath();
        c.moveTo(-l, cantoY);
        c.quadraticCurveTo(0, curva - abre * 0.25, l, cantoY);
        if (abre > 2 * s) {
          c.quadraticCurveTo(0, curva + abre * 1.6, -l, cantoY);
          c.closePath();
          c.globalAlpha = 0.9;
          c.fill();
          c.globalAlpha = 1;
          c.stroke();
        } else {
          c.stroke();
        }
      }
      c.restore();
    }
  }

  raiz.Rosto = Rosto;
  raiz.Rosto.EXPRESSOES = Object.keys(EXPRESSOES);
})(window);
