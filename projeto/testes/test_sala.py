"""Testes das regras da sala de sinalização (sem rede: conexões simuladas).

Rodar na pasta do projeto:  python -m pytest -q
"""
import asyncio
import json

import pytest

from servidor.sala import Sala


class WsFalso:
    """Conexão simulada: guarda as mensagens enviadas pelo servidor."""

    def __init__(self) -> None:
        self.recebidas = []
        self.fechada_com = None

    async def send_text(self, texto: str) -> None:
        if self.fechada_com is not None:
            raise RuntimeError("conexão fechada")
        self.recebidas.append(json.loads(texto))

    async def close(self, code: int = 1000) -> None:
        self.fechada_com = code

    def tipos(self):
        return [m["tipo"] for m in self.recebidas]

    def ultima(self, tipo):
        for m in reversed(self.recebidas):
            if m["tipo"] == tipo:
                return m
        return None

    def limpar(self) -> None:
        self.recebidas.clear()


def rodar(coro):
    return asyncio.run(coro)


async def montar(*papeis):
    sala = Sala()
    ws = {}
    for papel in papeis:
        ws[papel] = WsFalso()
        assert await sala.conectar(papel, ws[papel])
    for w in ws.values():
        w.limpar()
    return sala, ws


async def enviar(sala, papel, **msg):
    await sala.tratar(papel, json.dumps(msg))


# ------------------------------------------------------------ conexão
def test_conectar_envia_config_e_presenca():
    async def caso():
        sala = Sala()
        robo = WsFalso()
        await sala.conectar("robo", robo)
        assert robo.tipos()[:2] == ["config", "presenca"]
        assert robo.ultima("presenca")["robo"] is True
    rodar(caso())


def test_segundo_operador_substitui_o_primeiro():
    async def caso():
        sala, ws = await montar("robo", "operador")
        novo = WsFalso()
        assert await sala.conectar("operador", novo)
        assert ws["operador"].fechada_com == 4000
        assert sala.conexoes["operador"] is novo
    rodar(caso())


def test_segundo_cliente_recusado_durante_atendimento():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        outro = WsFalso()
        assert not await sala.conectar("cliente", outro)
        assert ws["cliente"].fechada_com is None
    rodar(caso())


# ------------------------------------------------------------ mensagens inválidas
@pytest.mark.parametrize("texto", ["não é json", "{}", '{"tipo": 3}', "[]"])
def test_mensagem_invalida(texto):
    async def caso():
        sala, ws = await montar("operador")
        await sala.tratar("operador", texto)
        assert ws["operador"].ultima("erro")["motivo"] == "mensagem_invalida"
    rodar(caso())


@pytest.mark.parametrize("papel,tipo", [("cliente", "iniciar"), ("cliente", "aceitar"),
                                        ("operador", "offer"), ("robo", "aceitar"),
                                        ("cliente", "mensagem")])
def test_tipo_nao_permitido(papel, tipo):
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, papel, tipo=tipo)
        assert ws[papel].ultima("erro")["motivo"] == "tipo_nao_permitido"
        assert sala.parceiro is None
    rodar(caso())


def test_ping_responde_pong():
    async def caso():
        sala, ws = await montar("cliente")
        await enviar(sala, "cliente", tipo="ping")
        assert ws["cliente"].tipos() == ["pong"]
    rodar(caso())


# ------------------------------------------------------------ sessão direta (RF06)
def test_iniciar_e_encerrar_sessao_direta():
    async def caso():
        sala, ws = await montar("robo", "operador")
        await enviar(sala, "operador", tipo="iniciar")
        assert sala.parceiro == "operador"
        assert ws["robo"].ultima("iniciar")["com"] == "operador"
        await enviar(sala, "robo", tipo="offer", sdp="x")
        assert ws["operador"].ultima("offer")["sdp"] == "x"
        await enviar(sala, "operador", tipo="answer", sdp="y")
        assert ws["robo"].ultima("answer")["sdp"] == "y"
        await enviar(sala, "operador", tipo="encerrar")
        assert sala.parceiro is None
        assert ws["robo"].ultima("encerrar") is not None
        assert ws["operador"].ultima("encerrar") is None  # quem pediu não recebe o eco
    rodar(caso())


def test_iniciar_sem_robo():
    async def caso():
        sala, ws = await montar("operador")
        await enviar(sala, "operador", tipo="iniciar")
        assert ws["operador"].ultima("erro")["motivo"] == "robo_ausente"
        assert sala.parceiro is None
    rodar(caso())


def test_robo_cai_durante_sessao_avisa_operador():
    async def caso():
        sala, ws = await montar("robo", "operador")
        await enviar(sala, "operador", tipo="iniciar")
        await sala.desconectar("robo", ws["robo"])
        assert sala.parceiro is None
        assert ws["operador"].ultima("encerrar")["motivo"] == "robo_desconectou"
        assert ws["operador"].ultima("presenca")["robo"] is False
    rodar(caso())


def test_operador_cai_durante_sessao_avisa_robo():
    async def caso():
        sala, ws = await montar("robo", "operador")
        await enviar(sala, "operador", tipo="iniciar")
        await sala.desconectar("operador", ws["operador"])
        assert ws["robo"].ultima("encerrar")["motivo"] == "operador_desconectou"
    rodar(caso())


