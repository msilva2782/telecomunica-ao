# Teleoperação de robô (vídeo + áudio via WebRTC)

Projeto 2 — Teleoperação Audiovisual (Engenharia de Software). Versão 7.

```
comum/      configurações (variáveis de ambiente) e marca de tempo nos quadros
servidor/   FastAPI + WebSocket: login por token, SDP/ICE, iniciar/encerrar (RF06), certificado HTTPS
robo/       webcam 5 FPS, microfone Opus, alto-falante (aiortc + OpenCV + sounddevice)
operador/   interface HTML/JS: vídeo, áudio, estado, latência e qualidade (RF05), Iniciar/Encerrar
cliente/    página de atendimento: áudio e chat com o robô, com aprovação do operador
ator/       MODO ATOR: página de quem faz o papel do robô (vê e ouve o cliente, voz robótica)
conversa/   MODO ATOR: rosto animado do robô para o cliente, com expressões pela fala
medicao/    script de latência (meta < 300 ms)
testes/     testes automáticos (pytest + node): servidor, componentes, modo ator, emoções
```

## Modo ator (uma pessoa faz o papel do robô)

Passo a passo completo em `GUIA_MODO_ATOR.txt`. Resumo: no computador do ator, duplo clique em
`iniciar_ator.bat`; no outro computador, abra o link de CLIENTE de `LINKS.txt` no Chrome ou Edge.

| Quem | Página | O que vê e faz |
|---|---|---|
| Ator | `/ator/` (token do robô) | vídeo e áudio do cliente, legenda do que ele fala com a emoção detectada, voz robótica ajustável, teclas 0–6 para expressões, frases para voz sintetizada, histórico para baixar |
| Cliente | `/conversa/` (token do cliente) | só o rosto do robô em tela cheia; a boca acompanha a voz do ator e a expressão muda conforme o que o cliente fala |

- O servidor roda com `AUTO_ACEITAR=1`: o cliente entra direto, sem operador, e nada na tela dele
  revela que há uma pessoa do outro lado. O robô Python não é ligado.
- Mídia navegador a navegador por WebRTC: câmera e microfone do cliente → ator; voz do ator
  (com modulação em anel, o timbre de robô) → cliente. Canal de dados para legendas, expressões,
  texto falado e RTT.
- Emoções: o Chrome/Edge transcreve a fala do cliente (Web Speech API, pt-BR) e `conversa/emocao.js`
  classifica cada frase por palavras-chave, com negação e intensificadores (neutro, feliz, rindo,
  triste, surpreso, pensativo, preocupado). O rosto (`conversa/rosto.js`) faz a transição suave,
  pisca, move o olhar, respira e presta atenção quando a pessoa fala.
- Visão: `ator/visao.js` detecta rostos no vídeo do cliente com o MediaPipe Face Landmarker, no
  navegador do ator (posição, distância, sorriso, surpresa; não identifica a pessoa). O rosto do
  robô olha para a pessoa (`{t: "olhar"}` no canal de dados), espelha sorriso e surpresa e, com a
  IA ligada, cumprimenta quem chega. Cada pedido à IA leva uma foto JPEG do momento e o resumo da
  detecção; o Gemini responde sobre a pessoa e o ambiente (`servidor/ia.py`). A foto vai por HTTP
  para `/ia/responder`, não pelo WebSocket: a mídia da conversa continua só no WebRTC.
- HTTPS na rede local com certificado autoassinado gerado na hora (`servidor/certificado.py`);
  os tokens ficam em `tokens_ator.txt`, para o link do cliente não mudar.

## Requisitos do enunciado

