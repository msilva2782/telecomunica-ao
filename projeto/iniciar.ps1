# Liga servidor + robo com um comando e mostra os links.
# Uso (normalmente via iniciar.bat / iniciar_ator.bat):
#   .\iniciar.ps1                 -> rede local
#   .\iniciar.ps1 -Internet       -> tambem cria link https publico (precisa do cloudflared)
#   .\iniciar.ps1 -Sintetica      -> video de teste, sem webcam
#   .\iniciar.ps1 -SemMarca       -> nao grava a hora nos pixels (o operador deixa de ver o atraso do video)
#   .\iniciar.ps1 -Ator           -> modo ator: uma pessoa faz o papel do robo (pagina /ator/) e o
#                                    cliente ve o rosto do robo (pagina /conversa/). Liga HTTPS na rede local.
#   .\iniciar.ps1 -SoPreparar     -> so monta o Python portatil (pasta python_portatil) e sai
#   .\iniciar.ps1 -Reinstalar     -> apaga o Python portatil e monta de novo
#
# PYTHON PORTATIL: na primeira execucao (com internet) o script baixa um Python 3.12 proprio
# para dentro da pasta "python_portatil" e instala as bibliotecas nele. Depois disso a pasta
# inteira pode ser copiada (pendrive, zip, OneDrive) para QUALQUER Windows 10/11 64 bits e roda
# na hora, sem instalar nada e sem internet. O Python instalado no computador nao e usado.
param(
    [switch]$Internet,
    [switch]$Sintetica,
    [switch]$SemMarca,
    [switch]$Ator,
    [switch]$SoPreparar,
    [switch]$Reinstalar,
    [int]$Porta = 8000
)

$ErrorActionPreference = "Stop"
$Raiz = $PSScriptRoot
Set-Location -LiteralPath $Raiz
[Environment]::CurrentDirectory = $Raiz

$VersaoPython = "3.12.10"        # ultima 3.12 com instalador; todas as bibliotecas tem pacote pronto para ela
$PastaPortatil = Join-Path $Raiz "python_portatil"
$PyPortatil = Join-Path $PastaPortatil "python.exe"
$Modulos = "fastapi, uvicorn, websockets, aiortc, av, numpy, cv2, sounddevice, cryptography"

function Novo-Token {
    $b = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return ([Convert]::ToBase64String($b) -replace '[^a-zA-Z0-9]', '').Substring(0, 20)
}

# Roda um programa externo sem que o texto dele no stderr (avisos do pip, tracebacks)
# vire erro fatal do PowerShell 5.1. Devolve o codigo de saida.
function Rodar {
    param([string]$Programa, [string[]]$Argumentos, [switch]$Silencioso)
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($Silencioso) { & $Programa @Argumentos 2>&1 | Out-Null } else { & $Programa @Argumentos 2>&1 | ForEach-Object { Write-Host "$_" } }
        return $LASTEXITCODE
    } catch { return 1 } finally { $ErrorActionPreference = $anterior }
}

function Tem-Dependencias([string]$Py) {
    return ((Rodar $Py @("-c", "import $Modulos") -Silencioso) -eq 0)
}

# Caminho real do python.exe de um candidato ("py -3.12", "python"...), ou $null.
# "python" pode ser so o atalho da Microsoft Store (nao executa nada): testa de verdade.
function Caminho-Python {
    param([string]$Exe, [string[]]$Pre = @())
    if ($Exe -like "*\*") { if (-not (Test-Path -LiteralPath $Exe)) { return $null } }
    elseif (-not (Get-Command $Exe -ErrorAction SilentlyContinue)) { return $null }
    $anterior = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try {
        # o caminho vem em hexadecimal (bytes UTF-8): acentos no caminho nao se perdem no console
        $saida = @(& $Exe @Pre -c "import sys; print(sys.executable.encode('utf-8').hex() if sys.version_info >= (3, 10) else '')" 2>$null)
        if ($LASTEXITCODE -eq 0 -and $saida.Count -gt 0) {
            $hex = "$($saida[-1])".Trim()
            if ($hex -match '^([0-9a-f]{2})+$') {
                $bytes = [byte[]]($hex -split '(..)' -ne '' | ForEach-Object { [Convert]::ToByte($_, 16) })
                $p = [Text.Encoding]::UTF8.GetString($bytes)
                if (Test-Path -LiteralPath $p) { return $p }
            }
        }
    } catch {} finally { $ErrorActionPreference = $anterior }
    return $null
}

