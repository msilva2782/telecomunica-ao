"""Testes da IA do modo ator: instrução, foto da câmera e corpo enviado ao Gemini (sem rede).

Rodar na pasta do projeto:  python -m pytest -q
"""
import io
import json
from datetime import datetime

from servidor import ia

FOTO = "/9j/4AAQSkZJRgABAQAAAQABAAD"          # começo de um JPEG em base64 (basta para o teste)


def test_instrucao_sem_foto_avisa_que_nao_enxerga():
    s = ia.sistema(datetime(2026, 10, 23, 14, 30))
    assert "não está enxergando" in s
    assert "sexta-feira, 23/10/2026, 14:30" in s


def test_instrucao_com_foto_e_resumo_da_visao():
    s = ia.sistema(datetime(2026, 10, 23), com_imagem=True, visao="1 pessoa na frente da câmera, sorrindo")
    assert "foto tirada agora" in s
    assert "Nunca tente dizer quem a pessoa é" in s
    assert "Detecção de rosto neste momento: 1 pessoa na frente da câmera, sorrindo." in s


def test_foto_vai_junto_da_ultima_fala_do_usuario():
    msgs = ia.montar_mensagens([{"quem": "cliente", "texto": "oi"}, {"quem": "robo", "texto": "olá!"}],
                               "o que você está vendo?")
    conversa = ia.conversa_gemini(msgs, FOTO)
    assert [c["role"] for c in conversa] == ["user", "model", "user"]
    ultima = conversa[-1]["parts"]
    assert ultima[0] == {"inlineData": {"mimeType": "image/jpeg", "data": FOTO}}
    assert ultima[1] == {"text": "o que você está vendo?"}
    assert all("inlineData" not in p for c in conversa[:-1] for p in c["parts"])


def test_sem_foto_nada_de_imagem():
    conversa = ia.conversa_gemini(ia.montar_mensagens([], "quanto é 2 + 2?"))
    assert conversa == [{"role": "user", "parts": [{"text": "quanto é 2 + 2?"}]}]


def test_chamada_ao_gemini_leva_a_foto(monkeypatch):
    enviado = {}

    class Resposta(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def urlopen_falso(req, timeout=None):
        enviado["url"] = req.full_url
        enviado["corpo"] = json.loads(req.data)
        enviado["chave"] = req.get_header("X-goog-api-key")
        dados = {"candidates": [{"content": {"parts": [{"text": "[feliz] Vejo você sorrindo!"}]}}]}
        return Resposta(json.dumps(dados).encode())

    monkeypatch.setattr(ia.urllib.request, "urlopen", urlopen_falso)
    bruto = ia.chamar_api("chave-teste", ia.sistema(com_imagem=True), ia.montar_mensagens([], "me vê?"), FOTO)
    assert ia.interpretar(bruto) == ("feliz", "Vejo você sorrindo!")
    assert enviado["chave"] == "chave-teste"
    assert enviado["url"].endswith(f"/models/{ia.MODELO}:generateContent")
    partes = enviado["corpo"]["contents"][-1]["parts"]
    assert partes[0]["inlineData"]["data"] == FOTO
    assert "foto tirada agora" in enviado["corpo"]["systemInstruction"]["parts"][0]["text"]


def test_pedido_rejeita_imagem_que_nao_e_base64():
    import pytest
    from pydantic import ValidationError
    assert ia.Pedido(texto="oi", imagem=FOTO).imagem == FOTO
    with pytest.raises(ValidationError):
        ia.Pedido(texto="oi", imagem="<script>alert(1)</script>")
