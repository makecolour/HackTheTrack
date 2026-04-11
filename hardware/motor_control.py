#!/usr/bin/env python3
"""
Motor Control — Dual continuous-rotation servos on GPIO 12 & 13.

PWM: 50 Hz (20 ms period)
Neutral: 1500 µs, Drive: ±300 µs, Turn: ±200 µs
Left servo is mirror-mounted: actual = 3000 - pulse_us
"""
import logging
import time

logger = logging.getLogger('motor_control')

try:
    import lgpio
    from gpio_handle import gpio_open
    GPIO_AVAILABLE = True
except ImportError:
    GPIO_AVAILABLE = False

LEFT_PIN = 12
RIGHT_PIN = 13
PWM_FREQ = 50
STOP_VAL = 1500
DRIVE_SPEED = 300
TURN_SPEED = 200


class MockMotor:
    def __init__(self):
        self.status = 'idle'
        logger.info("MockMotor initialized (no hardware)")

    def forward(self, speed=50):  self.status = 'forward'
    def backward(self, speed=50): self.status = 'backward'
    def turn_left(self, speed=50): self.status = 'turning_left'
    def turn_right(self, speed=50): self.status = 'turning_right'
    def stop(self):               self.status = 'idle'
    def cleanup(self):            pass
    def get_status(self):         return {'driver': 'mock', 'status': self.status}


class ServoMotor:
    def __init__(self, config):
        cfg = config.get('motor', {})
        self.left_pin = cfg.get('left_pin', LEFT_PIN)
        self.right_pin = cfg.get('right_pin', RIGHT_PIN)
        self.drive_speed = cfg.get('drive_speed', DRIVE_SPEED)
        self.turn_speed = cfg.get('turn_speed', TURN_SPEED)
        self.status = 'idle'
        self._h = None
        self._init_gpio()

    def _init_gpio(self):
        try:
            self._h = gpio_open()
            lgpio.gpio_claim_output(self._h, self.left_pin)
            lgpio.gpio_claim_output(self._h, self.right_pin)
            logger.info(f"Servo motor ready: L=GPIO{self.left_pin}, R=GPIO{self.right_pin}")
        except Exception as e:
            logger.error(f"GPIO init failed: {e}")
            self._h = None

    def _set_pwm(self, pin, pulse_us):
        if self._h is None:
            return
        try:
            if pulse_us == 0:
                lgpio.tx_pwm(self._h, pin, 0, 0)
            else:
                duty = (pulse_us / 20000.0) * 100.0
                lgpio.tx_pwm(self._h, pin, PWM_FREQ, duty)
        except Exception as e:
            logger.error(f"PWM error pin {pin}: {e}")

    def _drive(self, left_us, right_us):
        # Left servo mirror-mounted: invert
        self._set_pwm(self.left_pin, 3000 - left_us)
        self._set_pwm(self.right_pin, right_us)

    def forward(self, speed=50):
        self.status = 'forward'
        self._drive(STOP_VAL + self.drive_speed, STOP_VAL + self.drive_speed)

    def backward(self, speed=50):
        self.status = 'backward'
        self._drive(STOP_VAL - self.drive_speed, STOP_VAL - self.drive_speed)

    def turn_left(self, speed=50):
        self.status = 'turning_left'
        self._drive(STOP_VAL + self.turn_speed, STOP_VAL - self.turn_speed)

    def turn_right(self, speed=50):
        self.status = 'turning_right'
        self._drive(STOP_VAL - self.turn_speed, STOP_VAL + self.turn_speed)

    def stop(self):
        self.status = 'idle'
        self._set_pwm(self.left_pin, 0)
        self._set_pwm(self.right_pin, 0)

    def cleanup(self):
        self.stop()

    def get_status(self):
        return {'driver': 'lgpio', 'status': self.status}


def create_motor(config):
    if GPIO_AVAILABLE:
        try:
            return ServoMotor(config)
        except Exception as e:
            logger.warning(f"Real motor failed, using mock: {e}")
    return MockMotor()