# Python do computador que JA tenha todas as bibliotecas (ex.: o computador de desenvolvimento).
function Python-Do-Sistema {
    $candidatos = @(
        @{ E = (Join-Path $Raiz ".venv\Scripts\python.exe"); A = @() },
        @{ E = "py"; A = @("-3.12") }, @{ E = "py"; A = @("-3.13") }, @{ E = "py"; A = @("-3.11") },
        @{ E = "py"; A = @() }, @{ E = "python"; A = @() }, @{ E = "python3"; A = @() })
    foreach ($c in $candidatos) {
        $p = Caminho-Python $c.E $c.A
        if ($p -and (Tem-Dependencias $p)) { return $p }
    }
    return $null
}

# Apaga uma pasta tentando de novo por alguns segundos: OneDrive e antivirus seguram arquivos
# recem-criados por um tempo, e o Windows responde "acesso negado" enquanto isso.
function Remover-Pasta([string]$Pasta, [int]$Tentativas = 15) {
    for ($i = 1; $i -le $Tentativas; $i++) {
        if (-not (Test-Path -LiteralPath $Pasta)) { return $true }
        try { Remove-Item -LiteralPath $Pasta -Recurse -Force -ErrorAction Stop; return $true }
        catch { Start-Sleep -Seconds 1 }
    }
    return -not (Test-Path -LiteralPath $Pasta)
}

function Aviso-OneDrive {
    if ($Raiz -match '\\OneDrive') {
        Write-Host ""
        Write-Host "AVISO: a pasta do projeto esta dentro do OneDrive." -ForegroundColor Yellow
        Write-Host "  O Python portatil tem milhares de arquivos: o OneDrive tenta enviar todos para a nuvem," -ForegroundColor Yellow
        Write-Host "  deixa a instalacao lenta e pode travar arquivos. Recomendado: mover a pasta para fora," -ForegroundColor Yellow
        Write-Host "  por exemplo C:\Robo, e rodar o preparar_portatil.bat de novo. Os atalhos da Area de" -ForegroundColor Yellow
        Write-Host "  Trabalho passam a apontar para o lugar novo sozinhos." -ForegroundColor Yellow
        Write-Host ""
    }
}

