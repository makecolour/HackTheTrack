#!/usr/bin/env python3
"""
MJPEG Camera — launches rpicam-vid as a subprocess, reads from its TCP stream,
serves /stream (multipart MJPEG) and /snapshot (single JPEG) via HTTP.

The camera process is fully managed: auto-started, monitored, and restarted.
"""
import asyncio
import logging
import shutil
import subprocess

logger = logging.getLogger('camera_mjpeg')

_SOI = b'\xff\xd8'
_EOI = b'\xff\xd9'


class MJPEGCamera:
    def __init__(self, host='localhost', port=8554, width=1280, height=720, fps=15):
        self.host = host
        self.port = port
        self.width = width
        self.height = height
        self.fps = fps
        self._latest_frame = None
        self._frame_event = asyncio.Event()
        self._running = False
        self._process = None  # rpicam-vid subprocess

    async def start(self):
        """Launch rpicam-vid and connect to its TCP stream."""
        if self._running:
            return True

        # Start rpicam-vid subprocess
        if not await self._start_rpicam():
            return False

        # Give rpicam-vid a moment to bind its TCP port
        await asyncio.sleep(1.5)

        # Connect to the TCP stream
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
                # Check if process died
                if self._process and self._process.poll() is not None:
                    logger.error(f"rpicam-vid exited with code {self._process.returncode}")
                    self._process = None
                    return False
                await asyncio.sleep(2)
        logger.error(f"Cannot connect to camera at {self.host}:{self.port}")
        return False

    async def _start_rpicam(self):
        """Launch rpicam-vid as a managed subprocess."""
        # Kill any existing rpicam-vid first
        self._stop_rpicam()

        # Find rpicam-vid binary
        rpicam = shutil.which('rpicam-vid')
        if not rpicam:
            # Fallback to libcamera-vid (older Pi OS)
            rpicam = shutil.which('libcamera-vid')
        if not rpicam:
            logger.error("rpicam-vid / libcamera-vid not found on PATH")
            return False

        cmd = [
            rpicam,
            '--codec', 'mjpeg',
            '-t', '0',
            '--nopreview',
            '--width', str(self.width),
            '--height', str(self.height),
            '--framerate', str(self.fps),
            '--listen',
            '-o', f'tcp://0.0.0.0:{self.port}',
        ]
        logger.info(f"Starting camera: {' '.join(cmd)}")
        try:
            self._process = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            logger.info(f"rpicam-vid started (PID {self._process.pid})")
            return True
        except Exception as e:
            logger.error(f"Failed to start rpicam-vid: {e}")
            return False

    def _stop_rpicam(self):
        """Terminate the rpicam-vid subprocess if running."""
        if self._process:
            try:
                self._process.terminate()
                self._process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)
            except Exception:
                pass
            logger.info("rpicam-vid process stopped")
            self._process = None
        # Also kill any orphaned rpicam-vid on our port
        try:
            subprocess.run(
                ['fuser', '-k', f'{self.port}/tcp'],
                capture_output=True, timeout=3
            )
        except Exception:
            pass

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

    def cleanup(self):
        """Stop camera subprocess. Call on daemon shutdown."""
        self._running = False
        self._stop_rpicam()
