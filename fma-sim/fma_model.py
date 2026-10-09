import math
import os
import numpy as np
import mujoco

DIR = os.path.dirname(os.path.abspath(__file__))

RAMP_HALF_LEN = 0.085
RAMP_HEIGHT = 0.020
RAMP_WIDTH = 0.110
RAMP_FLAT = 0.60

WHEEL_R = 0.0125
WHEEL_F_X = 0.040
WHEEL_R_X = -0.043
WHEEL_Z = -0.0025
CG_Z = 0.015
NOSE_X = 0.060
TAIL_X = -0.060
BODY_Z = -0.003
BODY_HZ = 0.007

MASS_TOTAL = 0.125
I_PITCH = 2.0e-4


def write_ramp_obj(path=None, dx=0.002, dy=0.02, profile_k=1.5):
    path = path or os.path.join(DIR, "ramp_10310.obj")
    xs = np.arange(-RAMP_HALF_LEN, RAMP_HALF_LEN + 1e-9, dx)
    ys = np.arange(-RAMP_WIDTH / 2, RAMP_WIDTH / 2 + 1e-9, dy)
    verts = []
    for y in ys:
        for x in xs:
            u = max(0.0, 1 - (x / RAMP_HALF_LEN) ** 2)
            z = RAMP_HEIGHT * u ** profile_k
            verts.append((x, y, z))
    for y in ys:
        verts.append((-RAMP_HALF_LEN, y, -0.01))
        verts.append((RAMP_HALF_LEN, y, -0.01))
    faces = []
    nx, ny = len(xs), len(ys)
    for j in range(ny - 1):
        for i in range(nx - 1):
            a = j * nx + i + 1
            b = a + 1
            c = a + nx
            d = c + 1
            faces.append((a, c, d))
            faces.append((a, d, b))
    with open(path, "w") as f:
        for v in verts:
            f.write(f"v {v[0]:.5f} {v[1]:.5f} {v[2]:.6f}\n")
        for t in faces:
            f.write(f"f {t[0]} {t[1]} {t[2]}\n")
    return path


def brake_pos(brake_clearance, brake_x):
    return (brake_x, 0.0, -(CG_Z - brake_clearance - 0.001))