| Requisito | Onde está |
|---|---|
| RF01 — webcam a 5 FPS | `robo/camera.py`: thread de captura, limite de FPS, só o quadro mais recente |
| RF02 — áudio contínuo robô → operador | `robo/audio.py` (`FonteMicrofone`, `FaixaMicrofone`), codec Opus |
| RF03 — vídeo e áudio no operador | `operador/`: `<video>` com as faixas do robô |
| RF04 — voz do operador no robô | microfone do navegador → WebRTC → `robo/audio.py` (`AltoFalante`) |
| RF05 — estado da conexão e latência | painéis "Estado", "Latência" (atraso do vídeo e RTT) e "Qualidade" (FPS, perda, jitter, buffer) |
| RF06 — iniciar e encerrar | botões Iniciar/Encerrar; comandos `iniciar`/`encerrar` no servidor |
| Autenticação | um token por papel; tentativa errada demora 1 s |
| Falhas e reconexão | robô e páginas reconectam sozinhos; câmera, microfone e alto-falante reabrem |
| Separação de rotinas | captura de vídeo, captura de áudio e reprodução em threads; transmissão em tarefas asyncio |
| Latência < 300 ms | medida na própria interface e pelo script `medicao/latencia.py` |
| Sem Base64 no WebSocket | o WebSocket só leva SDP/ICE e comandos; a mídia vai por WebRTC (VP8 + Opus) |

## Início rápido (Windows)

Duplo clique em `iniciar.bat`. Ele usa o Python da pasta `python_portatil` (ou monta essa pasta
na primeira vez), gera tokens novos, liga servidor e robô, abre a página do operador e salva os
links em `LINKS.txt`.

```
preparar_portatil.bat    só monta o Python portátil (uma vez, com internet)
iniciar.bat              rede local
iniciar.bat -Internet    link HTTPS público via Cloudflare Tunnel (winget install Cloudflare.cloudflared)
iniciar.bat -Sintetica   vídeo de teste, sem webcam
iniciar.bat -SemMarca    não grava a hora nos pixels (o painel deixa de mostrar o atraso do vídeo)
iniciar.bat -Reinstalar  apaga e monta de novo o python_portatil
```

### Rodar em outro computador sem instalar nada

O `iniciar.ps1` baixa o Python 3.12 oficial em versão *embeddable* (python.org) para
`python_portatil/`, instala o `pip` e o `requirements.txt` dentro dele e ajusta o arquivo
`python312._pth` para enxergar a pasta do projeto. Esse Python não depende de nada instalado no
Windows (nem de caminho absoluto), então a pasta inteira pode ser copiada para qualquer
Windows 10/11 64 bits e roda na hora, sem internet. Antes disso o projeto dependia do Python do
computador: em máquinas sem Python, ou com versões novas (3.14/3.15) para as quais `aiortc`/`av`
ainda não têm pacote pronto, a instalação falhava ou demorava.

**Duas páginas, três papéis**

| Página | Quem usa | O que faz |
|---|---|---|
| `/operador/` | você | supervisiona: vê o vídeo, aceita ou recusa pedidos, acompanha a conversa do atendimento, encerra, escreve ao cliente |
| `/cliente/` | amigos/usuários | pede atendimento; se o operador aceitar, ouve o robô, fala (microfone) e conversa por texto. **Não recebe vídeo** (o robô nem o envia) |

Um cliente por vez. Se o operador clicar em Iniciar com um pedido pendente, a página pede
confirmação, porque a sessão direta recusa o pedido. Se o operador cair, o atendimento é
encerrado. Os três tokens (`TOKEN_ROBO`, `TOKEN_OPERADOR`, `TOKEN_CLIENTE`) precisam ser
diferentes. O link de **operador** nunca deve ir para clientes.

## Instalação manual

```bash
pip install -r requirements.txt     # Linux: precisa de libportaudio2 para o sounddevice
```

Recomendado: Python 3.12 (é o que o `python_portatil` usa). Python 3.10 a 3.14 também funcionam se as bibliotecas tiverem pacote pronto para a versão.

## Execução manual (a partir desta pasta)

No Windows (PowerShell), troque `export X=Y` por `$env:X="Y"`, por exemplo:

```powershell
$env:TOKEN_ROBO="segredo-robo"; $env:TOKEN_OPERADOR="segredo-operador"; $env:TOKEN_CLIENTE="segredo-cliente"
$env:URL_SERVIDOR="ws://IP_DO_SERVIDOR:8000/ws"; python -m robo
```

