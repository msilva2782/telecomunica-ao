"""Certificado HTTPS autoassinado para a rede local.

O navegador só libera câmera e microfone em HTTPS (ou no próprio computador). Para o
cliente abrir a página de outro computador da mesma rede, o servidor precisa de HTTPS.
Este módulo cria um certificado válido para localhost e para os IPs desta máquina.
Na primeira visita o navegador avisa que o certificado não é confiável: clique em
"Avançado" e depois em "Continuar". O aviso só volta se o certificado mudar.

Uso:  python -m servidor.certificado PASTA     (imprime os caminhos do cert e da chave)
"""
import datetime
import ipaddress
import socket
import sys
from pathlib import Path
from typing import List, Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def ips_locais() -> List[str]:
    ips = {"127.0.0.1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    try:  # IP da rota padrão (o que os outros computadores da rede enxergam)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(i for i in ips if not i.startswith("169.254."))


def _ips_do_certificado(caminho: Path) -> List[str]:
    cert = x509.load_pem_x509_certificate(caminho.read_bytes())
    if cert.not_valid_after_utc < datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7):
        return []
    san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    return [str(i) for i in san.get_values_for_type(x509.IPAddress)]


def garantir(pasta: Path) -> Tuple[Path, Path]:
    """Reaproveita o certificado se ainda cobre os IPs atuais; senão cria outro."""
    pasta.mkdir(parents=True, exist_ok=True)
    cert_pem, chave_pem = pasta / "cert.pem", pasta / "key.pem"
    ips = ips_locais()
    if cert_pem.exists() and chave_pem.exists():
        try:
            if set(ips) <= set(_ips_do_certificado(cert_pem)):
                return cert_pem, chave_pem
        except (ValueError, x509.ExtensionNotFound):
            pass

    chave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nome = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Teleoperacao local")])
    agora = datetime.datetime.now(datetime.timezone.utc)
    nomes = [x509.DNSName("localhost")] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    cert = (x509.CertificateBuilder()
            .subject_name(nome).issuer_name(nome)
            .public_key(chave.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(agora - datetime.timedelta(days=1))
            .not_valid_after(agora + datetime.timedelta(days=365))
            .add_extension(x509.SubjectAlternativeName(nomes), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(chave, hashes.SHA256()))
    cert_pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    chave_pem.write_bytes(chave.private_bytes(serialization.Encoding.PEM,
                                              serialization.PrivateFormat.TraditionalOpenSSL,
                                              serialization.NoEncryption()))
    return cert_pem, chave_pem


if __name__ == "__main__":
    cert, chave = garantir(Path(sys.argv[1] if len(sys.argv) > 1 else "certificado"))
    print(cert.resolve())
    print(chave.resolve())