def build_xml(
    brake_clearance=0.002,
    brake_x=WHEEL_R_X,
    brake_mu=0.5,
    brake_solref=0.01,
    damper_mass=0.0094,
    damper_travel=0.020,
    damper_x=-0.045,
    damper_z=0.016,
    front_damper=False,
    chassis_mass=None,
    i_pitch=I_PITCH,
    v0=5.5,
    x0=-0.30,
    mesh_path=None,
    cg_back=0.0,
    cg_drop=0.0,
    nose_skid=False,
    front_brake=False,
):
    mesh_path = mesh_path or os.path.join(DIR, "ramp_10310.obj")
    chassis_mass = chassis_mass or (MASS_TOTAL - damper_mass - 0.006)
    skid = ""
    if nose_skid:
        skid = '<geom name="skid" type="box" pos="0.050 0 -0.0115" size="0.012 0.020 0.0015" mass="0" friction="0.15 0.005 0.0001"/>'
    fb = ""
    if front_brake:
        fb = '<geom name="fbrake" type="box" pos="0.054 0 -0.009" size="0.012 0.020 0.001" euler="0 -0.26 0" mass="0" friction="0.5 0.005 0.0001" solref="0.015 1"/>'
    bx, by, bz = brake_pos(brake_clearance, brake_x)
    dx_str = (
        f'{"{:.4f}".format(damper_x)}'
    )
    fd = ""
    if front_damper:
        fd = f"""
    <body name="damperF" pos="0.045 0 {damper_z}">
      <joint name="damperF_slide" type="slide" axis="0 0 1" range="{-damper_travel} 0" damping="0.001"/>
      <geom name="damperF_geom" type="cylinder" size="0.004 0.0015" mass="{damper_mass}" friction="0.05 0.005 0.0001"/>
    </body>"""
    return f"""
<mujoco model="fma_10310">
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
    <site name="ramp_start" pos="{-RAMP_HALF_LEN} 0 0" size="0.003"/>
    <site name="ramp_end" pos="{RAMP_HALF_LEN} 0 0" size="0.003"/>
    <body name="chassis" pos="{x0} 0 {CG_Z}">
      <freejoint name="root"/>
      <inertial pos="{-cg_back} 0 {-cg_drop}" mass="{chassis_mass}" diaginertia="1.5e-4 {i_pitch} 1.5e-4"/>
      <geom name="body" type="box" pos="0 0 {BODY_Z}" size="{NOSE_X} 0.03 {BODY_HZ}" mass="0" friction="0.3 0.005 0.0001"/>
      <body name="wheelF_b" pos="{WHEEL_F_X} 0 {WHEEL_Z}">
        <joint name="wheelF_spin" type="hinge" axis="0 1 0" damping="0.0001"/>
        <geom name="wheelF" type="cylinder" pos="0 0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
        <geom name="wheelF2" type="cylinder" pos="0 -0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
      </body>
      <body name="wheelR_b" pos="{WHEEL_R_X} 0 {WHEEL_Z}">
        <joint name="wheelR_spin" type="hinge" axis="0 1 0" damping="0.0001"/>
        <geom name="wheelR" type="cylinder" pos="0 0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
        <geom name="wheelR2" type="cylinder" pos="0 -0.018 0" size="0.0035 {WHEEL_R}" euler="1.5708 0 0" mass="0.003" friction="0.6 0.005 0.0001"/>
      </body>
      <geom name="brake" type="box" pos="{bx} {by} {bz}" size="0.008 0.010 0.001" mass="0" friction="{brake_mu} 0.005 0.0001" solref="{brake_solref} 1"/>
      <site name="siteF" pos="{WHEEL_F_X} 0 {WHEEL_Z}" size="0.002"/>
      <site name="siteR" pos="{WHEEL_R_X} 0 {WHEEL_Z}" size="0.002"/>
      <site name="siteBrake" pos="{bx} {by} {bz - 0.001}" size="0.002"/>{skid}{fb}
      <body name="damperR" pos="{damper_x} 0 {damper_z}">
        <joint name="damperR_slide" type="slide" axis="0 0 1" range="{-damper_travel} 0" damping="0.001"/>
        <geom name="damperR_geom" type="cylinder" size="0.004 0.0015" mass="{damper_mass}" friction="0.05 0.005 0.0001"/>
      </body>{fd}
    </body>
  </worldbody>
</mujoco>
"""


