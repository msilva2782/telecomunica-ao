"""Respostas de IA para o modo ator (usando a API do Google Gemini).

A página do ator (/ator/) manda para cá o que o cliente disse e recebe uma resposta curta,
com a emoção do rosto, para o robô falar. Junto pode vir uma foto da câmera do cliente (JPEG
pequeno, tirada na hora) e um resumo do que a detecção de rosto viu ("1 pessoa, perto, sorrindo"):
o Gemini entende imagens, então o robô consegue responder sobre a pessoa e o ambiente. A chave da API fica só neste computador (variável
de ambiente GOOGLE_API_KEY ou GEMINI_API_KEY, ou o arquivo chave_ia.txt); nunca vai para as
páginas. Sem dependências novas: a chamada HTTP usa a biblioteca padrão.

No servidor/main.py, logo depois de criar o app:

    from .ia import roteador as roteador_ia
    app.include_router(roteador_ia)
"""
import asyncio
import collections
import hmac
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

from comum import config

log = logging.getLogger("servidor.ia")

EMOCOES = ("neutro", "feliz", "rindo", "triste", "surpreso", "pensativo", "preocupado")
URL_BASE = os.environ.get("GEMINI_API_URL", "https://generativelanguage.googleapis.com/v1beta")
# Os modelos gemini-1.5, 2.0 e 2.5 já foram desligados. Para trocar de modelo (ex.: o mais barato
# "gemini-3.5-flash-lite"), use a variável IA_MODELO; GET /ia/modelos lista o que a sua chave enxerga.
MODELO = os.environ.get("IA_MODELO", "gemini-3.6-flash")
# Usado se o principal falhar (erro do Google ou modelo inexistente). Deixe vazio para desligar.
MODELO_RESERVA = os.environ.get("IA_MODELO_RESERVA", "gemini-3.5-flash-lite").strip()
MAX_TOKENS = int(os.environ.get("IA_MAX_TOKENS", "200"))
LIMITE_POR_MIN = int(os.environ.get("IA_LIMITE_POR_MIN", "20"))
TEMPO_LIMITE_S = float(os.environ.get("IA_TEMPO_LIMITE_S", "15"))
PERSONA_EXTRA = os.environ.get("IA_PERSONA", "").strip()
ARQUIVO_CHAVE = Path(__file__).resolve().parent.parent / "chave_ia.txt"
DIAS = ["segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo"]


class ErroIA(Exception):
    def __init__(self, status: int, detalhe: str) -> None:
        super().__init__(detalhe)
        self.status = status
        self.detalhe = detalhe


def chave() -> str:
    for nome in ("GOOGLE_API_KEY", "GEMINI_API_KEY"):
        k = os.environ.get(nome, "").strip()
        if k:
            return k

    try:
        for linha in ARQUIVO_CHAVE.read_text(encoding="utf-8").splitlines():
            if linha.strip():
                return linha.strip()
    except OSError:
        pass

    return ""


def sistema(agora: datetime = None, com_imagem: bool = False, visao: str = "") -> str:
    agora = agora or datetime.now()
    texto = (
        "Você é um robô assistente simpático, conversando por voz com uma pessoa. "
        "Responda em português do Brasil, em no máximo duas frases curtas (até 35 palavras), "
        "em texto corrido para ser falado em voz alta: sem listas, markdown, emojis ou símbolos. "
        "Perguntas simples (contas, fatos gerais, curiosidades, hora e data) você responde direto. "
        + (
            "Você recebe uma foto tirada agora pela câmera que está na sua frente: ela é a sua visão. "
            "Use-a quando perguntarem o que você vê, sobre a pessoa, roupas, objetos ou o ambiente, "
            "e para reagir com naturalidade; não descreva a foto sem motivo. "
            "Nunca tente dizer quem a pessoa é (nome), nem palpite idade exata, etnia, religião, saúde "
            "ou outros dados sensíveis, e não faça comentários negativos sobre a aparência. "
            "Se a foto estiver escura ou sem ninguém, diga que não está enxergando bem. "
            if com_imagem else
            "Você não está enxergando a câmera agora. "
        )
        + "Se não souber, ou se a pergunta pedir algo que você não tem como saber (notícias de hoje, "
        "lugares próximos), diga isso com naturalidade, sem inventar. "
        "Você é um robô de conversa: não finja ser humano nem ter corpo. "
        f"Agora é {DIAS[agora.weekday()]}, {agora.strftime('%d/%m/%Y')}, {agora.strftime('%H:%M')}. "
        "Comece SEMPRE com uma etiqueta de emoção entre colchetes, escolhida entre: "
        + ", ".join(EMOCOES) + ". Exemplo: [feliz] Que legal, parabéns!"
    )
    if visao:
        texto += f" Detecção de rosto neste momento: {visao}."
    if PERSONA_EXTRA:
        texto += " " + PERSONA_EXTRA
    return texto


