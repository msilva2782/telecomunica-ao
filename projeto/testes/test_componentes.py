"""Testes de componentes sem hardware: marca de tempo, autenticação e captura sintética.

Rodar na pasta do projeto:  python -m pytest -q
"""
import asyncio
import time

import numpy as np

from comum import config, marca


def test_marca_de_tempo_ida_e_volta():
    quadro = np.zeros((480, 640, 3), dtype=np.uint8)
    ts = int(time.time() * 1000)
    marca.escrever(quadro, ts)
    assert marca.ler(quadro[:, :, 0]) == ts


def test_marca_corrompida_e_rejeitada():
    quadro = np.zeros((480, 640), dtype=np.uint8)
    marca.escrever(quadro, 1_700_000_000_000)
    quadro[0:10, 0:10] = 255 - quadro[0:10, 0:10]   # inverte um bit
    assert marca.ler(quadro) is None


def test_quadro_sem_marca_e_rejeitado():
    assert marca.ler(np.zeros((480, 640), dtype=np.uint8)) is None


def test_autenticacao_por_papel(monkeypatch):
    from servidor import main
    monkeypatch.setattr(config, "TOKEN_ROBO", "r1")
    monkeypatch.setattr(config, "TOKEN_OPERADOR", "o1")
    monkeypatch.setattr(config, "TOKEN_CLIENTE", "c1")
    assert main.autenticar("r1") == "robo"
    assert main.autenticar("o1") == "operador"
    assert main.autenticar("c1") == "cliente"
    assert main.autenticar("errado") is None
    assert main.autenticar("") is None


def test_websocket_recusa_token_invalido(monkeypatch):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    from servidor import main
    monkeypatch.setattr(main.asyncio, "sleep", _sem_espera)
    with TestClient(main.app) as cliente:
        try:
            with cliente.websocket_connect("/ws?token=errado") as ws:
                ws.receive_text()
            fechou = None
        except WebSocketDisconnect as exc:
            fechou = exc.code
    assert fechou == 4401


def test_websocket_login_valido_recebe_config(monkeypatch):
    from fastapi.testclient import TestClient
    from servidor import main
    monkeypatch.setattr(config, "TOKEN_OPERADOR", "op-teste")
    with TestClient(main.app) as cliente:
        with cliente.websocket_connect("/ws?token=op-teste") as ws:
            assert ws.receive_json()["tipo"] == "config"
            assert ws.receive_json()["tipo"] == "presenca"


def test_paginas_sao_servidas():
    from fastapi.testclient import TestClient
    from servidor import main
    with TestClient(main.app) as cliente:
        assert "Operador do robô" in cliente.get("/operador/").text
        assert "Falar com o robô" in cliente.get("/cliente/").text


def test_captura_sintetica_respeita_5_fps(monkeypatch):
    from robo import camera
    monkeypatch.setattr(config, "SINTETICA", True)
    monkeypatch.setattr(config, "FPS", 5)

    async def caso():
        fonte = camera.FonteVideo()
        fonte.iniciar(asyncio.get_running_loop())
        recebidos = 0
        t0 = time.monotonic()
        while time.monotonic() - t0 < 2.0:
            if await fonte.obter(0.5) is not None:
                recebidos += 1
        fonte.parar()
        return recebidos

    n = asyncio.run(caso())
    assert 9 <= n <= 11   # 2 s a 5 FPS


def test_faixa_de_video_entrega_quadro_mais_recente(monkeypatch):
    from robo import camera

    async def caso():
        fonte = camera.FonteVideo()
        fonte._loop = asyncio.get_running_loop()
        fonte._evento = asyncio.Event()
        faixa = camera.FaixaVideo(fonte)
        antigo = np.zeros((480, 640, 3), dtype=np.uint8)
        novo = np.full((480, 640, 3), 200, dtype=np.uint8)
        fonte._publicar(antigo)
        fonte._publicar(novo)       # o antigo é descartado
        quadro = await faixa.recv()
        return quadro.to_ndarray(format="bgr24")

    assert asyncio.run(caso()).mean() > 150


async def _sem_espera(_):
    return None
