"""Captura de vídeo do robô.

A captura roda em uma thread própria, lê a webcam continuamente (para esvaziar o
buffer do driver) e publica no máximo FPS quadros por segundo. Só o quadro mais
recente é mantido: se o transmissor estiver atrasado, os antigos são descartados.
"""
import asyncio
import logging
import threading
import time
from fractions import Fraction
from typing import Optional

import av
import numpy as np
from aiortc import MediaStreamTrack
from aiortc.mediastreams import MediaStreamError

from comum import config, marca

try:
    import cv2
except ImportError:  # permite rodar com SINTETICA=1 sem OpenCV
    cv2 = None

log = logging.getLogger("robo.camera")


def quadro_sem_sinal(largura: int, altura: int) -> np.ndarray:
    quadro = np.zeros((altura, largura, 3), dtype=np.uint8)
    if cv2 is not None:
        cv2.putText(quadro, "SEM SINAL DA CAMERA", (20, altura // 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    else:
        quadro[:, :, 2] = 80
    return quadro


class FonteVideo:
    """Webcam em thread dedicada com slot único (apenas o quadro mais recente)."""

    def __init__(self) -> None:
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._evento: Optional[asyncio.Event] = None
        self._ultimo: Optional[np.ndarray] = None
        self._parar = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # -- ciclo de vida ---------------------------------------------------------
    def iniciar(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._evento = asyncio.Event()
        self._thread = threading.Thread(target=self._capturar, name="captura-video", daemon=True)
        self._thread.start()

    def parar(self) -> None:
        self._parar.set()

    # -- lado assíncrono -------------------------------------------------------
    def _publicar(self, quadro: np.ndarray) -> None:
        self._ultimo = quadro  # sobrescreve: só o mais recente interessa
        self._evento.set()

    def descartar(self) -> None:
        self._ultimo = None
        if self._evento is not None:
            self._evento.clear()

    async def obter(self, timeout: float) -> Optional[np.ndarray]:
        try:
            await asyncio.wait_for(self._evento.wait(), timeout)
        except asyncio.TimeoutError:
            return None
        self._evento.clear()
        return self._ultimo

    # -- thread de captura -----------------------------------------------------
    def _entregar(self, quadro: np.ndarray) -> bool:
        if config.MARCAR_TIMESTAMP:
            marca.escrever(quadro, int(time.time() * 1000))
        try:
            self._loop.call_soon_threadsafe(self._publicar, quadro)
            return True
        except RuntimeError:  # loop encerrado
            return False

    def _capturar(self) -> None:
        if config.SINTETICA:
            self._capturar_sintetico()
            return
        if cv2 is None:
            log.error("OpenCV não instalado; use SINTETICA=1 ou instale opencv-python")
            return
        intervalo = 1.0 / config.FPS
        espera = config.RECONEXAO_MIN_S
        while not self._parar.is_set():
            cap = cv2.VideoCapture(config.INDICE_CAMERA)
            if not cap.isOpened():
                log.warning("não consegui abrir a câmera %s; nova tentativa em %.0fs",
                            config.INDICE_CAMERA, espera)
                cap.release()
                self._parar.wait(espera)
                espera = min(espera * 2, config.RECONEXAO_MAX_S)
                continue
            espera = config.RECONEXAO_MIN_S
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.LARGURA)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.ALTURA)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            log.info("câmera %s aberta (limitada a %d FPS)", config.INDICE_CAMERA, config.FPS)

            falhas = 0
            proxima = 0.0
            while not self._parar.is_set():
                ok, quadro = cap.read()  # leitura contínua mantém o buffer do driver vazio
                if not ok or quadro is None:
                    falhas += 1
                    if falhas >= 10:
                        log.warning("câmera parou de responder; reabrindo")
                        break
                    time.sleep(0.05)
                    continue
                falhas = 0
                agora = time.monotonic()
                if agora < proxima:
                    continue  # excede o limite de FPS: descarta
                proxima = agora + intervalo
                if quadro.shape[1] != config.LARGURA or quadro.shape[0] != config.ALTURA:
                    quadro = cv2.resize(quadro, (config.LARGURA, config.ALTURA))
                if not self._entregar(quadro):
                    break
            cap.release()
        log.info("captura de vídeo encerrada")

    def _capturar_sintetico(self) -> None:
        """Quadros de teste (barras + bloco em movimento) para rodar sem webcam."""
        log.info("fonte de vídeo SINTÉTICA ativa (%d FPS)", config.FPS)
        intervalo = 1.0 / config.FPS
        n = 0
        proximo = time.monotonic()
        while not self._parar.is_set():
            quadro = np.zeros((config.ALTURA, config.LARGURA, 3), dtype=np.uint8)
            quadro[:, :, 0] = np.linspace(0, 255, config.LARGURA, dtype=np.uint8)[None, :]
            x = (n * 12) % (config.LARGURA - 60)
            quadro[config.ALTURA // 2:config.ALTURA // 2 + 60, x:x + 60] = (0, 255, 255)
            n += 1
            if not self._entregar(quadro):
                break
            proximo += intervalo
            self._parar.wait(max(0.0, proximo - time.monotonic()))


class FaixaVideo(MediaStreamTrack):
    """Faixa de vídeo de uma sessão: entrega sempre o quadro mais recente."""

    kind = "video"

    def __init__(self, fonte: FonteVideo) -> None:
        super().__init__()
        self._fonte = fonte
        self._t0: Optional[float] = None
        fonte.descartar()

    async def recv(self) -> av.VideoFrame:
        if self.readyState != "live":
            raise MediaStreamError
        quadro = await self._fonte.obter(1.0)
        if quadro is None:  # câmera muda: mantém o fluxo vivo com aviso visível
            quadro = quadro_sem_sinal(config.LARGURA, config.ALTURA)
        agora = time.monotonic()
        if self._t0 is None:
            self._t0 = agora
        vf = av.VideoFrame.from_ndarray(quadro, format="bgr24")
        vf.pts = int((agora - self._t0) * 90000)
        vf.time_base = Fraction(1, 90000)
        return vf
