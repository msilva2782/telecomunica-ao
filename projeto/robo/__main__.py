import asyncio
import logging

from .cliente import Robo


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        asyncio.run(Robo().executar())
    except KeyboardInterrupt:
        pass


main()
