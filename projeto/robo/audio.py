"""Áudio do robô: microfone -> faixa Opus; áudio do operador -> alto-falante.

sounddevice roda os callbacks em threads próprias do PortAudio; a ponte com o
asyncio é feita por call_soon_threadsafe (microfone) e por um buffer protegido
por lock (alto-falante).
"""
import asyncio
import collections
import logging
import threading
from fractions import Fraction
from typing import Deque, Optional

import av
import numpy as np
from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

from comum import config

try:
    import sounddevice as sd
except (ImportError, OSError) as exc:  # sem PortAudio / sem sounddevice
    sd = None
    _ERRO_SD = exc

log = logging.getLogger("robo.audio")


class FonteMicrofone:
    """Captura do microfone em blocos de 20 ms, mantendo só os mais recentes."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._fila: Optional[asyncio.Queue] = None
        self._parar = threading.Event()

    def iniciar(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._fila = asyncio.Queue(maxsize=5)  # ~100 ms: descarta o mais antigo se encher
        if sd is None:
            log.warning("sounddevice indisponível (%s); microfone enviará silêncio", _ERRO_SD)
            return
        threading.Thread(target=self._supervisor, name="captura-audio", daemon=True).start()

    def parar(self) -> None:
        self._parar.set()

    def _callback(self, indata, frames, tempo, status) -> None:
        if status:
            log.debug("microfone: %s", status)
        bloco = indata[:, 0].copy()
        try:
            self._loop.call_soon_threadsafe(self._empurrar, bloco)
        except RuntimeError:
            pass

    def _empurrar(self, bloco: np.ndarray) -> None:
        if self._fila.full():
            self._fila.get_nowait()
        self._fila.put_nowait(bloco)

    def _supervisor(self) -> None:
        espera = config.RECONEXAO_MIN_S
        while not self._parar.is_set():
            try:
                with sd.InputStream(samplerate=config.TAXA_AUDIO, channels=1, dtype="int16",
                                    blocksize=config.BLOCO_AUDIO, device=config.DISPOSITIVO_ENTRADA,
                                    callback=self._callback) as fluxo:
                    log.info("microfone aberto")
                    espera = config.RECONEXAO_MIN_S
                    while not self._parar.is_set() and fluxo.active:
                        self._parar.wait(0.5)
            except Exception as exc:
                log.warning("falha no microfone: %s; nova tentativa em %.0fs", exc, espera)
            self._parar.wait(espera)
            espera = min(espera * 2, config.RECONEXAO_MAX_S)

    def descartar(self) -> None:
        while self._fila is not None and not self._fila.empty():
            self._fila.get_nowait()

    async def obter(self, timeout: float) -> Optional[np.ndarray]:
        try:
            return await asyncio.wait_for(self._fila.get(), timeout)
        except asyncio.TimeoutError:
            return None


class FaixaMicrofone(MediaStreamTrack):
    """Faixa de áudio de uma sessão (aiortc codifica em Opus)."""

    kind = "audio"

    def __init__(self, fonte: FonteMicrofone) -> None:
        super().__init__()
        self._fonte = fonte
        self._pts = 0
        fonte.descartar()

    async def recv(self) -> av.AudioFrame:
        if self.readyState != "live":
            raise MediaStreamError
        dados = await self._fonte.obter(0.1)
        if dados is None:  # sem microfone: envia 100 ms de silêncio para manter o fluxo
            dados = np.zeros(config.TAXA_AUDIO // 10, dtype=np.int16)
        quadro = av.AudioFrame.from_ndarray(dados.reshape(1, -1), format="s16", layout="mono")
        quadro.sample_rate = config.TAXA_AUDIO
        quadro.pts = self._pts
        quadro.time_base = Fraction(1, config.TAXA_AUDIO)
        self._pts += len(dados)
        return quadro


class AltoFalante:
    """Reproduz o áudio do operador; descarta o excesso para não acumular atraso."""

    def __init__(self) -> None:
        self._buf: Deque[np.ndarray] = collections.deque()
        self._tam = 0
        self._lock = threading.Lock()
        self._max = config.TAXA_AUDIO * config.ATRASO_MAX_SAIDA_MS // 1000
        self._parar = threading.Event()

    def iniciar(self) -> None:
        if sd is None:
            log.warning("sounddevice indisponível; áudio do operador será descartado")
            return
        threading.Thread(target=self._supervisor, name="reproducao-audio", daemon=True).start()

    def parar(self) -> None:
        self._parar.set()

    def _callback(self, saida, frames, tempo, status) -> None:
        pedacos = []
        faltam = frames
        with self._lock:
            while faltam > 0 and self._buf:
                bloco = self._buf[0]
                if len(bloco) <= faltam:
                    pedacos.append(bloco)
                    self._buf.popleft()
                    faltam -= len(bloco)
                else:
                    pedacos.append(bloco[:faltam])
                    self._buf[0] = bloco[faltam:]
                    faltam = 0
            self._tam -= frames - faltam
        dados = np.concatenate(pedacos) if pedacos else np.zeros(0, dtype=np.int16)
        saida[:, 0] = 0
        saida[:len(dados), 0] = dados

    def _supervisor(self) -> None:
        espera = config.RECONEXAO_MIN_S
        while not self._parar.is_set():
            try:
                with sd.OutputStream(samplerate=config.TAXA_AUDIO, channels=1, dtype="int16",
                                     blocksize=config.BLOCO_AUDIO, device=config.DISPOSITIVO_SAIDA,
                                     callback=self._callback) as fluxo:
                    log.info("alto-falante aberto")
                    espera = config.RECONEXAO_MIN_S
                    while not self._parar.is_set() and fluxo.active:
                        self._parar.wait(0.5)
            except Exception as exc:
                log.warning("falha no alto-falante: %s; nova tentativa em %.0fs", exc, espera)
            self._parar.wait(espera)
            espera = min(espera * 2, config.RECONEXAO_MAX_S)

    def escrever(self, dados: np.ndarray) -> None:
        with self._lock:
            self._buf.append(dados)
            self._tam += len(dados)
            while self._tam > self._max and len(self._buf) > 1:
                self._tam -= len(self._buf.popleft())

    async def tocar(self, faixa: MediaStreamTrack) -> None:
        """Consome a faixa de áudio remota até ela terminar."""
        reamostrador = av.AudioResampler(format="s16", layout="mono", rate=config.TAXA_AUDIO)
        try:
            while True:
                quadro = await faixa.recv()
                saidas = reamostrador.resample(quadro)
                if not isinstance(saidas, list):
                    saidas = [saidas]
                for s in saidas:
                    if s is not None:
                        self.escrever(s.to_ndarray().reshape(-1))
        except MediaStreamError:
            log.info("faixa de áudio do operador terminou")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("erro ao reproduzir áudio do operador")
