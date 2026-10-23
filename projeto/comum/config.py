"""Configurações compartilhadas entre servidor, robô, operador e medição.

Tudo pode ser sobrescrito por variáveis de ambiente, sem editar código.
"""
import os


def _env(nome: str, padrao: str) -> str:
    return os.environ.get(nome, padrao)


def _env_int_opcional(nome: str):
    valor = os.environ.get(nome)
    if valor is None or valor == "":
        return None
    try:
        return int(valor)
    except ValueError:
        return valor  # nome de dispositivo (texto), aceito pelo sounddevice


# --- Servidor de sinalização -------------------------------------------------
SERVIDOR_HOST = _env("SERVIDOR_HOST", "0.0.0.0")
SERVIDOR_PORTA = int(_env("SERVIDOR_PORTA", "8000"))
SSL_CERT = _env("SSL_CERT", "")  # opcional: habilita HTTPS/WSS
SSL_KEY = _env("SSL_KEY", "")

TOKEN_PADRAO_ROBO = "troque-token-robo"
TOKEN_PADRAO_OPERADOR = "troque-token-operador"
TOKEN_PADRAO_CLIENTE = "troque-token-cliente"
TOKEN_ROBO = _env("TOKEN_ROBO", TOKEN_PADRAO_ROBO)
TOKEN_OPERADOR = _env("TOKEN_OPERADOR", TOKEN_PADRAO_OPERADOR)
TOKEN_CLIENTE = _env("TOKEN_CLIENTE", TOKEN_PADRAO_CLIENTE)

# Modo ator: uma pessoa faz o papel do robô pela página /ator/ (entra com TOKEN_ROBO) e o
# cliente fala direto com ela pela página /conversa/, sem aprovação de operador.
AUTO_ACEITAR = _env("AUTO_ACEITAR", "0") == "1"

# URL que robô e script de medição usam para falar com o servidor
URL_SERVIDOR = _env("URL_SERVIDOR", f"ws://127.0.0.1:{SERVIDOR_PORTA}/ws")

# --- WebRTC ------------------------------------------------------------------
# STUN permite conectar através de roteadores (internet). Em LAN não atrapalha.
# Para desligar: ICE_SERVERS="" . Vários separados por vírgula.
SERVIDORES_ICE = [s.strip() for s in _env("ICE_SERVERS", "stun:stun.l.google.com:19302").split(",")
                  if s.strip()]
# TURN (relay) é opcional: só é necessário quando as duas pontas estão atrás de NAT
# restritivo (redes corporativas, 4G/5G). Ex.: TURN_URL=turn:meuservidor:3478
TURN_URL = _env("TURN_URL", "")
TURN_USER = _env("TURN_USER", "")
TURN_PASS = _env("TURN_PASS", "")


def servidores_ice() -> list:
    """Lista de servidores ICE no formato aceito por navegador e aiortc."""
    lista = [{"urls": u} for u in SERVIDORES_ICE]
    if TURN_URL:
        lista.append({"urls": TURN_URL, "username": TURN_USER, "credential": TURN_PASS})
    return lista

# --- Vídeo (robô) ------------------------------------------------------------
FPS = int(_env("FPS", "5"))
LARGURA = int(_env("LARGURA", "640"))
ALTURA = int(_env("ALTURA", "480"))
INDICE_CAMERA = int(_env("INDICE_CAMERA", "0"))
# Fonte de teste (sem webcam): gera quadros sintéticos
SINTETICA = _env("SINTETICA", "0") == "1"
# Desenha o timestamp de captura nos pixels do quadro (usado na medição)
MARCAR_TIMESTAMP = _env("MARCAR_TIMESTAMP", "0") == "1"

# --- Áudio (robô) ------------------------------------------------------------
TAXA_AUDIO = 48000          # Hz (Opus trabalha nativamente a 48 kHz)
BLOCO_AUDIO = 960           # 20 ms por bloco
DISPOSITIVO_ENTRADA = _env_int_opcional("AUDIO_ENTRADA")
DISPOSITIVO_SAIDA = _env_int_opcional("AUDIO_SAIDA")
ATRASO_MAX_SAIDA_MS = int(_env("ATRASO_MAX_SAIDA_MS", "200"))

# --- Reconexão / medição -----------------------------------------------------
RECONEXAO_MIN_S = 1.0
RECONEXAO_MAX_S = 15.0
META_LATENCIA_MS = 300