# Baixa o Python "embeddable" oficial para python_portatil e instala as bibliotecas nele.
# Instala direto na pasta final (renomear a pasta no fim falhava no OneDrive). Uma montagem
# interrompida nao engana ninguem: so vale se o Python abrir e carregar todas as bibliotecas.
function Montar-Portatil {
    $destino = $PastaPortatil
    $progressoAnterior = $ProgressPreference
    Aviso-OneDrive
    try {
        if (-not (Remover-Pasta $destino)) {
            throw "a pasta python_portatil esta em uso. Feche as janelas SERVIDOR/ROBO e o Explorador nessa pasta (ou pause o OneDrive) e tente de novo"
        }
        New-Item -ItemType Directory -Path $destino | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = "SilentlyContinue"   # a barra de progresso deixa o download 10x mais lento no PowerShell 5.1

        Write-Host "  1/3 Baixando o Python $VersaoPython (cerca de 10 MB)..." -ForegroundColor Yellow
        $zip = Join-Path $env:TEMP "python-$VersaoPython-embed-amd64.zip"   # fora do OneDrive
        Invoke-WebRequest -UseBasicParsing -Uri "https://www.python.org/ftp/python/$VersaoPython/python-$VersaoPython-embed-amd64.zip" -OutFile $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $destino -Force
        Remove-Item -LiteralPath $zip -ErrorAction SilentlyContinue
        # O arquivo ._pth define onde o Python procura modulos: a propria pasta, as bibliotecas
        # e ".." (a pasta do projeto, para "python -m servidor" funcionar de qualquer lugar).
        $pth = Get-ChildItem -LiteralPath $destino -Filter "python3*._pth" | Select-Object -First 1
        $zipPadrao = Get-Content -LiteralPath $pth.FullName | Where-Object { $_ -match '\.zip$' } | Select-Object -First 1
        Set-Content -LiteralPath $pth.FullName -Encoding ascii -Value @($zipPadrao, ".", "Lib\site-packages", "..", "import site")

        Write-Host "  2/3 Instalando o pip..." -ForegroundColor Yellow
        $getpip = Join-Path $env:TEMP "get-pip-teleop.py"
        Invoke-WebRequest -UseBasicParsing -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getpip
        $py = Join-Path $destino "python.exe"
        if ((Rodar $py @($getpip, "--no-warn-script-location", "--disable-pip-version-check") -Silencioso) -ne 0) { throw "falha ao instalar o pip" }
        Remove-Item -LiteralPath $getpip -ErrorAction SilentlyContinue

        Write-Host "  3/3 Instalando as bibliotecas (aiortc, opencv, fastapi...). Leva de 1 a 5 minutos..." -ForegroundColor Yellow
        $codigo = Rodar $py @("-m", "pip", "install", "--prefer-binary", "--no-warn-script-location",
                              "--disable-pip-version-check", "--no-cache-dir", "-r", (Join-Path $Raiz "requirements.txt"))
        if ($codigo -ne 0) { throw "falha ao instalar as bibliotecas" }
        if (-not (Tem-Dependencias $py)) { throw "as bibliotecas foram instaladas mas nao carregam" }
    } catch {
        Write-Host "Nao consegui montar o Python portatil: $_" -ForegroundColor Red
        Remover-Pasta $destino 3 | Out-Null
        return $false
    } finally { $ProgressPreference = $progressoAnterior }
    return $true
}

# Detecao de rosto do modo ator (MediaPipe): copia local em ator\vendor, para funcionar sem
# internet. Sem ela a pagina do ator busca os mesmos arquivos na internet (CDN).
$VersaoMediaPipe = "0.10.14"
$PastaVisao = Join-Path $Raiz "ator\vendor"
function Visao-Local-Pronta {
    return (Test-Path -LiteralPath (Join-Path $PastaVisao "face_landmarker.task")) -and
           (Test-Path -LiteralPath (Join-Path $PastaVisao "wasm\vision_wasm_internal.wasm")) -and
           (Test-Path -LiteralPath (Join-Path $PastaVisao "rnnoise\rnnoise_simd.wasm"))
}
function Baixar-Visao {
    $cdn = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$VersaoMediaPipe"
    $ns = "https://cdn.jsdelivr.net/npm/@sapphi-red/web-noise-suppressor@0.3.5/dist"
    $arquivos = [ordered]@{
        "vision_bundle.mjs"                     = "$cdn/vision_bundle.mjs"
        "wasm\vision_wasm_internal.js"          = "$cdn/wasm/vision_wasm_internal.js"
        "wasm\vision_wasm_internal.wasm"        = "$cdn/wasm/vision_wasm_internal.wasm"
        "wasm\vision_wasm_nosimd_internal.js"   = "$cdn/wasm/vision_wasm_nosimd_internal.js"
        "wasm\vision_wasm_nosimd_internal.wasm" = "$cdn/wasm/vision_wasm_nosimd_internal.wasm"
        "face_landmarker.task" = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
        # reducao de ruido com IA (RNNoise) para o audio do cliente
        "rnnoise\workletProcessor.js" = "$ns/rnnoise/workletProcessor.js"
        "rnnoise\rnnoise.wasm"        = "$ns/rnnoise.wasm"
        "rnnoise\rnnoise_simd.wasm"   = "$ns/rnnoise_simd.wasm"
    }
    $tmp = $PastaVisao   # baixa direto no lugar final; a verificacao exige todos os arquivos
    $progressoAnterior = $ProgressPreference
    try {
        Remover-Pasta (Join-Path $Raiz "ator\vendor_baixando") 3 | Out-Null   # sobra de versoes antigas
        New-Item -ItemType Directory -Path (Join-Path $tmp "wasm") -Force | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $tmp "rnnoise") -Force | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        $ProgressPreference = "SilentlyContinue"
        Write-Host "Baixando a deteccao de rosto e a reducao de ruido (cerca de 15 MB)..." -ForegroundColor Yellow
        foreach ($nome in $arquivos.Keys) {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri $arquivos[$nome] -OutFile (Join-Path $tmp $nome)
        }
        return $true
    } catch {
        Write-Host "Nao consegui baixar a deteccao de rosto ($_). A pagina do ator tenta pela internet." -ForegroundColor DarkYellow
        return $false     # arquivos incompletos ficam; a proxima execucao baixa de novo por cima
    } finally { $ProgressPreference = $progressoAnterior }
}

