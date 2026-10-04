"""This computer's addresses on the local network, so phones know where to find the server."""
import socket
from typing import List


def lan_addresses() -> List[str]:
    found: List[str] = []
    try:
        # The address of the interface that routes outward (a UDP "connect" sends no packets)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))
            found.append(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(info[4][0])
    except OSError:
        pass
    usable = [ip for ip in dict.fromkeys(found)
              if not ip.startswith(("127.", "169.254.")) and ip != "0.0.0.0"]
    return usable
