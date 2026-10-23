"""Testes do modo ator: aceite automático, certificado HTTPS, páginas e detector de emoção.

Rodar na pasta do projeto:  python -m pytest -q
"""
import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from comum import config
from servidor.sala import Sala
from testes.test_sala import WsFalso, enviar, montar

RAIZ = Path(__file__).resolve().parent.parent


@pytest.fixture
def modo_ator(monkeypatch):
    monkeypatch.setattr(config, "AUTO_ACEITAR", True)


def test_cliente_entra_direto_sem_operador(modo_ator):
    async def caso():
        sala, ws = await montar("robo", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        assert sala.parceiro == "cliente" and not sala.pedido
        assert ws["robo"].ultima("iniciar")["com"] == "cliente"
        assert "aceito" in ws["cliente"].tipos()
        # mídia e ICE fluem entre ator (papel robo) e cliente, nos dois sentidos
        await enviar(sala, "robo", tipo="offer", sdp="o")
        await enviar(sala, "cliente", tipo="answer", sdp="a")
        await enviar(sala, "cliente", tipo="ice", candidato={"candidate": "c1"})
        await enviar(sala, "robo", tipo="ice", candidato={"candidate": "c2"})
        assert ws["cliente"].ultima("offer")["sdp"] == "o"
        assert ws["robo"].ultima("answer")["sdp"] == "a"
        assert ws["robo"].ultima("ice")["candidato"]["candidate"] == "c1"
        assert ws["cliente"].ultima("ice")["candidato"]["candidate"] == "c2"
    asyncio.run(caso())


def test_sem_ator_o_cliente_espera(modo_ator):
    async def caso():
        sala, ws = await montar("cliente")
        await enviar(sala, "cliente", tipo="pedir")
        assert ws["cliente"].ultima("erro")["motivo"] == "robo_ausente"
        assert sala.parceiro is None
    asyncio.run(caso())


def test_cliente_reconectando_substitui_o_antigo(modo_ator):
    async def caso():
        sala, ws = await montar("robo", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        novo = WsFalso()
        assert await sala.conectar("cliente", novo)          # no modo normal seria recusado (4409)
        assert ws["cliente"].fechada_com == 4000
        assert sala.parceiro is None                          # a conversa antiga terminou
        assert ws["robo"].ultima("encerrar") is not None      # o ator foi avisado
        await sala.tratar("cliente", json.dumps({"tipo": "pedir"}))
        assert sala.parceiro == "cliente"
    asyncio.run(caso())


def test_ator_cai_e_cliente_e_avisado(modo_ator):
    async def caso():
        sala, ws = await montar("robo", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        await sala.desconectar("robo", ws["robo"])
        assert ws["cliente"].ultima("encerrar")["motivo"] == "robo_desconectou"
    asyncio.run(caso())


def test_modo_normal_continua_exigindo_operador():
    async def caso():
        sala, ws = await montar("robo", "cliente")
        await enviar(sala, "cliente", tipo="pedir")
        assert ws["cliente"].ultima("erro")["motivo"] == "operador_ausente"
    asyncio.run(caso())


def test_certificado_cobre_os_ips_e_e_reaproveitado(tmp_path):
    from cryptography import x509
    from servidor import certificado
    cert, chave = certificado.garantir(tmp_path)
    assert cert.exists() and chave.exists()
    c = x509.load_pem_x509_certificate(cert.read_bytes())
    san = c.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    ips = [str(i) for i in san.get_values_for_type(x509.IPAddress)]
    assert "127.0.0.1" in ips and set(certificado.ips_locais()) <= set(ips)
    assert "localhost" in san.get_values_for_type(x509.DNSName)
    antes = cert.read_bytes()
    certificado.garantir(tmp_path)
    assert cert.read_bytes() == antes        # mesmo certificado: o navegador não avisa de novo


def test_paginas_do_modo_ator_sao_servidas():
    from fastapi.testclient import TestClient
    from servidor import main
    with TestClient(main.app) as cliente:
        assert "Ator do robô" in cliente.get("/ator/").text
        conversa = cliente.get("/conversa/").text
        assert "rosto" in conversa and "emocao.js" in conversa
        assert cliente.get("/conversa/rosto.js").status_code == 200


def test_detector_de_emocao_em_portugues():
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js não instalado")
    r = subprocess.run([node, str(RAIZ / "testes" / "emocao.test.js")], capture_output=True, text=True,
                       encoding="utf-8")
    assert r.returncode == 0, r.stdout + r.stderr