class Sim:
    def __init__(self, xml, spring_k=0.0, spring_preload=0.004, spring_damping=0.0, damper_mass=0.0094, v0=5.5):
        self.m = mujoco.MjModel.from_xml_string(xml)
        self.d = mujoco.MjData(self.m)
        self.gid = {mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_GEOM, i): i for i in range(self.m.ngeom)}
        self.sid = {mujoco.mj_id2name(self.m, mujoco.mjtObj.mjOBJ_SITE, i): i for i in range(self.m.nsite)}
        jid = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_JOINT, "damperR_slide")
        self.dof_damper = self.m.jnt_dofadr[jid]
        self.qadr_damper = self.m.jnt_qposadr[jid]
        self.spring_k = spring_k
        self.spring_damping = spring_damping
        self.spring_qfree = None
        if spring_k > 0:
            travel = -self.m.jnt_range[jid][0]
            self.spring_qfree = -(travel - spring_preload) - damper_mass * 9.81 / spring_k
            self.d.qpos[self.qadr_damper] = self.spring_qfree - damper_mass * 9.81 / spring_k
        else:
            self.d.qpos[self.qadr_damper] = self.m.jnt_range[jid][0]
        self.d.qvel[0] = 0.0
        for _ in range(1500):
            self.d.qfrc_applied[self.dof_damper] = self.damper_force()
            mujoco.mj_step(self.m, self.d)
        self.d.qvel[:] = 0.0
        self.d.qvel[0] = v0
        for wn in ("wheelF_spin", "wheelR_spin"):
            j = mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_JOINT, wn)
            if j >= 0:
                self.d.qvel[self.m.jnt_dofadr[j]] = v0 / WHEEL_R

    def damper_force(self):
        if self.spring_k <= 0:
            return 0.0
        q = self.d.qpos[self.m.jnt_qposadr[mujoco.mj_name2id(self.m, mujoco.mjtObj.mjOBJ_JOINT, "damperR_slide")]]
        qd = self.d.qvel[self.dof_damper]
        f = 0.0
        if q < self.spring_qfree:
            f = self.spring_k * (self.spring_qfree - q) - self.spring_damping * qd
        return max(f, 0.0)

    def contact_force(self, geom_name):
        total = 0.0
        for i in range(self.d.ncon):
            c = self.d.contact[i]
            if self.gid[geom_name] in (c.geom1, c.geom2):
                buf = np.zeros(6)
                mujoco.mj_contactForce(self.m, self.d, i, buf)
                total += buf[0]
        return total

    def any_contact(self):
        ids = {self.gid[n] for n in ("wheelF", "wheelR", "body", "brake")}
        for i in range(self.d.ncon):
            c = self.d.contact[i]
            if c.geom1 in ids or c.geom2 in ids:
                return True
        return False

    def pitch(self):
        f = self.d.site_xpos[self.sid["siteF"]]
        r = self.d.site_xpos[self.sid["siteR"]]
        return math.atan2(f[2] - r[2], f[0] - r[0])

    def run(self, t_end=1.2, log_every=10):
        mujoco.mj_forward(self.m, self.d)
        log = {"t": [], "x": [], "z": [], "pitch": [], "pitch_rate": [], "v": [], "brakeN": [], "contact": [], "damper_q": []}
        n = int(t_end / self.m.opt.timestep)
        prev_pitch = self.pitch()
        for step in range(n):
            self.d.qfrc_applied[self.dof_damper] = self.damper_force()
            mujoco.mj_step(self.m, self.d)
            if step % log_every == 0:
                p = self.pitch()
                dt = self.m.opt.timestep * log_every
                log["t"].append(self.d.time)
                log["x"].append(self.d.qpos[0])
                log["z"].append(self.d.qpos[2])
                log["pitch"].append(p)
                log["pitch_rate"].append((p - prev_pitch) / dt)
                prev_pitch = p
                log["v"].append(self.d.qvel[0])
                log["brakeN"].append(self.contact_force("brake"))
                log["contact"].append(self.any_contact())
                log["damper_q"].append(self.d.qpos[self.qadr_damper])
        for k in log:
            log[k] = np.array(log[k])
        return log


def summarize(log, ramp_zone=(-0.12, 0.12)):
    t = log["t"]
    pitch = np.unwrap(log["pitch"])
    rate = log["pitch_rate"]
    in_zone = (log["x"] > ramp_zone[0]) & (log["x"] < ramp_zone[1])
    last_contact_idx = np.max(np.where(log["contact"] & in_zone)) if np.any(log["contact"] & in_zone) else 0
    takeoff_rate = rate[last_contact_idx]
    flight = log["x"] > log["x"][last_contact_idx]
    min_pitch = np.min(pitch[in_zone]) if np.any(in_zone) else 0
    max_n = np.max(log["brakeN"])
    flipped = np.max(np.abs(pitch)) > math.radians(90)
    landed_ok = (not flipped) and np.abs(pitch[-1]) < math.radians(10) and log["contact"][-1]
    return {
        "takeoff_pitch_rate_rad_s": takeoff_rate,
        "takeoff_pitch_deg": math.degrees(pitch[last_contact_idx]),
        "min_pitch_deg": math.degrees(min_pitch),
        "max_abs_pitch_deg": math.degrees(np.max(np.abs(pitch))),
        "max_brake_N": max_n,
        "flipped": bool(flipped),
        "settled_flat": bool(landed_ok),
        "end_x_m": log["x"][-1],
        "end_pitch_deg": math.degrees(pitch[-1]),
    }
