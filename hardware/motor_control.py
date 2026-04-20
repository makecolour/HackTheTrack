#!/usr/bin/env python3
"""
Motor Control — Dual continuous-rotation servos on GPIO 12 & 13.

PWM: 50 Hz (20 ms period)
Neutral: 1500 µs, Drive: ±300 µs, Turn: ±200 µs
Left servo is mirror-mounted: actual = 3000 - pulse_us
"""
import logging
import os
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


def _read_int_env(names, default):
    for name in names:
        raw = os.getenv(name)
        if raw is None or raw == '':
            continue
        try:
            return int(raw)
        except ValueError:
            logger.warning("Invalid %s=%r, using %s", name, raw, default)
            return default
    return default


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
        cfg_diff = cfg.get('servo_diff_us', cfg.get('servo_diff', 0))
        self.servo_diff_us = _read_int_env(['SERVO_DIFF', 'MOTOR_SERVO_DIFF_US'], cfg_diff)
        self.status = 'idle'
        self._h = None
        self._init_gpio()

    def _init_gpio(self):
        try:
            self._h = gpio_open()
            lgpio.gpio_claim_output(self._h, self.left_pin)
            lgpio.gpio_claim_output(self._h, self.right_pin)
            logger.info(
                f"Servo motor ready: L=GPIO{self.left_pin}, R=GPIO{self.right_pin}, "
                f"servo_diff_us={self.servo_diff_us}"
            )
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

    def _offset_magnitude(self, pulse_us, offset_us):
        if pulse_us == STOP_VAL or offset_us == 0:
            return pulse_us
        delta = pulse_us - STOP_VAL
        sign = 1 if delta > 0 else -1
        magnitude = max(0, abs(delta) + int(round(offset_us)))
        adjusted = STOP_VAL + sign * magnitude
        return max(1000, min(2000, adjusted))

    def _drive(self, left_us, right_us):
        # Apply a signed left-right trim around neutral for servo calibration.
        half_diff = self.servo_diff_us / 2.0
        left_us = self._offset_magnitude(left_us, half_diff)
        right_us = self._offset_magnitude(right_us, -half_diff)
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
        return {'driver': 'lgpio', 'status': self.status, 'servo_diff_us': self.servo_diff_us}


def create_motor(config):
    if GPIO_AVAILABLE:
        try:
            return ServoMotor(config)
        except Exception as e:
            logger.warning(f"Real motor failed, using mock: {e}")
    return MockMotor()
