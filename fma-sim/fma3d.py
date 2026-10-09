import math
import os
import numpy as np
import mujoco

from fma_model import write_ramp_obj, WHEEL_R, WHEEL_F_X, WHEEL_R_X, WHEEL_Z, CG_Z

DIR = os.path.dirname(os.path.abspath(__file__))

MASS_TOTAL = 0.125
I_ROLL = 1.5e-4
I_PITCH = 2.0e-4
I_YAW = 1.7e-4
WALL_Y_INNER = 0.0565
ROLLER_R = 0.009
ROLLER_Y = 0.048
ROLLER_X_F = 0.055
ROLLER_X_R = -0.055
ROLLER_Z_LOW = -0.004
ROLLER_Z_UP = 0.022
NOSE_X = 0.060
TAIL_X = -0.060
BODY_Z = -0.003
BODY_HZ = 0.007


def roller(name, x, z, side):
    y = side * ROLLER_Y
    return f"""
    <body name="{name}" pos="{x} {y} {z}">
      <joint name="{name}_spin" type="hinge" axis="0 1 0" damping="0.0002"/>
      <geom name="{name}" type="cylinder" size="0.0045 {ROLLER_R}" euler="1.5708 0 0" mass="0.001" friction="0.3 0.005 0.0001"/>
    </body>"""


def damper_xml(kind):
    mount = 0.016
    travel = -0.020
    if kind == "none":
        return "", 0.0
    if kind == "separate":
        bodies = ""
        for i, s in enumerate((1, -1)):
            bodies += f"""
    <body name="damper{i}" pos="-0.045 {s * 0.009} {mount}">
      <joint name="damper{i}_slide" type="slide" axis="0 0 1" range="{travel} 0" damping="0.001"/>
      <geom name="damper{i}_g" type="cylinder" size="0.004 0.0015" mass="0.0047" friction="0.1 0.005 0.0001"/>
    </body>"""
        return bodies, 0.0094
    bodies = f"""
    <body name="damperL" pos="-0.045 0 {mount}">
      <joint name="damperL_slide" type="slide" axis="0 0 1" range="{travel} 0" damping="0.001"/>
      <geom name="damperL_g" type="box" size="0.005 0.013 0.0015" mass="0.0094" friction="0.1 0.005 0.0001"/>
    </body>"""
    return bodies, 0.0094


def build3d(dampers="separate", mesh_path=None):
    mesh_path = mesh_path or os.path.join(DIR, "ramp_10310.obj")
    damper_bodies, dm = damper_xml(dampers)
    chassis_mass = MASS_TOTAL - 0.006 - 0.008 - dm
    rollers = "".join([
        roller("frUL", ROLLER_X_F, ROLLER_Z_UP, 1), roller("frUR", ROLLER_X_F, ROLLER_Z_UP, -1),
        roller("frLL", ROLLER_X_F, ROLLER_Z_LOW, 1), roller("frLR", ROLLER_X_F, ROLLER_Z_LOW, -1),
        roller("reUL", ROLLER_X_R, ROLLER_Z_UP, 1), roller("reUR", ROLLER_X_R, ROLLER_Z_UP, -1),
        roller("reLL", ROLLER_X_R, ROLLER_Z_LOW, 1), roller("reLR", ROLLER_X_R, ROLLER_Z_LOW, -1),
    ])
    wallX = 0.75
    return f"""
<mujoco model="fma3d">
  <option timestep="0.0001" gravity="0 0 -9.81" integrator="implicitfast"/>
  <default>
    <geom solref="0.008 1" solimp="0.9 0.95 0.001"/>
  </default>
  <asset>
    <mesh name="ramp10310" file="{mesh_path}"/>
  </asset>
  <worldbody>
    <geom name="floor" type="plane" size="6 1 0.1" friction="0.04 0.005 0.0001"/>
    <geom name="ramp" type="mesh" mesh="ramp10310" friction="0.04 0.005 0.0001"/>
    <geom name="wallL" type="box" pos="{wallX} {WALL_Y_INNER + 0.003} 0.05" size="3.0 0.003 0.05" mass="0" friction="0.3 0.005 0.0001"/>
    <geom name="wallR" type="box" pos="{wallX} -{WALL_Y_INNER + 0.003} 0.05" size="3.0 0.003 0.05" mass="0" friction="0.3 0.005 0.0001"/>
    <body name="chassis" pos="-0.60 0 {CG_Z}">
      <freejoint name="root"/>
      <inertial pos="0 0 0" mass="{chassis_mass}" diaginertia="{I_ROLL} {I_PITCH} {I_YAW}"/>
      <geom name="body" type="box" pos="0 0 {BODY_Z}" size="{NOSE_X} 0.025 {BODY_HZ}" mass="0" friction="0.3 0.005 0.0001"/>
      <geom name="brake" type="box" pos="-0.048 0 -0.011" size="0.008 0.010 0.001" mass="0" friction="0.5 0.005 0.0001" solref="0.015 1"/>
      <site name="siteF" pos="{WHEEL_F_X} 0 {WHEEL_Z}" size="0.002"/>
      <site name="siteR" pos="{WHEEL_R_X} 0 {WHEEL_Z}" size="0.002"/>
      <body name="wheelF_b" pos="{WHEEL_F_X} 0 {WHEEL_Z}">
        <joint name="wheelF_spin" type="hinge" axis="0 1 0" damping="0.0001"/>
        <geom name="wheelF" type="cylinder" pos="0 0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
        <geom name="wheelF2" type="cylinder" pos="0 -0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
      </body>
      <body name="wheelR_b" pos="{WHEEL_R_X} 0 {WHEEL_Z}">
        <joint name="wheelR_spin" type="hinge" axis="0 1 0" damping="0.0001"/>
        <geom name="wheelR" type="cylinder" pos="0 0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
        <geom name="wheelR2" type="cylinder" pos="0 -0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
      </body>{rollers}{damper_bodies}
    </body>
  </worldbody>
</mujoco>
"""


