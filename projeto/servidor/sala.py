"""Regras da sala de sinalização (sem FastAPI: pode ser testada sozinha).

Papéis:
  robo      um só. Fala com UM parceiro por vez.
  operador  um só. Supervisiona. Pode abrir sessão direta (vídeo + áudio + chat)
            ou aceitar o pedido de um cliente.
  cliente   um por vez. Pede atendimento; se o operador aceitar, fala com o robô
            por áudio e chat (o robô NÃO envia vídeo ao cliente).

Parceiro do robô: "operador" (sessão direta) ou "cliente" (atendimento).
"""
import json
import logging
from typing import Dict, Optional

from comum import config

log = logging.getLogger("servidor.sala")

PERMITIDAS = {
    "operador": {"iniciar", "encerrar", "aceitar", "recusar", "encerrar_atendimento",
                 "mensagem", "answer", "ice"},
    "cliente": {"pedir", "cancelar", "encerrar", "answer", "ice"},
    "robo": {"offer", "ice", "status", "chat", "encerrar"},
}
MAX_TEXTO = 500


class Sala:
    def __init__(self) -> None:
        self.conexoes: Dict[str, object] = {}
        self.parceiro: Optional[str] = None   # quem está em sessão com o robô
        self.pedido = False                   # cliente aguardando o operador

    # ------------------------------------------------------------------ envio
    async def _enviar(self, papel: str, msg: dict) -> bool:
        ws = self.conexoes.get(papel)
        if ws is None:
            return False
        try:
            await ws.send_text(json.dumps(msg))
            return True
        except Exception as exc:  # conexão quebrada: o handler dela fará a limpeza
            log.warning("falha ao enviar para %s: %s", papel, exc)
            return False

    def _estado(self):
        return (tuple(sorted(self.conexoes)), self.parceiro, self.pedido)

    async def _presenca(self) -> None:
        msg = {
            "tipo": "presenca",
            "robo": "robo" in self.conexoes,
            "operador": "operador" in self.conexoes,
            "cliente": "cliente" in self.conexoes,
            "ocupado": self.parceiro is not None,
            "em_uso_por": self.parceiro,
            "pedido": self.pedido,
        }
        for papel in list(self.conexoes):
            await self._enviar(papel, msg)

    # --------------------------------------------------------- entrada / saída
    async def conectar(self, papel: str, ws) -> bool:
        """Registra a conexão. Retorna False se deve ser recusada (cliente ocupado)."""
        antigo = self.conexoes.get(papel)
        if antigo is not None:
            if (papel == "cliente" and (self.parceiro == "cliente" or self.pedido)
                    and not config.AUTO_ACEITAR):
                return False  # não derruba um cliente que já está sendo atendido
            # no modo ator há um só computador de cliente: a reconexão dele substitui a antiga
            log.info("%s já conectado; substituindo conexão antiga", papel)
            try:
                await antigo.close(code=4000)
            except Exception:
                pass
            del self.conexoes[papel]
            await self._ao_sair(papel)
        self.conexoes[papel] = ws
        await self._enviar(papel, {"tipo": "config", "ice": config.servidores_ice()})
        await self._presenca()
        return True

    async def desconectar(self, papel: str, ws) -> None:
        if self.conexoes.get(papel) is not ws:  # já foi substituída
            return
        del self.conexoes[papel]
        await self._ao_sair(papel)
        await self._presenca()

    async def _ao_sair(self, papel: str) -> None:
        if papel == "robo":
            if self.pedido:
                self.pedido = False
                await self._enviar("operador", {"tipo": "pedido_cancelado", "motivo": "robo_desconectou"})
                await self._enviar("cliente", {"tipo": "recusado", "motivo": "robo_ausente"})
            await self._encerrar("robo_desconectou")
        elif papel == "operador":
            if self.pedido:
                self.pedido = False
                await self._enviar("cliente", {"tipo": "recusado", "motivo": "operador_ausente"})
            await self._encerrar("operador_desconectou")
        elif papel == "cliente":
            if self.pedido:
                self.pedido = False
                await self._enviar("operador", {"tipo": "pedido_cancelado", "motivo": "cliente_desconectou"})
            await self._encerrar("cliente_desconectou")

    async def _encerrar(self, motivo: str, origem: Optional[str] = None) -> None:
        """Termina a sessão atual avisando robô e parceiro (menos quem pediu)."""
        atual = self.parceiro
        if atual is None:
            return
        self.parceiro = None
        msg = {"tipo": "encerrar", "motivo": motivo}
        for destino in {"robo", atual} - {origem}:
            await self._enviar(destino, msg)
        if atual == "cliente":  # o operador supervisiona: sempre sabe que acabou
            await self._enviar("operador", {"tipo": "atendimento_fim", "motivo": motivo})

    # ------------------------------------------------------------- mensagens
    async def tratar(self, papel: str, texto: str) -> None:
        try:
            msg = json.loads(texto)
            tipo = msg["tipo"]
            if not isinstance(tipo, str):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            await self._enviar(papel, {"tipo": "erro", "motivo": "mensagem_invalida"})
            return

        if tipo == "ping":  # keepalive: evita que proxies/túneis derrubem conexões ociosas
            await self._enviar(papel, {"tipo": "pong"})
            return
        if tipo not in PERMITIDAS[papel]:
            await self._enviar(papel, {"tipo": "erro", "motivo": "tipo_nao_permitido", "detalhe": tipo})
            return

        antes = self._estado()
        await getattr(self, "_de_" + papel)(tipo, msg)
        if self._estado() != antes:
            await self._presenca()

    async def _erro(self, papel: str, motivo: str) -> None:
        await self._enviar(papel, {"tipo": "erro", "motivo": motivo})

    @staticmethod
    def _texto(msg: dict, campo: str = "texto") -> str:
        return str(msg.get(campo, ""))[:MAX_TEXTO]

    async def _de_operador(self, tipo: str, msg: dict) -> None:
        if tipo == "iniciar":
            if "robo" not in self.conexoes:
                await self._erro("operador", "robo_ausente")
            elif self.parceiro is not None:
                await self._erro("operador", "robo_em_uso")
            else:
                if self.pedido:  # sessão direta tem prioridade sobre um pedido pendente
                    self.pedido = False
                    await self._enviar("cliente", {"tipo": "recusado", "motivo": "robo_em_uso"})
                    await self._enviar("operador", {"tipo": "pedido_cancelado", "motivo": "sessao_direta"})
                self.parceiro = "operador"
                await self._enviar("robo", {"tipo": "iniciar", "com": "operador"})
        elif tipo == "encerrar":
            motivo = self._texto(msg, "motivo")[:60] or "operador"
            if self.parceiro == "operador":
                await self._encerrar(motivo, origem="operador")
            elif self.parceiro is None:  # limpeza de sobras no robô
                await self._enviar("robo", {"tipo": "encerrar", "motivo": motivo})
        elif tipo == "aceitar":
            if not self.pedido:
                await self._erro("operador", "sem_pedido")
            elif "cliente" not in self.conexoes:
                self.pedido = False
                await self._erro("operador", "cliente_ausente")
            elif "robo" not in self.conexoes:
                self.pedido = False
                await self._enviar("cliente", {"tipo": "recusado", "motivo": "robo_ausente"})
                await self._erro("operador", "robo_ausente")
            elif self.parceiro is not None:
                await self._erro("operador", "robo_em_uso")
            else:
                self.pedido = False
                self.parceiro = "cliente"
                await self._enviar("robo", {"tipo": "iniciar", "com": "cliente"})
                await self._enviar("cliente", {"tipo": "aceito"})
        elif tipo == "recusar":
            if self.pedido:
                self.pedido = False
                await self._enviar("cliente", {"tipo": "recusado", "motivo": "operador_recusou"})
        elif tipo == "encerrar_atendimento":
            if self.parceiro == "cliente":
                await self._encerrar("operador_encerrou", origem="operador")
        elif tipo == "mensagem":
            if self.parceiro == "cliente":
                await self._enviar("cliente", {"tipo": "chat", "de": "operador", "texto": self._texto(msg)})
            else:
                await self._erro("operador", "sem_atendimento")
        elif tipo in ("answer", "ice"):
            if self.parceiro == "operador":
                await self._enviar("robo", msg)

    async def _de_cliente(self, tipo: str, msg: dict) -> None:
        if tipo == "pedir":
            if "robo" not in self.conexoes:
                await self._erro("cliente", "robo_ausente")
            elif config.AUTO_ACEITAR and self.parceiro is None:
                # modo ator: não há operador; o cliente entra direto na conversa
                self.pedido = False
                self.parceiro = "cliente"
                await self._enviar("robo", {"tipo": "iniciar", "com": "cliente"})
                await self._enviar("cliente", {"tipo": "aceito"})
            elif "operador" not in self.conexoes:
                await self._erro("cliente", "operador_ausente")
            elif self.parceiro is not None:
                await self._erro("cliente", "robo_em_uso")
            elif self.pedido:
                await self._enviar("cliente", {"tipo": "aguardando"})
            else:
                self.pedido = True
                await self._enviar("operador", {"tipo": "pedido"})
                await self._enviar("cliente", {"tipo": "aguardando"})
        elif tipo == "cancelar":
            if self.pedido:
                self.pedido = False
                await self._enviar("operador", {"tipo": "pedido_cancelado", "motivo": "cliente_cancelou"})
        elif tipo == "encerrar":
            if self.parceiro == "cliente":
                await self._encerrar("cliente", origem="cliente")
        elif tipo in ("answer", "ice"):
            if self.parceiro == "cliente":
                await self._enviar("robo", msg)

    async def _de_robo(self, tipo: str, msg: dict) -> None:
        if tipo in ("offer", "ice", "status"):
            if self.parceiro is not None:
                await self._enviar(self.parceiro, msg)
        elif tipo == "chat":
            de = msg.get("de")
            if self.parceiro == "cliente" and de in ("cliente", "robo"):
                await self._enviar("operador", {"tipo": "chat", "de": de, "texto": self._texto(msg)})
        elif tipo == "encerrar":
            await self._encerrar(self._texto(msg, "motivo")[:60] or "robo", origem="robo")
