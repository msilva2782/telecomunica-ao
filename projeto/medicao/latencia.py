"""Mede a latência robô -> operador e confere a meta (< 300 ms).

Comporta-se como um operador (sem interface): conecta ao servidor, inicia a
sessão e, durante --duracao segundos, coleta:

  * RTT do canal de dados (ping/pong);
  * idade de cada quadro de vídeo: instante de chegada - instante de captura,
    lido da marca desenhada nos pixels (exige o robô com MARCAR_TIMESTAMP=1);
  * perda de pacotes e jitter informados pelo WebRTC.

Relógios: o robô devolve a própria hora em cada pong. Com isso o script estima
a diferença entre os relógios (como o NTP: usa a amostra de menor RTT) e não
precisa de relógios sincronizados. O erro máximo da estimativa é RTT/2.

Quadro completo: o receptor de vídeo do aiortc só libera um quadro quando chega
o primeiro pacote do quadro SEGUINTE, o que somaria um intervalo inteiro de
quadro (200 ms a 5 FPS) que o navegador do operador não tem (ele usa o bit
"marker" do RTP). O script corrige isso liberando o quadro no marker, como o
navegador; use --sem-correcao-marker para ver o valor sem a correção.

Veredito: p95 da idade dos quadros < meta (se houver marca); caso contrário,
RTT/2 como estimativa indicativa (não inclui captura, codificação e buffers).

Uso:  python -m medicao.latencia --duracao 30 [--csv resultado.csv]
"""
import argparse
import asyncio
import csv
import json
import statistics
import sys
import time
from typing import List, Optional, Tuple

import websockets
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from aiortc import jitterbuffer
from aiortc.exceptions import InvalidStateError
from aiortc.mediastreams import MediaStreamError

from comum import config, marca

AQUECIMENTO_S = 2.0  # descarta as primeiras amostras (partida do codec)


# ------------------------------------------------- quadro liberado no marker
_add_original = jitterbuffer.JitterBuffer.add


def _add_com_marker(self, pacote):
    """Libera o quadro de vídeo assim que chega o pacote com o bit marker."""
    pli, quadro = _add_original(self, pacote)
    if quadro is not None or not self._is_video or not pacote.marker or self._origin is None:
        return pli, quadro
    pacotes = []
    for n in range(self.capacity):
        p = self._packets[(self._origin + n) % self.capacity]
        if p is None or p.timestamp != pacote.timestamp:
            return pli, None  # quadro incompleto ou restos de um anterior: segue o padrão
        pacotes.append(p)
        if p.sequence_number == pacote.sequence_number:
            self.remove(n + 1)
            dados = b"".join(x._data for x in pacotes)
            return pli, jitterbuffer.JitterFrame(data=dados, timestamp=pacote.timestamp)
    return pli, None


def ativar_correcao_marker() -> None:
    jitterbuffer.JitterBuffer.add = _add_com_marker


# ------------------------------------------------------------- estatística
def percentil(valores: List[float], p: float) -> float:
    ordenados = sorted(valores)
    k = min(len(ordenados) - 1, max(0, round(p / 100 * (len(ordenados) - 1))))
    return ordenados[k]


def resumo(nome: str, valores: List[float]) -> None:
    if not valores:
        print(f"{nome}: sem amostras")
        return
    print(f"{nome}: n={len(valores)}  min={min(valores):.1f}  média={statistics.fmean(valores):.1f}  "
          f"mediana={statistics.median(valores):.1f}  p95={percentil(valores, 95):.1f}  "
          f"p99={percentil(valores, 99):.1f}  máx={max(valores):.1f}  (ms)")


class Resultado:
    def __init__(self) -> None:
        self.idades: List[float] = []    # ms, já com a diferença de relógio aplicada
        self.rtts: List[float] = []      # ms
        self.quadros = 0
        self.offset_ms: Optional[float] = None   # relógio do robô - relógio local
        self.perdidos = 0
        self.recebidos = 0
        self.jitter_audio_ms: Optional[float] = None