def montar_mensagens(historico: list, texto: str) -> list:
    """Converte a conversa recente em mensagens que alternam usuário/assistente."""
    msgs = []
    for turno in (historico or [])[-10:]:
        papel = "user" if turno.get("quem") == "cliente" else "assistant"
        conteudo = str(turno.get("texto", "")).strip()[:500]
        if not conteudo:
            continue
        if msgs and msgs[-1]["role"] == papel:
            msgs[-1]["content"] += " " + conteudo
        else:
            msgs.append({"role": papel, "content": conteudo})
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    novo = str(texto).strip()[:500]
    if msgs and msgs[-1]["role"] == "user":
        msgs[-1]["content"] += " " + novo
    else:
        msgs.append({"role": "user", "content": novo})
    return msgs


def interpretar(bruto: str):
    """'[feliz] Que legal!' -> ('feliz', 'Que legal!'). Limpa marcas que a voz leria em voz alta."""
    emocao = "neutro"
    m = re.match(r"\s*\[\s*([A-Za-zÀ-ÿ]+)\s*\]\s*", bruto or "")
    if m:
        if m.group(1).lower() in EMOCOES:
            emocao = m.group(1).lower()
        bruto = bruto[m.end():]
    texto = re.sub(r"[*_`#>]+", "", bruto or "")
    texto = re.sub(r"\s+", " ", texto).strip()[:400]
    if not texto:
        raise ErroIA(502, "a IA devolveu uma resposta vazia")
    return emocao, texto