def euler_from_quat(q):
    w, x, y, z = q
    R00 = 1 - 2 * (y * y + z * z)
    R10 = 2 * (x * y + w * z)
    R20 = 2 * (x * z - w * y)
    R21 = 2 * (y * z + w * x)
    R22 = 1 - 2 * (x * x + y * y)
    pitch = math.asin(max(-1, min(1, -R20)))
    roll = math.atan2(R21, R22)
    yaw = math.atan2(R10, R00)
    return roll, pitch, yaw


class Sim3:
    def __init__(self, dampers="separate", spring_k=0.0, spring_preload=0.004, v0=4.2, yaw0=0.0, mesh_path=None):
        self.m = mujoco.MjModel.from_xml_string(build3d(dampers, mesh_path))
        self.d = mujoco.MjData(self.m)
        self.v0 = v0
        self.spring_k = spring_k
        damper_joints = [i for i in range(self.m.njnt)
                         if mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_JOINT, i).startswith("damper")]
        self.dofs = [self.m.jnt_dofadr[j] for j in damper_joints]
        self.qadrs = [self.m.jnt_qposadr[j] for j in damper_joints]
        self.dm_each = 0.0094 / max(1, len(damper_joints))
        self.spring_qfree = None
        if spring_k > 0 and damper_joints:
            j0 = damper_joints[0]
            travel = -self.m.jnt_range[j0][0]
            self.spring_qfree = -(travel - spring_preload) - self.dm_each * 9.81 / spring_k
        for qa in self.qadrs:
            if spring_k > 0:
                self.d.qpos[qa] = self.spring_qfree - self.dm_each * 9.81 / spring_k
            else:
                j = damper_joints[self.qadrs.index(qa)]
                self.d.qpos[qa] = self.m.jnt_range[j][0]
        self.settle()
        self.launch(yaw0)

    def settle(self):
        for _ in range(1500):
            self.apply_damper_forces()
            mujoco.mj_step(self.m, self.d)

    def launch(self, yaw0):
        d, m = self.d, self.m
        d.qvel[:] = 0.0
        half = 0.5 * yaw0
        d.qpos[3:7] = [math.cos(half), 0, 0, math.sin(half)]
        if yaw0 != 0.0:
            sy, cy = math.sin(yaw0), math.cos(yaw0)
            extent = max(rx * sy + s * ROLLER_Y * cy for rx, s in
                         [(ROLLER_X_F, 1), (ROLLER_X_F, -1), (ROLLER_X_R, 1), (ROLLER_X_R, -1)]) + 0.0045
            clearance = WALL_Y_INNER - 0.002
            shift = min(sy * 0.45, 0.030)
            right_extent = -min(rx * sy + s * ROLLER_Y * cy for rx, s in
                                [(ROLLER_X_F, 1), (ROLLER_X_F, -1), (ROLLER_X_R, 1), (ROLLER_X_R, -1)]) + 0.0045
            max_shift = WALL_Y_INNER - 0.002 - right_extent
            d.qpos[1] -= min(shift, max(0, max_shift))
        d.qvel[0] = self.v0 * math.cos(yaw0)
        d.qvel[1] = self.v0 * math.sin(yaw0)
        for wn in ("wheelF_spin", "wheelR_spin"):
            j = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, wn)
            if j >= 0:
                d.qvel[m.jnt_dofadr[j]] = self.v0 / WHEEL_R

    def apply_damper_forces(self):
        if self.spring_k <= 0:
            return
        d = self.d
        for dof, qa in zip(self.dofs, self.qadrs):
            q = d.qpos[qa]
            qd = d.qvel[dof]
            f = 0.0
            if q < self.spring_qfree:
                f = self.spring_k * (self.spring_qfree - q)
            d.qfrc_applied[dof] = max(f, 0.0)

    def wall_force(self):
        total = 0.0
        for i in range(self.d.ncon):
            c = self.d.contact[i]
            names = [mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_GEOM, c.geom1),
                     mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_GEOM, c.geom2)]
            if "wallL" in names or "wallR" in names:
                buf = np.zeros(6)
                mujoco.mj_contactForce(self.m, self.d, i, buf)
                total += abs(buf[0])
        return total

    def run(self, t_end=1.5, log_every=10):
        m, d = self.m, self.d
        log = {k: [] for k in ("t", "x", "y", "z", "roll", "pitch", "yaw", "vy", "wallF", "con")}
        wall_imp = 0.0
        dt = m.opt.timestep
        for step in range(int(t_end / m.opt.timestep)):
            self.apply_damper_forces()
            mujoco.mj_step(m, d)
            wall_imp += self.wall_force() * dt
            if step % log_every == 0:
                roll, pitch, yaw = euler_from_quat(d.qpos[3:7])
                log["t"].append(d.time)
                log["x"].append(d.qpos[0])
                log["y"].append(d.qpos[1])
                log["z"].append(d.qpos[2])
                log["roll"].append(roll)
                log["pitch"].append(pitch)
                log["yaw"].append(yaw)
                log["vy"].append(d.qvel[1])
                log["wallF"].append(self.wall_force())
                log["con"].append(d.ncon > 0)
        log["wall_impulse"] = wall_imp
        for k in log:
            if k != "wall_impulse":
                log[k] = np.array(log[k])
        return log