def test_falha_do_robo_e_repassada():
    async def caso():
        sala, ws = await montar("robo", "operador")
        await enviar(sala, "operador", tipo="iniciar")
        await enviar(sala, "robo", tipo="status", estado="falhou")
        assert ws["operador"].ultima("status")["estado"] == "falhou"
    rodar(caso())


# ------------------------------------------------------------ atendimento ao cliente
def test_fluxo_completo_de_atendimento():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        assert sala.pedido
        assert "pedido" in ws["operador"].tipos()
        assert "aguardando" in ws["cliente"].tipos()

        await enviar(sala, "operador", tipo="aceitar")
        assert sala.parceiro == "cliente" and not sala.pedido
        assert ws["robo"].ultima("iniciar")["com"] == "cliente"
        assert "aceito" in ws["cliente"].tipos()

        await enviar(sala, "robo", tipo="offer", sdp="o")
        assert ws["cliente"].ultima("offer")["sdp"] == "o"
        assert ws["operador"].ultima("offer") is None  # a oferta vai só para o parceiro

        await enviar(sala, "robo", tipo="chat", de="cliente", texto="oi")
        assert ws["operador"].ultima("chat") == {"tipo": "chat", "de": "cliente", "texto": "oi"}

        await enviar(sala, "operador", tipo="mensagem", texto="olá")
        assert ws["cliente"].ultima("chat")["de"] == "operador"

        await enviar(sala, "cliente", tipo="encerrar")
        assert sala.parceiro is None
        assert ws["operador"].ultima("atendimento_fim") is not None
    rodar(caso())


def test_operador_recusa():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "operador", tipo="recusar")
        assert not sala.pedido
        assert ws["cliente"].ultima("recusado")["motivo"] == "operador_recusou"
    rodar(caso())


def test_cliente_cancela():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "cliente", tipo="cancelar")
        assert not sala.pedido
        assert ws["operador"].ultima("pedido_cancelado")["motivo"] == "cliente_cancelou"
    rodar(caso())


def test_pedir_sem_operador_ou_com_robo_ocupado():
    async def caso():
        sala, ws = await montar("robo", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        assert ws["cliente"].ultima("erro")["motivo"] == "operador_ausente"

        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "operador", tipo="iniciar")
        await enviar(sala, "cliente", tipo="pedir")
        assert ws["cliente"].ultima("erro")["motivo"] == "robo_em_uso"
        assert not sala.pedido
    rodar(caso())


def test_sessao_direta_com_pedido_pendente_recusa_o_cliente():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "operador", tipo="iniciar")
        assert sala.parceiro == "operador" and not sala.pedido
        assert ws["cliente"].ultima("recusado")["motivo"] == "robo_em_uso"
        assert ws["operador"].ultima("pedido_cancelado")["motivo"] == "sessao_direta"
    rodar(caso())


def test_operador_nao_inicia_durante_atendimento():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "operador", tipo="aceitar")
        await enviar(sala, "operador", tipo="iniciar")
        assert sala.parceiro == "cliente"
        assert ws["operador"].ultima("erro")["motivo"] == "robo_em_uso"
        await enviar(sala, "operador", tipo="answer", sdp="intruso")
        assert all(m.get("sdp") != "intruso" for m in ws["robo"].recebidas)
    rodar(caso())


def test_cliente_nao_fala_com_robo_sem_ser_aceito():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="answer", sdp="x")
        await enviar(sala, "operador", tipo="iniciar")
        await enviar(sala, "cliente", tipo="ice", candidato={})
        assert ws["robo"].ultima("answer") is None and ws["robo"].ultima("ice") is None
    rodar(caso())


@pytest.mark.parametrize("quem,motivo_cliente", [("operador", "operador_ausente"), ("robo", "robo_ausente")])
def test_queda_com_pedido_pendente_avisa_cliente(quem, motivo_cliente):
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await sala.desconectar(quem, ws[quem])
        assert not sala.pedido
        assert ws["cliente"].ultima("recusado")["motivo"] == motivo_cliente
    rodar(caso())


def test_queda_do_operador_encerra_atendimento():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "operador", tipo="aceitar")
        await sala.desconectar("operador", ws["operador"])
        assert sala.parceiro is None
        assert ws["cliente"].ultima("encerrar")["motivo"] == "operador_desconectou"
        assert ws["robo"].ultima("encerrar") is not None
    rodar(caso())


def test_queda_do_cliente_encerra_atendimento():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "operador", tipo="aceitar")
        await sala.desconectar("cliente", ws["cliente"])
        assert sala.parceiro is None
        assert ws["operador"].ultima("atendimento_fim")["motivo"] == "cliente_desconectou"
    rodar(caso())


def test_texto_longo_e_truncado():
    async def caso():
        sala, ws = await montar("robo", "operador", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await enviar(sala, "operador", tipo="aceitar")
        await enviar(sala, "operador", tipo="mensagem", texto="a" * 5000)
        assert len(ws["cliente"].ultima("chat")["texto"]) == 500
    rodar(caso())


def test_chat_do_robo_so_e_copiado_em_atendimento():
    async def caso():
        sala, ws = await montar("robo", "operador")
        await enviar(sala, "operador", tipo="iniciar")
        await enviar(sala, "robo", tipo="chat", de="robo", texto="x")
        assert ws["operador"].ultima("chat") is None
    rodar(caso())