```bash
export TOKEN_ROBO=segredo-robo TOKEN_OPERADOR=segredo-operador TOKEN_CLIENTE=segredo-cliente

python -m servidor                                        # 1) servidor (porta 8000)
URL_SERVIDOR=ws://IP_DO_SERVIDOR:8000/ws python -m robo   # 2) no robô
# 3) navegador do operador: http://IP_DO_SERVIDOR:8000  -> token -> Entrar -> Iniciar
```

**Atenção:** o navegador só libera o microfone em `localhost` ou em HTTPS. Para o operador em
outra máquina, use `iniciar.bat -Internet` ou rode o servidor com HTTPS
(`SSL_CERT=cert.pem SSL_KEY=key.pem`) e abra `https://...`. Sem microfone, a interface continua
recebendo vídeo e áudio do robô.

## Medição de latência

Na interface do operador (com o robô em `MARCAR_TIMESTAMP=1`, o padrão do `iniciar.bat`):

- **Atraso do vídeo**: da captura no robô até o quadro aparecer na tela (mediana dos últimos 10 quadros).
  O robô grava a hora da captura nos pixels da primeira linha. A página lê essa hora e
  estima a diferença entre os relógios pelo ping, como no NTP. Não precisa de relógios sincronizados;
  o erro máximo é RTT/2.
- **RTT**: ida e volta pelo canal de dados.
- **Qualidade**: FPS recebido, perda de pacotes, jitter do áudio e buffer de reprodução do vídeo.

Sem interface, para registrar no relatório:

```bash
MARCAR_TIMESTAMP=1 python -m robo                        # ou iniciar.bat (já liga a marca)
python -m medicao.latencia --duracao 30 --csv resultado.csv   # sai com 0 se p95 < 300 ms
```

O receptor de vídeo do aiortc só libera um quadro quando chega o pacote do quadro seguinte, o que
somaria 200 ms (a 5 FPS) que o navegador não tem. O script libera o quadro no bit *marker* do RTP,
como o navegador faz; `--sem-correcao-marker` mostra o valor antigo.

## Testes automáticos

```bash
pip install -r requirements-testes.txt
python -m pytest -q          # 54 testes: servidor, autenticação, marca de tempo, captura a 5 FPS, modo ator
node testes/emocao.test.js   # 24 frases do detector de emoção (também roda dentro do pytest)
```

## Variáveis úteis

| Variável | Padrão | Uso |
|---|---|---|
| `TOKEN_ROBO`, `TOKEN_OPERADOR`, `TOKEN_CLIENTE` | tokens de exemplo | **troque antes de expor o servidor** |
| `URL_SERVIDOR` | `ws://127.0.0.1:8000/ws` | usada por robô e medição |
| `FPS`, `LARGURA`, `ALTURA`, `INDICE_CAMERA` | 5, 640, 480, 0 | câmera |
| `AUDIO_ENTRADA`, `AUDIO_SAIDA` | dispositivo padrão | índice/nome (`python -m sounddevice` lista) |
| `ATRASO_MAX_SAIDA_MS` | 200 | buffer máximo do alto-falante do robô |
| `ICE_SERVERS` | `stun:stun.l.google.com:19302` | vazio desliga o STUN (só rede local) |
| `TURN_URL`, `TURN_USER`, `TURN_PASS` | vazio | relay para redes 4G/corporativas |
| `SINTETICA=1` | 0 | vídeo de teste, sem webcam |
| `MARCAR_TIMESTAMP=1` | 0 (1 no `iniciar.bat`) | grava a hora da captura nos pixels |

## Robustez

- **Robô:** captura de vídeo e de áudio em threads próprias; a de vídeo mantém só o quadro mais
  recente; transmissão e reprodução em tarefas asyncio separadas. Reabre câmera, microfone e
  alto-falante se falharem; reconecta ao servidor com espera exponencial (1 s → 15 s); câmera muda
  gera um quadro "SEM SINAL" em vez de travar o fluxo. O alto-falante descarta o excesso acima de
  200 ms para o atraso não acumular.
- **Operador:** reconecta ao servidor sozinho e, se a sessão estava ligada, a reinicia quando o robô
  volta ou quando o WebRTC falha.
- **Servidor:** um robô, um operador e um cliente por vez; se um cair durante a sessão, os outros
  são avisados.

