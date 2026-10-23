"""Cliente do robô: sinalização + WebRTC.

Fluxo: o operador manda "iniciar" -> o robô cria a oferta (vídeo + áudio +
canal de dados "ctrl") -> o operador responde -> mídia flui. Se o WebSocket cair,
a sessão é encerrada e o robô reconecta com espera exponencial; o operador
reinicia a sessão sozinho.
"""
import asyncio
import json
import logging
import sys
import threading
import time
from datetime import datetime
from typing import Optional

import websockets
from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
from aiortc.sdp import candidate_from_sdp

from comum import config
from .audio import AltoFalante, FaixaMicrofone, FonteMicrofone
from .camera import FaixaVideo, FonteVideo

log = logging.getLogger("robo")


class Robo:
    def __init__(self) -> None:
        self.video = FonteVideo()
        self.mic = FonteMicrofone()
        self.alto = AltoFalante()
        self.pc: Optional[RTCPeerConnection] = None
        self.ice = config.servidores_ice()  # o servidor envia a versão oficial ao conectar
        self.ws = None
        self.com = "operador"  # parceiro da sessão atual: "operador" ou "cliente"
        self.canal = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self.tarefa_audio: Optional[asyncio.Task] = None
        self._trava = asyncio.Lock()

    # -- chat com o operador ----------------------------------------------------
    def _responder(self, texto: str) -> str:
        cmd, _, resto = texto.strip().partition(" ")
        cmd = cmd.lower()
        if cmd == "ajuda":
            return "comandos: ajuda, status, hora, fps, eco <texto>"
        if cmd == "status":
            estado = self.pc.connectionState if self.pc else "sem sessão"
            return f"conexão: {estado}; vídeo {config.LARGURA}x{config.ALTURA} a {config.FPS} FPS"
        if cmd == "hora":
            return datetime.now().strftime("%d/%m/%Y %H:%M:%S")
        if cmd == "fps":
            return f"{config.FPS} FPS (limite da câmera)"
        if cmd == "eco":
            return resto or "(vazio)"
        return "recebi a mensagem. Digite 'ajuda' para ver os comandos."

    def _enviar_chat(self, texto: str) -> None:
        """Envia texto ao operador pelo canal de dados (chamar na thread do asyncio)."""
        canal = self.canal
        if canal is not None and canal.readyState == "open":
            canal.send(json.dumps({"t": "chat", "texto": texto}))
            self._relatar("robo", texto)
        else:
            log.info("ninguém conectado; mensagem não enviada")

    def _relatar(self, de: str, texto: str) -> None:
        """Em atendimento a cliente, copia a conversa ao operador (supervisão)."""
        ws = self.ws
        if ws is None or self.com != "cliente":
            return
        asyncio.ensure_future(self._enviar_ws(ws, {"tipo": "chat", "de": de, "texto": texto}))

    @staticmethod
    async def _enviar_ws(ws, obj: dict) -> None:
        try:
            await ws.send(json.dumps(obj))
        except Exception:
            pass

    def _ler_teclado(self) -> None:
        """Thread: o que for digitado nesta janela vai para o operador."""
        if not sys.stdin or not sys.stdin.isatty():
            return
        log.info("digite uma mensagem aqui e aperte Enter para falar com o operador")
        while True:
            try:
                linha = input().strip()
            except (EOFError, KeyboardInterrupt, OSError):
                return
            if not linha:
                continue
            try:
                self._loop.call_soon_threadsafe(self._enviar_chat, linha[:500])
            except RuntimeError:
                return

    # -- laço principal com reconexão -----------------------------------------
    async def executar(self) -> None:
        loop = asyncio.get_running_loop()
        self._loop = loop
        threading.Thread(target=self._ler_teclado, name="teclado", daemon=True).start()
        self.video.iniciar(loop)
        self.mic.iniciar(loop)
        self.alto.iniciar()

        espera = config.RECONEXAO_MIN_S
        url = f"{config.URL_SERVIDOR}?token={config.TOKEN_ROBO}"
        while True:
            try:
                async with websockets.connect(url, ping_interval=10, ping_timeout=10,
                                              max_size=2 ** 20) as ws:
                    log.info("conectado ao servidor de sinalização")
                    espera = config.RECONEXAO_MIN_S
                    self.ws = ws
                    await self._ouvir(ws)
            except websockets.ConnectionClosed as exc:
                codigo = exc.rcvd.code if exc.rcvd else None
                if codigo == 4401:
                    log.error("servidor recusou o token do robô (TOKEN_ROBO)")
                    espera = config.RECONEXAO_MAX_S
                elif codigo == 4000:
                    log.error("OUTRO robô conectou com o mesmo token e substituiu este. "
                              "Há dois robôs rodando? Feche as outras janelas do robô. Encerrando.")
                    return
                else:
                    log.warning("conexão com o servidor encerrada (%s)", codigo)
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as exc:
                log.warning("não foi possível falar com o servidor: %s", exc)
            except asyncio.CancelledError:
                await self._encerrar_sessao()
                raise
            except Exception:
                log.exception("erro inesperado no laço de sinalização")
            finally:
                self.ws = None
                await self._encerrar_sessao()
            log.info("reconectando em %.0fs", espera)
            await asyncio.sleep(espera)
            espera = min(espera * 2, config.RECONEXAO_MAX_S)

    async def _ouvir(self, ws) -> None:
        async for bruto in ws:
            try:
                msg = json.loads(bruto)
                tipo = msg.get("tipo")
                if tipo == "iniciar":
                    await self._iniciar_sessao(ws, msg.get("com", "operador"))
                elif tipo == "answer":
                    await self._tratar_answer(msg)
                elif tipo == "ice":
                    await self._tratar_ice(msg)
                elif tipo == "encerrar":
                    log.info("sessão encerrada pelo servidor (%s)", msg.get("motivo", "-"))
                    await self._encerrar_sessao()
                elif tipo == "config":
                    self.ice = msg.get("ice") or []
                    log.info("configuração ICE recebida (%d servidor(es))", len(self.ice))
                elif tipo in ("presenca", "erro"):
                    log.info("servidor: %s", msg)
            except Exception:
                log.exception("falha ao tratar mensagem; continuando")

    # -- sessão WebRTC ----------------------------------------------------------
    async def _iniciar_sessao(self, ws, com: str = "operador") -> None:
        async with self._trava:
            await self._encerrar_sessao_sem_trava()
            self.com = com if com in ("operador", "cliente") else "operador"
            servidores = [RTCIceServer(urls=s["urls"], username=s.get("username"),
                                       credential=s.get("credential")) for s in self.ice]
            pc = RTCPeerConnection(RTCConfiguration(iceServers=servidores))
            self.pc = pc

            if self.com == "operador":  # clientes recebem só áudio e chat, nunca a câmera
                pc.addTrack(FaixaVideo(self.video))
            pc.addTrack(FaixaMicrofone(self.mic))
            canal = pc.createDataChannel("ctrl")
            self.canal = canal

            @canal.on("message")
            def ao_receber(dados):
                try:
                    m = json.loads(dados)
                    tipo = m.get("t")
                    if tipo == "ping":  # eco para o operador medir a latência (RTT)
                        # "agora" (relógio do robô) permite ao operador estimar a diferença
                        # entre os relógios e medir a idade do quadro sem NTP
                        canal.send(json.dumps({"t": "pong", "ts": m.get("ts"), "tw": m.get("tw"),
                                               "agora": time.time() * 1000}))
                    elif tipo == "chat":
                        texto = str(m.get("texto", ""))[:500]
                        log.info("%s: %s", self.com, texto)
                        self._relatar("cliente", texto)
                        self._enviar_chat(self._responder(texto))
                except Exception:
                    log.exception("falha ao tratar mensagem do canal de dados")

            @pc.on("track")
            def ao_chegar_faixa(faixa):
                if faixa.kind == "audio":
                    log.info("recebendo áudio do operador")
                    if self.tarefa_audio:
                        self.tarefa_audio.cancel()
                    self.tarefa_audio = asyncio.create_task(self.alto.tocar(faixa))

            @pc.on("connectionstatechange")
            async def ao_mudar_estado():
                log.info("estado da conexão: %s", pc.connectionState)
                if pc is not self.pc:
                    return
                if pc.connectionState == "failed":
                    await self._encerrar_sessao()
                    try:
                        await ws.send(json.dumps({"tipo": "status", "estado": "falhou"}))
                    except Exception:
                        pass

            await pc.setLocalDescription(await pc.createOffer())
            await ws.send(json.dumps({"tipo": "offer", "sdp": pc.localDescription.sdp}))
            log.info("sessão iniciada: oferta enviada")

    async def _tratar_answer(self, msg: dict) -> None:
        if self.pc is None:
            return
        await self.pc.setRemoteDescription(RTCSessionDescription(sdp=msg["sdp"], type="answer"))

    async def _tratar_ice(self, msg: dict) -> None:
        cand = msg.get("candidato")
        if self.pc is None or not cand or not cand.get("candidate"):
            return  # fim da coleta ou sessão inexistente
        texto = cand["candidate"]
        if texto.startswith("candidate:"):
            texto = texto[len("candidate:"):]
        c = candidate_from_sdp(texto)
        c.sdpMid = cand.get("sdpMid")
        c.sdpMLineIndex = cand.get("sdpMLineIndex")
        await self.pc.addIceCandidate(c)

    async def _encerrar_sessao(self) -> None:
        async with self._trava:
            await self._encerrar_sessao_sem_trava()

    async def _encerrar_sessao_sem_trava(self) -> None:
        if self.tarefa_audio:
            self.tarefa_audio.cancel()
            self.tarefa_audio = None
        pc, self.pc = self.pc, None
        self.canal = None
        if pc is not None:
            try:
                await pc.close()
            except Exception:
                log.exception("erro ao fechar a conexão")
            log.info("sessão encerrada")