def _chamar_modelo(k: str, modelo: str, instrucao: str, conversa: list) -> str:
    """Uma chamada ao Gemini com um modelo específico. Devolve o texto bruto ou levanta ErroIA."""
    # Sem "temperature": nos modelos 3.x os parâmetros de amostragem estão obsoletos.
    config_geracao = {"maxOutputTokens": MAX_TOKENS}
    # Os modelos "pensam" antes de responder e isso pode consumir o limite de tokens e deixar a
    # fala lenta. Nos 3.x o nível mínimo resolve (o Pro não aceita "minimal").
    if modelo.startswith("gemini-3") and "pro" not in modelo:
        config_geracao["thinkingConfig"] = {"thinkingLevel": "minimal"}

    corpo = json.dumps({
        "systemInstruction": {"parts": [{"text": instrucao}]},
        "contents": conversa,
        "generationConfig": config_geracao,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{URL_BASE}/models/{modelo}:generateContent",
        data=corpo,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": k,  # no cabeçalho, para a chave não aparecer em logs de URL
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=TEMPO_LIMITE_S) as r:
            dados = json.load(r)

    except urllib.error.HTTPError as e:
        try:
            detalhe = json.load(e).get("error", {}).get("message", "")
        except Exception:
            detalhe = ""
        log.warning("Gemini (%s) HTTP %s: %s", modelo, e.code, detalhe)

        if e.code in (401, 403) or (e.code == 400 and "API key" in detalhe):
            raise ErroIA(502, "chave Gemini inválida")
        if e.code == 404:
            raise ErroIA(502, f"modelo Gemini não encontrado ({modelo})")
        if e.code == 429:
            raise ErroIA(429, "limite do Gemini atingido")
        raise ErroIA(502 if e.code < 500 else 503, f"erro Gemini HTTP {e.code} ({modelo}): {detalhe[:150]}")

    except (urllib.error.URLError, OSError):
        raise ErroIA(504, "sem resposta do Gemini")

    except ValueError:
        raise ErroIA(502, "resposta Gemini inválida")

    candidatos = dados.get("candidates") or []
    if not candidatos:
        bloqueio = (dados.get("promptFeedback") or {}).get("blockReason")
        raise ErroIA(502, f"Gemini bloqueou o pedido ({bloqueio})" if bloqueio else "Gemini sem resposta")

    partes = (candidatos[0].get("content") or {}).get("parts") or []
    texto = "".join(p.get("text", "") for p in partes if not p.get("thought"))
    if not texto.strip():
        motivo = candidatos[0].get("finishReason", "desconhecido")
        raise ErroIA(502, f"Gemini devolveu resposta vazia ({motivo})")
    return texto


def conversa_gemini(mensagens: list, imagem: str = "") -> list:
    """Mensagens no formato do Gemini; a foto (JPEG em base64) vai junto da última fala do usuário."""
    conversa = [
        {
            "role": "user" if m["role"] == "user" else "model",
            "parts": [{"text": m["content"]}],
        }
        for m in mensagens
    ]
    if imagem and conversa and conversa[-1]["role"] == "user":
        conversa[-1]["parts"].insert(0, {"inlineData": {"mimeType": "image/jpeg", "data": imagem}})
    return conversa


def chamar_api(k: str, instrucao: str, mensagens: list, imagem: str = "") -> str:
    """Chama o Gemini. Em falha passageira (500/503/504) tenta de novo e depois usa o modelo reserva."""
    # No Gemini o papel da IA se chama "model", e a instrução de sistema tem campo próprio.
    conversa = conversa_gemini(mensagens, imagem)

    modelos = [MODELO] + ([MODELO_RESERVA] if MODELO_RESERVA and MODELO_RESERVA != MODELO else [])
    ultimo = None
    for modelo in modelos:
        for tentativa in range(2):
            try:
                return _chamar_modelo(k, modelo, instrucao, conversa)
            except ErroIA as e:
                ultimo = e
                if e.status not in (503, 504):
                    break  # erro que repetir não resolve (ex.: 404): passa para o próximo modelo
                time.sleep(0.5)
        if ultimo.status in (429, 502) and ("chave" in ultimo.detalhe):
            break  # chave inválida: trocar de modelo não ajuda
    raise ultimo


def listar_modelos(k: str) -> list:
    """Nomes dos modelos que aceitam generateContent para esta chave (ajuda a escolher IA_MODELO)."""
    req = urllib.request.Request(f"{URL_BASE}/models?pageSize=200", headers={"x-goog-api-key": k})
    try:
        with urllib.request.urlopen(req, timeout=TEMPO_LIMITE_S) as r:
            dados = json.load(r)
    except (urllib.error.URLError, OSError, ValueError):
        raise ErroIA(504, "não foi possível listar os modelos do Gemini")
    return sorted(
        m["name"].removeprefix("models/")
        for m in dados.get("models", [])
        if "generateContent" in m.get("supportedGenerationMethods", [])
    )


_pedidos = collections.deque()


def liberar() -> bool:
    """Limite de pedidos por minuto (protege o custo se o link vazar)."""
    agora = time.monotonic()
    while _pedidos and agora - _pedidos[0] > 60:
        _pedidos.popleft()
    if len(_pedidos) >= LIMITE_POR_MIN:
        return False
    _pedidos.append(agora)
    return True


# ---------------------------------------------------------------- rotas
from fastapi import APIRouter, Header, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

roteador = APIRouter(prefix="/ia", tags=["ia"])


class Turno(BaseModel):
    quem: str
    texto: str = Field(default="", max_length=500)


class Pedido(BaseModel):
    texto: str = Field(min_length=1, max_length=500)
    historico: list[Turno] = []
    # foto da câmera do cliente: JPEG em base64, sem o prefixo "data:" (640 px dão uns 60 KB)
    imagem: str = Field(default="", max_length=1_500_000, pattern=r"^[A-Za-z0-9+/=]*$")
    visao: str = Field(default="", max_length=300)    # resumo da detecção de rosto
    evento: bool = False                               # pedido da página (cumprimento), não fala do cliente


def _autorizar(token: str) -> None:
    esperado = config.TOKEN_ROBO.encode("utf-8")
    if not token or not hmac.compare_digest(token.encode("utf-8"), esperado):
        raise HTTPException(401, "token inválido")


@roteador.get("/estado")
async def estado(x_token: str = Header(default="")):
    _autorizar(x_token)
    return {"disponivel": bool(chave()), "modelo": MODELO}


@roteador.get("/modelos")
async def modelos(x_token: str = Header(default="")):
    _autorizar(x_token)
    k = chave()
    if not k:
        raise HTTPException(503, "sem chave da API (veja GUIA_IA.txt)")
    try:
        return {"modelos": await asyncio.to_thread(listar_modelos, k), "em_uso": MODELO}
    except ErroIA as e:
        raise HTTPException(e.status, e.detalhe)


@roteador.post("/responder")
async def responder(pedido: Pedido, x_token: str = Header(default="")):
    _autorizar(x_token)
    k = chave()
    if not k:
        raise HTTPException(503, "sem chave da API (veja GUIA_IA.txt)")
    if not liberar():
        raise HTTPException(429, f"muitos pedidos por minuto (limite {LIMITE_POR_MIN})")
    historico = [{"quem": t.quem, "texto": t.texto} for t in pedido.historico]
    texto = pedido.texto
    if pedido.evento:   # não é fala da pessoa: a IA recebe como instrução da situação
        texto = f"(Aviso do sistema, não é fala da pessoa: {texto})"
    instrucao = sistema(com_imagem=bool(pedido.imagem), visao=pedido.visao.strip())
    t0 = time.monotonic()
    try:
        bruto = await asyncio.to_thread(chamar_api, k, instrucao, montar_mensagens(historico, texto), pedido.imagem)
        emocao, texto = interpretar(bruto)
    except ErroIA as e:
        log.warning("IA falhou: %s", e.detalhe)
        raise HTTPException(e.status, e.detalhe)
    ms = int((time.monotonic() - t0) * 1000)
    log.info("IA respondeu em %d ms (%s%s)", ms, emocao, ", com foto" if pedido.imagem else "")
    return {"resposta": texto, "emocao": emocao, "ms": ms, "modelo": MODELO}