## Mudanças da V7 (portabilidade e visão)

- `python_portatil/`: Python 3.12 próprio dentro da pasta; roda em qualquer Windows sem instalar.
  Instala direto na pasta final (renomear no fim dava "acesso negado" dentro do OneDrive) e
  apaga pastas tentando de novo por alguns segundos. Recomendado: projeto fora do OneDrive.
  O `.venv` antigo não era portátil (um venv guarda o caminho absoluto do Python que o criou).
- O script espera o servidor responder antes de abrir as páginas e o robô (antes eram 3 s fixos,
  pouco num computador lento ou com antivírus analisando o Python na primeira vez).
- IP do link do cliente: o da placa da rota padrão (Wi-Fi/cabo), não o de VPN/Hyper-V/Bluetooth.
- Aviso quando a rede está como "Pública" no Windows (o firewall bloqueia o outro computador).
- Porta 8000 ocupada (janela antiga aberta): usa a próxima livre e avisa.
- Pastas com espaço, acento ou apóstrofo no caminho (ex.: "Área de Trabalho").
  O caminho do certificado era lido da saída do Python e chegava com "Á" trocado por "├ü";
  agora é montado no próprio script, e o servidor recria o certificado se ele faltar.
- IA: o script procurava `ANTHROPIC_API_KEY`, mas `servidor/ia.py` usa Gemini
  (`GOOGLE_API_KEY`/`GEMINI_API_KEY`); o aviso "chave encontrada" nunca batia. Guia atualizado.
- Visão do robô: detecção de rosto no navegador do ator, olhar que segue a pessoa, reação a
  sorriso/surpresa, cumprimento da IA e foto da câmera para o Gemini (6 testes em `testes/test_ia.py`).
- IA espera a vez: silêncio configurável (padrão 1,6 s) antes de falar, nunca por cima do cliente,
  do ator ou da voz sintetizada; descarta e refaz a resposta se o cliente continuou a frase; ignora
  "hum/aham" e o eco do próprio robô (a tela do robô marca as falas ditas enquanto ele falava).
- Áudio do cliente (`ator/audio_cliente.js`): perfis Natural / Equilibrado (RNNoise) / Máximo
  (+ portão suave), nivelador moderado + limitador, abafador de eco (-10 dB enquanto o ator ou a voz
  sintetizada falam), medidor de rede (perda, áudio reconstruído, jitter, kbit/s) e gravação de
  10 s em WAV (antes/depois). Cliente: sem `voiceIsolation` (empilhado com o RNNoise deixava a voz
  robótica), vídeo 640x480 a 15 fps limitado a 600 kbit/s e áudio com prioridade alta na rede.
- Servidor força os tipos `.js`/`.mjs`/`.wasm` (o registro de alguns Windows serve `.js` como texto).
- O pacote não leva mais chave privada do certificado, tokens nem links do computador antigo:
  são gerados em cada computador.

## Mudanças da V5

- Medição: o script mostrava ~205 ms mesmo no próprio computador por causa do receptor do aiortc
  (um quadro inteiro de espera). Corrigido; o valor real local é ~9 ms.
- Medição: a diferença entre relógios é estimada pelo ping; não é mais preciso NTP.
- Marca de tempo: uma faixa toda preta (câmera escura) era lida como hora "0" e gerava
  amostras absurdas. Agora é rejeitada.
- Operador: o painel mostra o atraso real do vídeo (captura → tela), FPS, perda de pacotes,
  jitter e buffer.
- Operador: confirmação ao clicar em Iniciar com um cliente aguardando.
- `iniciar.ps1`: escolhia o atalho `python` da Microsoft Store (que não executa nada) e
  abortava no PowerShell 5.1 quando o Python escrevia no stderr, justamente na primeira
  instalação. Corrigido.
- 40 testes automáticos em `testes/`.

## Limites conhecidos

- O robô envia todos os candidatos ICE já dentro da oferta (aiortc não faz trickle); o navegador faz trickle normalmente.
- Há um único robô e um único operador por servidor.
- O áudio do operador passa pelo buffer de recepção do aiortc no robô (cerca de 4 pacotes de 20 ms).