async def medir(url: str, token: str, duracao: float, sincronizados: bool) -> Resultado:
    brutas: List[Tuple[float, float]] = []   # (instante local, chegada - captura sem correção)
    rtts: List[Tuple[float, float]] = []
    melhor: List[float] = []                  # [rtt, offset] da amostra de menor RTT
    res = Resultado()
    conectado = asyncio.Event()
    interrompido = asyncio.Event()          # a sessão caiu no meio da medição
    erro: List[str] = []
    pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))

    async def consumir_video(faixa):
        try:
            while True:
                quadro = await faixa.recv()
                agora = time.time() * 1000
                res.quadros += 1
                ts = marca.ler(quadro.to_ndarray(format="gray"))
                if ts is not None:
                    brutas.append((time.monotonic(), agora - ts))
        except MediaStreamError:
            pass  # faixa encerrada

    async def consumir_audio(faixa):
        try:
            while True:
                await faixa.recv()
        except MediaStreamError:
            pass

    async def pingar(canal):
        try:
            while canal.readyState != "open":
                await asyncio.sleep(0.05)
            while True:
                canal.send(json.dumps({"t": "ping", "ts": time.perf_counter(), "tw": time.time() * 1000}))
                await asyncio.sleep(0.2)
        except InvalidStateError:
            pass  # canal fechado

    tarefas: List[asyncio.Task] = []

    @pc.on("track")
    def ao_chegar_faixa(faixa):
        alvo = consumir_video if faixa.kind == "video" else consumir_audio
        tarefas.append(asyncio.create_task(alvo(faixa)))

    @pc.on("datachannel")
    def ao_chegar_canal(canal):
        @canal.on("message")
        def ao_msg(dados):
            m = json.loads(dados)
            if m.get("t") != "pong":
                return
            rtt = (time.perf_counter() - m["ts"]) * 1000
            rtts.append((time.monotonic(), rtt))
            if m.get("agora") is not None and m.get("tw") is not None:
                chegada = time.time() * 1000
                offset = m["agora"] - (m["tw"] + chegada) / 2
                if not melhor or rtt < melhor[0]:
                    melhor[:] = [rtt, offset]
        tarefas.append(asyncio.create_task(pingar(canal)))

    @pc.on("connectionstatechange")
    async def ao_mudar():
        if pc.connectionState == "connected":
            conectado.set()
        elif pc.connectionState == "failed":
            erro.append("conexão WebRTC falhou")
            conectado.set()

    async with websockets.connect(f"{url}?token={token}", max_size=2 ** 20) as ws:
        def falhar(texto: str) -> None:
            erro.append(texto)
            conectado.set()
            interrompido.set()

        async def ouvir():
            try:
                async for bruto in ws:
                    msg = json.loads(bruto)
                    if msg["tipo"] == "offer":
                        await pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="offer"))
                        await pc.setLocalDescription(await pc.createAnswer())
                        await ws.send(json.dumps({"tipo": "answer", "sdp": pc.localDescription.sdp}))
                    elif msg["tipo"] == "erro":
                        falhar(f"servidor: {msg['motivo']}")
                    elif msg["tipo"] == "encerrar":
                        falhar(f"sessão encerrada ({msg.get('motivo', '-')})")
            except websockets.ConnectionClosed as exc:
                codigo = exc.rcvd.code if exc.rcvd else None
                if codigo == 4000:
                    falhar("outro operador entrou com o mesmo token (feche a página do operador "
                           "antes de medir)")
                elif codigo == 4401:
                    falhar("token do operador recusado (TOKEN_OPERADOR)")
                else:
                    falhar(f"conexão com o servidor encerrada ({codigo})")

        leitor = asyncio.create_task(ouvir())
        await ws.send(json.dumps({"tipo": "iniciar"}))
        try:
            await asyncio.wait_for(conectado.wait(), 30)
        except asyncio.TimeoutError:
            erro.append("tempo esgotado esperando a conexão")
        if erro:
            leitor.cancel()
            await pc.close()
            raise RuntimeError(erro[0])

        t0 = time.monotonic()
        print(f"conectado; medindo por {duracao:.0f}s (descartando os primeiros {AQUECIMENTO_S:.0f}s)...")
        try:
            await asyncio.wait_for(interrompido.wait(), duracao)
        except asyncio.TimeoutError:
            pass  # mediu o tempo todo
        if erro:
            leitor.cancel()
            for t in tarefas:
                t.cancel()
            await pc.close()
            raise RuntimeError("medição interrompida: " + erro[0])

        relatorio = await pc.getStats()
        for est in relatorio.values():
            if est.type == "inbound-rtp":
                res.perdidos += max(0, est.packetsLost or 0)
                res.recebidos += est.packetsReceived or 0
                if est.kind == "audio" and est.jitter is not None:
                    # aiortc informa em unidades do relógio RTP (Opus: 48 kHz)
                    res.jitter_audio_ms = est.jitter / config.TAXA_AUDIO * 1000

        await ws.send(json.dumps({"tipo": "encerrar", "motivo": "fim_da_medicao"}))
        leitor.cancel()
        for t in tarefas:
            t.cancel()
        await pc.close()

    corte = t0 + AQUECIMENTO_S
    if melhor and not sincronizados:
        res.offset_ms = melhor[1]
    ajuste = res.offset_ms or 0.0
    # idade = chegada_local - (captura_robo - offset)  =  bruta + offset
    res.idades = [v + ajuste for t, v in brutas if t >= corte]
    res.rtts = [v for t, v in rtts if t >= corte]
    return res


