#!/usr/bin/env python3
"""
MJPEG Camera — reads from rpicam-vid TCP stream on the host,
serves /stream (multipart MJPEG) and /snapshot (single JPEG) via HTTP.

Host command:
  rpicam-vid --codec mjpeg -t 0 --nopreview --width 1280 --height 720 \
    --framerate 15 --listen -o tcp://0.0.0.0:8554
"""
import asyncio
import logging

logger = logging.getLogger('camera_mjpeg')

_SOI = b'\xff\xd8'
_EOI = b'\xff\xd9'


class MJPEGCamera:
    def __init__(self, host='localhost', port=8554):
        self.host = host
        self.port = port
        self._latest_frame = None
        self._frame_event = asyncio.Event()
        self._running = False

    async def start(self):
        if self._running:
            return True
        for attempt in range(5):
            try:
                reader, _ = await asyncio.wait_for(
                    asyncio.open_connection(self.host, self.port), timeout=5
                )
                self._running = True
                asyncio.ensure_future(self._read_loop(reader))
                logger.info(f"Camera connected tcp://{self.host}:{self.port}")
                return True
            except Exception as e:
                logger.warning(f"Camera connect {attempt+1}/5: {e}")
                await asyncio.sleep(2)
        logger.error(f"Cannot connect to camera at {self.host}:{self.port}")
        return False

    async def _read_loop(self, reader):
        buf = bytearray()
        try:
            while self._running:
                chunk = await reader.read(262144)
                if not chunk:
                    break
                buf.extend(chunk)
                while True:
                    soi = buf.find(_SOI)
                    if soi == -1:
                        buf.clear()
                        break
                    eoi = buf.find(_EOI, soi + 2)
                    if eoi == -1:
                        if soi > 0:
                            del buf[:soi]
                        break
                    frame = bytes(buf[soi:eoi + 2])
                    del buf[:eoi + 2]
                    self._latest_frame = frame
                    self._frame_event.set()
                    self._frame_event.clear()
        except Exception as e:
            logger.error(f"Camera read loop error: {e}")
        finally:
            self._running = False
            logger.warning("Camera stream ended")

    @property
    def frame(self):
        return self._latest_frame

    async def wait_frame(self, timeout=2.0):
        try:
            await asyncio.wait_for(self._frame_event.wait(), timeout)
        except asyncio.TimeoutError:
            pass
        return self._latest_frame
