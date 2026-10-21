"""Simulated eBUS adapters for the end-to-end tests.

FakeBus simulates the bus behind an adapter: a SYN every 40 ms and, every
second, a telegram of master 10 (alternating broadcast and master-slave).
When ebusd sends, the bus echoes each symbol like the real wire does, and a
master part addressed to slave 08 is answered with SLAVE_08_ANSWER.

Transports: TCP server (network adapter) or pseudo terminal (USB adapter).
Protocols: plain bytes, or ebusd's enhanced adapter protocol (enh:/ens:).
"""

import os
import socket
import threading
import time
import tty

SYN = 0xAA
BYTE_TIME = 10 / 2400  # 2400 baud, 10 bits per byte
SYN_INTERVAL = 0.04
OWNER_TIMEOUT = 0.3  # bus is released (AUTO-SYN) when a sender stalls this long


def _crc_table():
    table = []
    for value in range(256):
        for _ in range(8):
            value = ((value << 1) ^ 0x9B) if value & 0x80 else value << 1
        table.append(value & 0xFF)
    return table


CRC_TABLE = _crc_table()


def telegram(hexstr):
    """Return the bytes of a telegram part plus its CRC (no ESC/SYN inside)."""
    data = bytes.fromhex(hexstr)
    crc = 0
    for byte in data:
        crc = CRC_TABLE[crc] ^ byte
    return data + bytes([crc])


# telegrams of master 10, written the way ebusd logs them ("received unknown ... cmd")
BROADCAST = "10feb516080003181021100626"
MS_MASTER = "1008b5110101"
MS_SLAVE = "0a1e1f4600190a00ff8000"
TRAFFIC = [telegram(BROADCAST), telegram(MS_MASTER) + b"\x00" + telegram(MS_SLAVE) + b"\x00"]
SLAVE_08_ANSWER = "020102"

# enhanced protocol commands (ebusd src/lib/ebus/device_enhanced.h)
ENH_INIT, ENH_SEND, ENH_START = 0x0, 0x1, 0x2  # requests from ebusd
ENH_RESETTED, ENH_RECEIVED, ENH_STARTED = 0x0, 0x1, 0x2  # responses of the adapter


def enhanced(cmd, data):
    return bytes([0xC0 | (cmd << 2) | (data >> 6), 0x80 | (data & 0x3F)])


class FakeBus:
    def __init__(self, enhanced_protocol):
        self.enhanced = enhanced_protocol
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.write = None
        self.owner = False  # ebusd is sending a telegram
        self.owner_since = 0.0
        self.start_request = None  # enhanced: address ebusd wants to arbitrate with
        self.sent = bytearray()  # symbols of ebusd's current telegram

    def _output(self, data):
        with self.lock:
            try:
                self.write(data)
            except OSError:
                pass

    def _on_bus(self, symbols):
        """Symbols appear on the bus: the adapter reports them to ebusd."""
        if self.enhanced:
            data = b"".join(bytes([s]) if s < 0x80 else enhanced(ENH_RECEIVED, s) for s in symbols)
        else:
            data = bytes(symbols)
        self._output(data)

    def _ebusd_sends(self, symbol):
        """ebusd puts a symbol on the bus: echo it, answer as slave 08."""
        self._on_bus([symbol])
        if symbol == SYN:
            self.owner = False
            self.sent.clear()
            return
        if not self.owner:
            self.owner = True
            self.owner_since = time.monotonic()
        self.sent.append(symbol)
        sent = self.sent
        if len(sent) >= 5 and sent[1] == 0x08 and len(sent) == 6 + sent[4]:
            self._on_bus(b"\x00" + telegram(SLAVE_08_ANSWER))

    def _from_ebusd(self, data, pending):
        if not self.enhanced:
            for symbol in data:
                self._ebusd_sends(symbol)
            return pending
        pending += data
        while pending:
            if pending[0] < 0x80:  # short form of SEND
                self._ebusd_sends(pending[0])
                pending = pending[1:]
                continue
            if len(pending) < 2:
                break
            cmd = (pending[0] >> 2) & 0x0F
            value = ((pending[0] & 0x03) << 6) | (pending[1] & 0x3F)
            pending = pending[2:]
            if cmd == ENH_INIT:
                self._output(enhanced(ENH_RESETTED, 0x00))
            elif cmd == ENH_START:
                self.start_request = None if value == SYN else value
            elif cmd == ENH_SEND:
                self._ebusd_sends(value)
        return pending

    def _generate(self, connected):
        count = 0
        while connected.is_set() and not self.stopped.is_set():
            time.sleep(SYN_INTERVAL)
            if self.owner and time.monotonic() - self.owner_since < OWNER_TIMEOUT:
                continue
            self.owner = False
            self.sent.clear()
            self._on_bus([SYN])
            if self.enhanced and self.start_request is not None:
                address, self.start_request = self.start_request, None
                self.owner = True
                self.owner_since = time.monotonic()
                self.sent = bytearray([address])
                self._output(enhanced(ENH_STARTED, address))
                continue
            if not self.enhanced:
                time.sleep(0.005)  # a plain ebusd starts sending right after SYN
                if self.owner:
                    continue
            count += 1
            if count % 25 == 0:
                for symbol in TRAFFIC[(count // 25) % 2]:
                    self._on_bus([symbol])
                    time.sleep(BYTE_TIME)

    def _serve(self, write, read):
        """Run the bus for one connection until read() fails or returns nothing."""
        self.write = write
        self.owner = False
        self.start_request = None
        self.sent.clear()
        connected = threading.Event()
        connected.set()
        threading.Thread(target=self._generate, args=(connected,), daemon=True).start()
        pending = b""
        try:
            while not self.stopped.is_set():
                data = read()
                if not data:
                    break
                pending = self._from_ebusd(data, pending)
        except OSError:
            pass
        connected.clear()


class TcpAdapter(FakeBus):
    """Network adapter, e.g. --device=enh:127.0.0.1:PORT."""

    def __init__(self, enhanced_protocol=True):
        super().__init__(enhanced_protocol)
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        self.conn = None
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while not self.stopped.is_set():
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            self.conn = conn
            self._serve(conn.sendall, lambda: conn.recv(256))
            conn.close()

    def stop(self):
        self.stopped.set()
        self.server.close()
        if self.conn:
            self.conn.close()


class PtyAdapter(FakeBus):
    """USB adapter: ebusd gets the pseudo terminal at self.path as its device."""

    def __init__(self, enhanced_protocol=False):
        super().__init__(enhanced_protocol)
        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)  # no echo or line editing before ebusd configures it
        self.path = os.ttyname(self.slave)
        threading.Thread(target=self._serve, daemon=True,
                         args=(lambda data: os.write(self.master, data),
                               lambda: os.read(self.master, 256))).start()

    def stop(self):
        self.stopped.set()
        os.close(self.master)
        os.close(self.slave)