def gravar_csv(caminho: str, res: Resultado) -> None:
    with open(caminho, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["tipo", "valor_ms"])
        w.writerows(("idade_quadro", f"{v:.2f}") for v in res.idades)
        w.writerows(("rtt", f"{v:.2f}") for v in res.rtts)
    print(f"amostras gravadas em {caminho}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=config.URL_SERVIDOR, help="URL do WebSocket de sinalização")
    ap.add_argument("--token", default=config.TOKEN_OPERADOR, help="token do operador")
    ap.add_argument("--duracao", type=float, default=30.0, help="segundos de medição (padrão 30)")
    ap.add_argument("--meta", type=float, default=config.META_LATENCIA_MS, help="meta em ms (padrão 300)")
    ap.add_argument("--csv", help="grava as amostras neste arquivo CSV")
    ap.add_argument("--relogios-sincronizados", action="store_true",
                    help="não estima a diferença de relógio (use se robô e medição usam NTP)")
    ap.add_argument("--sem-correcao-marker", action="store_true",
                    help="mantém o atraso extra de um quadro do receptor do aiortc")
    args = ap.parse_args()

    if not args.sem_correcao_marker:
        ativar_correcao_marker()

    try:
        res = asyncio.run(medir(args.url, args.token, args.duracao, args.relogios_sincronizados))
    except RuntimeError as exc:
        print(f"ERRO: {exc}")
        return 2
    except (OSError, websockets.WebSocketException) as exc:
        print(f"ERRO: não foi possível falar com o servidor: {exc}")
        return 2

    print()
    print(f"quadros recebidos: {res.quadros}  (≈ {res.quadros / args.duracao:.1f} FPS)")
    if res.offset_ms is not None:
        print(f"diferença de relógio robô - medição: {res.offset_ms:+.1f} ms (estimada pelo ping)")
    total = res.recebidos + res.perdidos
    if total:
        print(f"pacotes RTP: {res.recebidos} recebidos, {res.perdidos} perdidos "
              f"({100 * res.perdidos / total:.2f}%)")
    if res.jitter_audio_ms is not None:
        print(f"jitter do áudio: {res.jitter_audio_ms:.1f} ms")
    resumo("RTT do canal de dados     ", res.rtts)
    resumo("Idade do quadro (captura→chegada)", res.idades)
    if args.csv:
        gravar_csv(args.csv, res)

    if res.idades:
        p95 = percentil(res.idades, 95)
        ok = p95 < args.meta
        print(f"\nVEREDITO: {'APROVADO' if ok else 'REPROVADO'} — p95 da idade do quadro = {p95:.1f} ms "
              f"(meta < {args.meta:.0f} ms)")
        return 0 if ok else 1

    if res.rtts:
        meia = percentil(res.rtts, 95) / 2
        ok = meia < args.meta
        print("\nAviso: nenhuma marca de tempo lida nos quadros (inicie o robô com MARCAR_TIMESTAMP=1 para "
              "medir captura→chegada).")
        print(f"VEREDITO INDICATIVO: {'APROVADO' if ok else 'REPROVADO'} — RTT p95/2 = {meia:.1f} ms "
              f"(meta < {args.meta:.0f} ms; não inclui captura/codificação)")
        return 0 if ok else 1

    print("ERRO: nenhuma amostra coletada.")
    return 2


if __name__ == "__main__":
    sys.exit(main())
