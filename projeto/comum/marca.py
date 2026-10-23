"""Marca de tempo escrita nos pixels do quadro de vídeo.

O robô desenha, na linha superior, 56 blocos pretos/brancos com o instante de
captura (ms desde a época, 48 bits) + 8 bits de verificação. O script de
medição lê essa marca do quadro decodificado e calcula a idade do quadro.
"""
from typing import Optional

import numpy as np

BITS_TS = 48
BITS_CK = 8
BITS = BITS_TS + BITS_CK
BLOCO = 10  # pixels por bit -> 560 px de largura


def _checksum(ts: int) -> int:
    return ts % 251


def largura_necessaria() -> int:
    return BITS * BLOCO


def escrever(quadro: np.ndarray, ts_ms: int) -> None:
    """Escreve a marca no quadro (BGR ou cinza), in-place."""
    if quadro.shape[1] < largura_necessaria() or quadro.shape[0] < BLOCO:
        return
    ts = int(ts_ms) & ((1 << BITS_TS) - 1)
    valor = (ts << BITS_CK) | _checksum(ts)
    for i in range(BITS):
        bit = (valor >> (BITS - 1 - i)) & 1
        quadro[0:BLOCO, i * BLOCO:(i + 1) * BLOCO] = 255 if bit else 0


def ler(cinza: np.ndarray) -> Optional[int]:
    """Lê a marca de um quadro em tons de cinza. Retorna ms ou None se inválida."""
    if cinza.ndim != 2 or cinza.shape[1] < largura_necessaria() or cinza.shape[0] < BLOCO:
        return None
    meio = BLOCO // 2
    valor = 0
    for i in range(BITS):
        x = i * BLOCO + meio
        amostra = cinza[meio - 2:meio + 2, x - 2:x + 2]
        bit = 1 if float(amostra.mean()) > 127 else 0
        valor = (valor << 1) | bit
    ts = valor >> BITS_CK
    ck = valor & ((1 << BITS_CK) - 1)
    # ts == 0 seria uma faixa toda preta (câmera escura/sem marca), que passa no checksum
    return ts if ts > 0 and ck == _checksum(ts) else None