# Atalhos na Area de Trabalho (a de verdade, mesmo quando ela fica no OneDrive).
# -Criar: cria os que faltam. Sem -Criar: so reaponta os que ja existem para a pasta atual,
# para os atalhos continuarem funcionando depois que a pasta e movida.
function Atalhos-Area-De-Trabalho([switch]$Criar) {
    try {
        $mesa = [Environment]::GetFolderPath("Desktop")
        if (-not $mesa -or -not (Test-Path -LiteralPath $mesa)) { return 0 }
        $o = [char]0x00F4; $c = [char]0x00E7; $a = [char]0x00E3
        $lista = @(
            @("Rob$o - modo ator", "iniciar_ator.bat", "Uma pessoa faz o papel do robo (mesma rede)"),
            @("Rob$o - modo ator (internet)", "iniciar_ator_internet.bat", "Link publico para colegas de qualquer computador"),
            @("Rob$o - teleopera$c$a" + "o", "iniciar.bat", "Robo Python com webcam + operador"))
        $shell = New-Object -ComObject WScript.Shell
        $feitos = 0
        foreach ($item in $lista) {
            $arq = Join-Path $mesa ($item[0] + ".lnk")
            $alvo = Join-Path $Raiz $item[1]
            if (-not (Test-Path -LiteralPath $alvo)) { continue }
            if (-not $Criar -and -not (Test-Path -LiteralPath $arq)) { continue }
            $lnk = $shell.CreateShortcut($arq)
            $lnk.TargetPath = $alvo
            $lnk.WorkingDirectory = $Raiz
            $lnk.Description = $item[2]
            $lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,22"
            $lnk.Save()
            $feitos++
        }
        return $feitos
    } catch { return 0 }
}

function Porta-Ocupada([int]$P) {
    $tcp = New-Object Net.Sockets.TcpClient
    try { $tcp.Connect("127.0.0.1", $P); return $true } catch { return $false } finally { $tcp.Close() }
}