def outcome(log):
    roll = np.unwrap(log["roll"])
    pitch = np.unwrap(log["pitch"])
    yaw = np.unwrap(log["yaw"])
    wall_total = log["wall_impulse"]
    end_ok = abs(np.degrees(roll[-1])) < 15 and abs(np.degrees(pitch[-1])) < 15 and log["con"][-1]
    flipped = np.max(np.abs(np.degrees(roll))) > 100 or np.max(np.abs(np.degrees(pitch))) > 100
    wild = (not flipped) and (np.max(np.abs(np.degrees(roll))) > 40 or np.max(np.abs(np.degrees(pitch))) > 40)
    if flipped:
        cls = "CRASH"
    elif np.max(np.abs(log["y"])) > WALL_Y_INNER + 0.004:
        cls = "OUT"
    elif wild:
        cls = "UGLY"
    elif end_ok and abs(np.degrees(yaw[-1])) < 15:
        cls = "CLEAN"
    elif end_ok:
        cls = "SKEWED"
    else:
        cls = "UGLY"
    return {
        "class": cls,
        "max_roll_deg": np.max(np.abs(np.degrees(roll))),
        "max_pitch_deg": np.max(np.abs(np.degrees(pitch))),
        "end_yaw_deg": np.degrees(yaw[-1]),
        "wall_impulse_Ns": wall_total,
        "max_yswing_mm": np.max(np.abs(log["y"])) * 1000,
    }
