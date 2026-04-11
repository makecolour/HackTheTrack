#!/usr/bin/env python3
"""
Hardware Daemon for SE Preliminary Delivery Bot (Raspberry Pi 5)
- HTTP API on :8765 for motor control, camera stream, RFID, status
- Socket.IO client connecting to Node.js backend for real-time events
- Auto-starts rpicam-vid subprocess for camera (no manual setup needed)
"""
import asyncio
import json
import os
import signal
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(name)s] %(levelname)s: %(message)s'
)
logger = logging.getLogger('daemon')

CONFIG_PATH = os.path.join(os.path.dirname(__file__), 'config.json')
try:
    with open(CONFIG_PATH) as f:
        CONFIG = json.load(f)
except FileNotFoundError:
    CONFIG = {}

from motor_control import create_motor
from camera_mjpeg import MJPEGCamera

try:
    from rfid_reader import MFRC522Reader
    RFID_AVAILABLE = True
except ImportError:
    RFID_AVAILABLE = False
    logger.warning("RFID reader not available (spidev/lgpio missing)")

try:
    import socketio
    SIO_AVAILABLE = True
except ImportError:
    SIO_AVAILABLE = False

from aiohttp import web


class Daemon:
    def __init__(self):
        self.motor = create_motor(CONFIG)
        cam_cfg = CONFIG.get('camera', {})
        self.camera = MJPEGCamera(
            host=cam_cfg.get('host', 'localhost'),
            port=cam_cfg.get('port', 8554),
            width=cam_cfg.get('width', 1280),
            height=cam_cfg.get('height', 720),
            fps=cam_cfg.get('fps', 15),
        )
        self.rfid = None
        self.rfid_scanning = False
        if RFID_AVAILABLE:
            rfid_cfg = CONFIG.get('rfid', {})
            try:
                self.rfid = MFRC522Reader(
                    bus=rfid_cfg.get('bus', 0),
                    device=rfid_cfg.get('device', 0),
                    rst_pin=rfid_cfg.get('rst_pin', 25),
                    gpio_chip=rfid_cfg.get('gpio_chip', 0),
                )
            except Exception as e:
                logger.warning(f"RFID init failed: {e}")

        self.sio = None
        self.server_url = CONFIG.get('server_url', 'http://localhost:3000')
        self.http_port = CONFIG.get('http_port', 8765)

    # ── HTTP API ──
    def create_app(self):
        app = web.Application()
        app.router.add_get('/status', self.handle_status)
        app.router.add_post('/motor', self.handle_motor)
        app.router.add_get('/stream', self.handle_stream)
        app.router.add_get('/snapshot', self.handle_snapshot)
        app.router.add_post('/rfid/scan', self.handle_rfid_scan)
        app.router.add_post('/rfid/stop', self.handle_rfid_stop)
        # CORS headers
        @web.middleware
        async def cors(request, handler):
            resp = await handler(request)
            resp.headers['Access-Control-Allow-Origin'] = '*'
            resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
            return resp
        app.middlewares.append(cors)
        return app

    async def handle_status(self, request):
        return web.json_response({
            'motor': self.motor.get_status(),
            'camera': self.camera._running,
            'rfid': self.rfid is not None,
            'rfid_scanning': self.rfid_scanning,
        })

    async def handle_motor(self, request):
        data = await request.json()
        cmd = data.get('command', 'stop')
        speed = data.get('speed', 50)
        if cmd == 'forward':    self.motor.forward(speed)
        elif cmd == 'backward': self.motor.backward(speed)
        elif cmd == 'left':     self.motor.turn_left(speed)
        elif cmd == 'right':    self.motor.turn_right(speed)
        else:                   self.motor.stop()
        # Relay to backend via Socket.IO
        if self.sio and self.sio.connected:
            await self.sio.emit('motor-status', self.motor.get_status())
        return web.json_response({'ok': True, 'status': self.motor.get_status()})

    async def handle_stream(self, request):
        if not self.camera._running or not self.camera.frame:
            return web.json_response(
                {'error': 'Camera not connected — start rpicam-vid on port 8554'},
                status=503
            )
        response = web.StreamResponse(
            status=200,
            headers={
                'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
                'Cache-Control': 'no-cache',
            }
        )
        await response.prepare(request)
        try:
            while True:
                frame = self.camera.frame
                if frame:
                    await response.write(
                        b'--frame\r\nContent-Type: image/jpeg\r\n'
                        b'Content-Length: ' + str(len(frame)).encode() + b'\r\n\r\n'
                        + frame + b'\r\n'
                    )
                await asyncio.sleep(1 / 15)
        except (ConnectionResetError, asyncio.CancelledError):
            pass
        return response

    async def handle_snapshot(self, request):
        frame = self.camera.frame
        if not frame:
            return web.json_response({'error': 'no frame'}, status=503)
        return web.Response(body=frame, content_type='image/jpeg')

    async def handle_rfid_scan(self, request):
        if not self.rfid:
            return web.json_response({'error': 'RFID not available'}, status=503)
        self.rfid_scanning = True
        return web.json_response({'ok': True, 'scanning': True})

    async def handle_rfid_stop(self, request):
        self.rfid_scanning = False
        return web.json_response({'ok': True, 'scanning': False})

    # ── RFID scan loop ──
    async def rfid_loop(self):
        last_uid = None
        while True:
            if self.rfid_scanning and self.rfid:
                try:
                    uid = self.rfid.read_id_no_block()
                    if uid and uid != last_uid:
                        last_uid = uid
                        uid_hex = f"{uid:08X}"
                        logger.info(f"RFID scanned: {uid_hex}")
                        if self.sio and self.sio.connected:
                            await self.sio.emit('rfid-scanned', {'uid': uid_hex, 'raw': uid})
                    elif not uid:
                        last_uid = None
                except Exception as e:
                    logger.warning(f"RFID read error: {e}")
            await asyncio.sleep(0.2)

    # ── Socket.IO connection to Node.js backend ──
    async def connect_backend(self):
        if not SIO_AVAILABLE:
            logger.warning("python-socketio not installed, skipping backend connection")
            return

        self.sio = socketio.AsyncClient(reconnection=True, reconnection_delay=2)

        @self.sio.event
        async def connect():
            logger.info(f"Connected to backend: {self.server_url}")
            await self.sio.emit('join-room', 'hardware')
            await self.sio.emit('hardware-status', {
                'status': 'connected',
                'motor': self.motor.get_status(),
                'camera': self.camera._running,
                'rfid': self.rfid is not None,
            })

        @self.sio.event
        async def disconnect():
            logger.warning("Disconnected from backend")

        @self.sio.on('motor-command')
        async def on_motor(data):
            cmd = data.get('command', 'stop')
            speed = data.get('speed', 50)
            if cmd == 'forward':    self.motor.forward(speed)
            elif cmd == 'backward': self.motor.backward(speed)
            elif cmd == 'left':     self.motor.turn_left(speed)
            elif cmd == 'right':    self.motor.turn_right(speed)
            else:                   self.motor.stop()
            await self.sio.emit('motor-status', self.motor.get_status())

        @self.sio.on('rfid-start-scan')
        async def on_rfid_start(data=None):
            self.rfid_scanning = True
            logger.info("RFID scanning started (via backend)")

        @self.sio.on('rfid-stop-scan')
        async def on_rfid_stop(data=None):
            self.rfid_scanning = False
            logger.info("RFID scanning stopped (via backend)")

        try:
            await self.sio.connect(self.server_url, transports=['websocket', 'polling'])
        except Exception as e:
            logger.warning(f"Backend connect failed: {e}")

    # ── Main ──
    async def run(self):
        # Kill any previous daemon still holding our ports
        await self._kill_stale_ports()

        # Start camera (non-fatal — daemon continues without camera)
        cam_ok = await self.camera.start()
        if not cam_ok:
            logger.warning("Camera not available — daemon will keep running without video")
            # Start background reconnect loop
            asyncio.ensure_future(self._camera_reconnect_loop())

        # Connect to Node.js backend
        asyncio.ensure_future(self.connect_backend())

        # Start RFID polling
        asyncio.ensure_future(self.rfid_loop())

        # Start HTTP server
        app = self.create_app()
        runner = web.AppRunner(app)
        await runner.setup()
        try:
            site = web.TCPSite(runner, '0.0.0.0', self.http_port)
            await site.start()
        except OSError as e:
            if e.errno == 98:  # EADDRINUSE
                logger.error(f"Port {self.http_port} in use — killing old process and retrying")
                await self._kill_stale_ports()
                await asyncio.sleep(1)
                site = web.TCPSite(runner, '0.0.0.0', self.http_port)
                await site.start()
            else:
                raise
        logger.info(f"HTTP API on http://0.0.0.0:{self.http_port}")
        logger.info(f"Camera stream: http://0.0.0.0:{self.http_port}/stream")

        # Run forever
        try:
            while True:
                await asyncio.sleep(3600)
        except asyncio.CancelledError:
            pass
        finally:
            self.motor.cleanup()
            self.camera.cleanup()
            if self.rfid:
                self.rfid.cleanup()
            await runner.cleanup()

    async def _kill_stale_ports(self):
        """Kill any leftover processes on our port (Linux only)."""
        import subprocess
        for port in [self.http_port]:
            try:
                result = subprocess.run(
                    ['fuser', '-k', f'{port}/tcp'],
                    capture_output=True, timeout=5
                )
                if result.returncode == 0:
                    logger.info(f"Killed stale process on port {port}")
            except FileNotFoundError:
                # fuser not available, try lsof
                try:
                    result = subprocess.run(
                        ['lsof', '-ti', f':{port}'],
                        capture_output=True, text=True, timeout=5
                    )
                    for pid in result.stdout.strip().split('\n'):
                        pid = pid.strip()
                        if pid and pid != str(os.getpid()):
                            subprocess.run(['kill', '-9', pid], timeout=5)
                            logger.info(f"Killed stale PID {pid} on port {port}")
                except Exception:
                    pass
            except Exception:
                pass

    async def _camera_reconnect_loop(self):
        """Keep trying to restart camera subprocess and reconnect."""
        while True:
            await asyncio.sleep(10)
            if self.camera._running:
                continue
            logger.info("Attempting camera restart...")
            self.camera.cleanup()  # Kill any stale rpicam-vid
            ok = await self.camera.start()  # Re-launches rpicam-vid + reconnects
            if ok:
                logger.info("Camera restarted successfully!")
                break


def main():
    daemon = Daemon()
    loop = asyncio.new_event_loop()

    def _shutdown(sig, frame):
        logger.info(f"Shutting down (signal {sig})")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        loop.run_until_complete(daemon.run())
    except KeyboardInterrupt:
        pass
    finally:
        loop.close()
        logger.info("Daemon stopped")


if __name__ == '__main__':
    main()