# Espera o servidor aceitar conexoes (no primeiro uso o antivirus pode deixar o Python lento).
function Esperar-Servidor([int]$Segundos = 60) {
    for ($i = 0; $i -lt $Segundos * 2; $i++) {
        if (Porta-Ocupada $Porta) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Abre uma janela do PowerShell rodando "python -m <modulo>" nesta pasta (herda as variaveis).
function Abrir-Janela([string]$Titulo, [string]$Modulo) {
    $pyEsc = $py -replace "'", "''"
    Start-Process powershell -WorkingDirectory $Raiz -ArgumentList "-NoExit", "-NoProfile", "-Command",
        "`$host.UI.RawUI.WindowTitle='$Titulo'; & '$pyEsc' -m $Modulo"
}

# IP que os outros computadores da rede enxergam: o da placa da rota padrao (Wi-Fi/cabo),
# e nao o de adaptadores virtuais (VPN, Hyper-V, VirtualBox, Bluetooth).
function IP-Da-Rede {
    try {
        $rota = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop |
            Sort-Object { [int]$_.RouteMetric + [int]$_.InterfaceMetric } | Select-Object -First 1
        $script:IndiceRede = $rota.InterfaceIndex
        $ip = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $rota.InterfaceIndex -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike "169.254.*" } | Select-Object -First 1 -ExpandProperty IPAddress
        if ($ip) { return $ip }
    } catch {}
    try {
        return Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.InterfaceAlias -notmatch "vEthernet|VirtualBox|VMware|Loopback|Bluetooth" } |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch { return $null }
}

function Abrir-Tunel {
    if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
        Write-Host "Para -Internet instale o cloudflared (uma vez): winget install Cloudflare.cloudflared" -ForegroundColor Yellow
        Write-Host "Depois feche e abra o PowerShell e rode de novo." -ForegroundColor Yellow
        return $null
    }
    $log = Join-Path $env:TEMP "cloudflared-teleop.log"
    Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
    Start-Process cloudflared -ArgumentList "tunnel", "--url", "http://127.0.0.1:$Porta" -RedirectStandardError $log -WindowStyle Hidden
    Write-Host "Criando link publico (ate 30 s)..." -ForegroundColor Cyan
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path -LiteralPath $log) {
            $m = Select-String -LiteralPath $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($m) { return $m.Matches[0].Value }
        }
    }
    Write-Host "Nao consegui obter o link publico. Veja o log: $log" -ForegroundColor Red
    return $null
}

# --- Python -------------------------------------------------------------------
if ($Reinstalar -and (Test-Path -LiteralPath $PastaPortatil)) {
    Write-Host "Apagando o Python portatil para montar de novo..." -ForegroundColor Yellow
    Remover-Pasta $PastaPortatil | Out-Null
}
# Versao anterior montava em "python_portatil_montando" e renomeava no fim (falhava no OneDrive).
# Se essa pasta ficou pronta, aproveita: renomeia (tentando por alguns segundos) ou usa como esta.
$sobra = Join-Path $Raiz "python_portatil_montando"
$pySobra = Join-Path $sobra "python.exe"
if (-not (Test-Path -LiteralPath $PyPortatil) -and (Test-Path -LiteralPath $pySobra) -and (Tem-Dependencias $pySobra)) {
    $renomeou = $false
    for ($i = 0; $i -lt 15 -and -not $renomeou; $i++) {
        try { Rename-Item -LiteralPath $sobra -NewName "python_portatil" -ErrorAction Stop; $renomeou = $true }
        catch { Start-Sleep -Seconds 1 }
    }
    if ($renomeou) { Write-Host "Aproveitei a instalacao anterior (python_portatil_montando -> python_portatil)." -ForegroundColor Green }
    else { $PyPortatil = $pySobra; $PastaPortatil = $sobra
           Write-Host "Usando a instalacao anterior em python_portatil_montando (o Windows nao deixou renomear; funciona igual)." -ForegroundColor Yellow }
}
$py = $null
if ((Test-Path -LiteralPath $PyPortatil) -and (Tem-Dependencias $PyPortatil)) {
    $py = $PyPortatil
} elseif (-not $SoPreparar) {
    $py = Python-Do-Sistema
}
if (-not $py) {
    Write-Host ""
    Write-Host "Primeira vez: vou montar um Python proprio dentro desta pasta (python_portatil)." -ForegroundColor Cyan
    Write-Host "Precisa de internet so agora. Depois a pasta roda em qualquer Windows sem instalar nada." -ForegroundColor Cyan
    if (Montar-Portatil) { $py = $PyPortatil }
}
if (-not $py) {
    Write-Host ""
    Write-Host "Nao foi possivel preparar o Python." -ForegroundColor Red
    Write-Host " - Confira a internet (so e necessaria nesta primeira vez) e rode de novo." -ForegroundColor Red
    Write-Host " - Ou rode este script num computador com internet e copie a pasta INTEIRA (com python_portatil)." -ForegroundColor Red
    exit 1
}
Write-Host "Usando: $py" -ForegroundColor DarkGray
if ($SoPreparar) {
    if ($Reinstalar -or -not (Visao-Local-Pronta)) { Baixar-Visao | Out-Null }
    $n = Atalhos-Area-De-Trabalho -Criar
    Write-Host ""
    if ($n -gt 0) { Write-Host "Criei $n atalhos na Area de Trabalho (Robo - modo ator, modo ator (internet) e teleoperacao)." -ForegroundColor Green }
    Write-Host "Pronto! A pasta python_portatil foi montada$(if (Visao-Local-Pronta) { ' e a deteccao de rosto esta em ator\vendor' })." -ForegroundColor Green
    Write-Host "Agora copie a pasta INTEIRA do projeto para outro computador e use iniciar.bat ou iniciar_ator.bat." -ForegroundColor Green
    exit 0
}

# atalhos que ja existem passam a apontar para esta pasta (caso ela tenha sido movida)
Atalhos-Area-De-Trabalho | Out-Null

# --- Porta --------------------------------------------------------------------
if (Porta-Ocupada $Porta) {
    $original = $Porta
    while ((Porta-Ocupada $Porta) -and $Porta -lt $original + 20) { $Porta++ }
    Write-Host "A porta $original ja esta em uso (talvez uma janela SERVIDOR antiga ainda aberta). Usando a porta $Porta." -ForegroundColor Yellow
}

# --- Tokens (herdados pelas janelas filhas) ------------------------------------
# Normal: novos a cada execucao. Modo ator: guardados em tokens_ator.txt, para o link do
# computador do cliente nao mudar (pode virar favorito). Apague o arquivo para trocar.
$arquivoTokens = Join-Path $Raiz "tokens_ator.txt"
if ($Ator -and (Test-Path -LiteralPath $arquivoTokens)) {
    $guardados = @(Get-Content -LiteralPath $arquivoTokens | Where-Object { $_ -match '^[A-Za-z0-9]{20}$' })
} else { $guardados = @() }
if ($guardados.Count -eq 3) {
    $env:TOKEN_ROBO = $guardados[0]; $env:TOKEN_OPERADOR = $guardados[1]; $env:TOKEN_CLIENTE = $guardados[2]
} else {
    $env:TOKEN_ROBO = Novo-Token
    $env:TOKEN_OPERADOR = Novo-Token
    $env:TOKEN_CLIENTE = Novo-Token
    if ($Ator) { Set-Content -LiteralPath $arquivoTokens -Value @($env:TOKEN_ROBO, $env:TOKEN_OPERADOR, $env:TOKEN_CLIENTE) -Encoding ascii }
}
$env:SERVIDOR_PORTA = "$Porta"
$env:URL_SERVIDOR = "ws://127.0.0.1:$Porta/ws"
if ($Sintetica) { $env:SINTETICA = "1" }
# hora da captura gravada nos pixels: o operador ve o atraso real do video (meta < 300 ms)
$env:MARCAR_TIMESTAMP = $(if ($SemMarca) { "0" } else { "1" })

# --- Firewall ------------------------------------------------------------------
try {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($admin -and -not (Get-NetFirewallRule -DisplayName "Teleoperacao $Porta" -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName "Teleoperacao $Porta" -Direction Inbound -Protocol TCP -LocalPort $Porta -Action Allow -Profile Private | Out-Null
    }
} catch {}
$IndiceRede = $null
$ip = IP-Da-Rede
# Rede marcada como "Publica" bloqueia conexoes vindas de outros computadores
$redePublica = $false
try {
    $perfis = if ($IndiceRede) { Get-NetConnectionProfile -InterfaceIndex $IndiceRede -ErrorAction Stop } else { Get-NetConnectionProfile -ErrorAction Stop }
    $redePublica = [bool]($perfis | Where-Object { "$($_.NetworkCategory)" -eq "Public" })
} catch {}
$t = $env:TOKEN_OPERADOR
$c = $env:TOKEN_CLIENTE

function Avisos-Rede {
    if ($redePublica -and -not $Internet) {
        Write-Host ""
        Write-Host "ATENCAO: esta rede esta marcada como PUBLICA no Windows; o outro computador pode nao conseguir entrar." -ForegroundColor Yellow
        Write-Host "  Corrija em: Configuracoes > Rede e Internet > Wi-Fi (ou Ethernet) > Propriedades > Rede privada." -ForegroundColor Yellow
        Write-Host "  Ou, se o Windows perguntar sobre o Firewall, marque tambem 'Redes publicas' e clique em Permitir." -ForegroundColor Yellow
        Write-Host "  Rede da faculdade/empresa que bloqueia: use -Internet (veja o guia)." -ForegroundColor Yellow
    }
}

# =============================== MODO ATOR =====================================
if ($Ator) {
    $env:AUTO_ACEITAR = "1"
    $proto = "http"
    # IA opcional nas respostas (GUIA_IA.txt, Google Gemini). A chave so e lida pelo servidor, neste computador.
    foreach ($nome in @("GOOGLE_API_KEY", "GEMINI_API_KEY")) {
        if (-not [Environment]::GetEnvironmentVariable($nome, "Process")) {
            $daConta = [Environment]::GetEnvironmentVariable($nome, "User")   # setx recente
            if ($daConta) { Set-Item -Path "env:$nome" -Value $daConta }
        }
    }
    if (-not (Visao-Local-Pronta)) { Baixar-Visao | Out-Null }   # rapido; sem internet so avisa
    $iaPronta = (Test-Path -LiteralPath (Join-Path $Raiz "servidor\ia.py")) -and
                ([bool]$env:GOOGLE_API_KEY -or [bool]$env:GEMINI_API_KEY -or (Test-Path -LiteralPath (Join-Path $Raiz "chave_ia.txt")))
    if (-not $Internet) {
        # HTTPS na rede local: sem ele o navegador do outro computador nao libera camera e microfone.
        # O certificado e refeito sozinho quando o IP muda (outro computador ou outra rede).
        # Os caminhos sao montados AQUI, e nao lidos da saida do Python: com acento na pasta
        # ("Area de Trabalho") a saida do Python chegava com outra codificacao e o caminho quebrava.
        $pastaCert = Join-Path $Raiz "certificado"
        $cert = Join-Path $pastaCert "cert.pem"; $chave = Join-Path $pastaCert "key.pem"
        $codigo = Rodar $py @("-m", "servidor.certificado", $pastaCert) -Silencioso
        if ($codigo -eq 0 -and (Test-Path -LiteralPath $cert) -and (Test-Path -LiteralPath $chave)) {
            $env:SSL_CERT = $cert; $env:SSL_KEY = $chave; $proto = "https"
        } else {
            Write-Host "Nao consegui criar o certificado HTTPS; a camera do outro computador nao vai funcionar." -ForegroundColor Red
        }
    }
    Write-Host "Ligando o servidor (modo ator)..." -ForegroundColor Cyan
    Abrir-Janela "SERVIDOR (modo ator)" "servidor"
    if (-not (Esperar-Servidor)) {
        Write-Host "O servidor nao respondeu em 60 s. Veja a mensagem de erro na janela SERVIDOR." -ForegroundColor Red
        exit 1
    }

    $r = $env:TOKEN_ROBO
    $linkAtor = "${proto}://127.0.0.1:$Porta/ator/?token=$r"
    $linkCliente = if ($ip) { "${proto}://${ip}:$Porta/conversa/?token=$c" } else { "${proto}://127.0.0.1:$Porta/conversa/?token=$c" }
    $url = $null
    if ($Internet) {
        $url = Abrir-Tunel
        if ($url) { $linkCliente = "$url/conversa/?token=$c"; $linkAtor = "$url/ator/?token=$r" }
    }
    Set-Content -LiteralPath (Join-Path $Raiz "LINKS.txt") -Encoding utf8 -Value @(
        "ATOR (quem faz o papel do robo, NESTE computador, com fone):", "  $linkAtor", "",
        "CLIENTE (abra no OUTRO computador, em Chrome ou Edge):", "  $linkCliente")

    Write-Host ""
    Write-Host "================ MODO ATOR PRONTO ================" -ForegroundColor Green
    Write-Host "1) ATOR - abra NESTE computador (use fone de ouvido):" -ForegroundColor Cyan
    Write-Host "   $linkAtor"
    Write-Host "2) CLIENTE - abra no OUTRO computador (Chrome ou Edge):" -ForegroundColor Cyan
    Write-Host "   $linkCliente"
    if ($proto -eq "https" -and -not $url) {
        Write-Host ""
        Write-Host "Na primeira vez o navegador avisa 'Sua conexao nao e particular'." -ForegroundColor Yellow
        Write-Host "Clique em 'Avancado' e depois em 'Continuar para ...'. Faca isso nos DOIS computadores." -ForegroundColor Yellow
        Write-Host "Se o Windows perguntar sobre o Firewall, clique em 'Permitir acesso'." -ForegroundColor Yellow
    }
    Avisos-Rede
    Write-Host ""
    if ($iaPronta) {
        Write-Host "IA nas respostas: chave encontrada (use o painel 'Respostas da IA' na pagina do ator)." -ForegroundColor Green
    } else {
        Write-Host "IA nas respostas: desligada (opcional). Veja GUIA_IA.txt para ativar." -ForegroundColor DarkGray
    }
    Write-Host "Os links tambem foram salvos em LINKS.txt (mudam so se o IP ou a porta mudarem)."
    Write-Host "Para desligar: feche a janela SERVIDOR."
    Write-Host "==================================================" -ForegroundColor Green
    try { Start-Process $linkAtor } catch {}
    exit 0
}

# --- Servidor e robo, cada um na sua janela ------------------------------------
Write-Host "Ligando o servidor..." -ForegroundColor Cyan
Abrir-Janela "SERVIDOR" "servidor"
if (-not (Esperar-Servidor)) {
    Write-Host "O servidor nao respondeu em 60 s. Veja a mensagem de erro na janela SERVIDOR." -ForegroundColor Red
    exit 1
}
Write-Host "Ligando o robo..." -ForegroundColor Cyan
Abrir-Janela "ROBO" "robo"

$linkOperador = "http://127.0.0.1:$Porta/operador/?token=$t"
$linkClienteRede = if ($ip) { "http://${ip}:$Porta/cliente/?token=$c" } else { "http://127.0.0.1:$Porta/cliente/?token=$c" }
Write-Host ""
Write-Host "================ PRONTO ================" -ForegroundColor Green
Write-Host "OPERADOR (voce - supervisiona, aceita pedidos, ve o video):" -ForegroundColor Cyan
Write-Host "  $linkOperador"
Write-Host "CLIENTES (amigos/usuarios - audio e chat):" -ForegroundColor Cyan
Write-Host "  mesma rede:  $linkClienteRede"
Write-Host "  (sem HTTPS o navegador de OUTRO computador nao libera o microfone; para isso use -Internet)" -ForegroundColor DarkGray
$linhas = @("OPERADOR (neste computador):", "  $linkOperador", "", "CLIENTE (mesma rede):", "  $linkClienteRede")

if ($Internet) {
    $url = Abrir-Tunel
    if ($url) {
        Write-Host "Pela internet (HTTPS, microfone liberado):"
        Write-Host "  CLIENTES:  $url/cliente/?token=$c"
        Write-Host "  OPERADOR:  $url/operador/?token=$t"
        Write-Host "ATENCAO: o link do OPERADOR controla o robo e mostra a camera. NAO o envie a clientes." -ForegroundColor Yellow
        Write-Host "Quem tem o link de CLIENTE so pede atendimento; voce precisa aceitar." -ForegroundColor Yellow
        $linhas += @("", "PELA INTERNET:", "  CLIENTE:  $url/cliente/?token=$c", "  OPERADOR: $url/operador/?token=$t")
    }
}
Set-Content -LiteralPath (Join-Path $Raiz "LINKS.txt") -Encoding utf8 -Value $linhas
Avisos-Rede

Write-Host "========================================" -ForegroundColor Green
Write-Host "Para desligar tudo: feche as janelas SERVIDOR e ROBO (ou Ctrl+C em cada uma)."
Write-Host "Os tokens mudam a cada vez que voce roda este script (links salvos em LINKS.txt)."
try { Start-Process $linkOperador } catch {}
