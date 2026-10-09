"""FM-A Mini 4WD jump-ramp simulator (MuJoCo) — FastAPI server.
Reconstructed after source loss; core geometry exact (owner-measured this session),
roller/body constants flagged RECONSTRUCTED where recovered approximately.
Hard-point-first assembly UX (owner spec): rear upper/lower hard points, front/side
scaffolded; upper stay -> roller + damper options; lower stay -> sponge or 15458."""
import math
import os

import mujoco
import numpy as np
from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel

DIR = os.path.dirname(os.path.abspath(__file__))
app = FastAPI()

# ==== chassis (verified published + owner data; FM-A split/cg owner-verified) ====
CHASSIS = {
    "FM-A": dict(wb=0.083, split=0.52, mass=0.117, cg_h=0.015, track=0.066),
    "AR": dict(wb=0.082, split=0.46, mass=0.1233, cg_h=0.014, track=0.066),
    "Super-XX": dict(wb=0.084, split=0.46, mass=0.119, cg_h=0.0145, track=0.066),
    "VZ": dict(wb=0.080, split=0.46, mass=0.118, cg_h=0.0135, track=0.066),
}
BODIES = {  # RECONSTRUCTED approx: shell mass / cg raise
    "none": dict(dm=0.0, dcg=0.0),
    "Avante": dict(dm=0.012, dcg=0.0025),
    "Brocken Gigant": dict(dm=0.007, dcg=0.0015),
    "Max Breaker": dict(dm=0.006, dcg=0.001),
}

GEAR = 4.2  # 4.2:1 gear set — owner: confirm
# launch speed from LOAD rpm (motorlab-tw: Tamiya load-rpm; ~5% sag folded in)
LOAD_FACTOR = 0.95
MOTOR_SPECS = {
    "Stock/Jr": (11700, 14000, 1.5, 1.9),
    "Torque-Tuned 2": (12300, 14700, 1.6, 2.0),
    "Light Dash": (14600, 17800, 1.3, 1.9),
    "Hyper Dash 3": (17200, 21200, 1.4, 1.9),
    "Sprint Dash": (20700, 27200, 1.3, 1.8),
    "custom": (14600, 17800, 1.3, 1.9),
}


def _v(lo, hi):
    return round((lo + hi) / 2 / 60 / GEAR * math.pi * 0.026 * LOAD_FACTOR, 2)


MOTORS = {
    "Stock/Jr": _v(11700, 14000),        # 3.96
    "Torque-Tuned 2": _v(12300, 14700),  # 4.16
    "Light Dash": _v(14600, 17800),      # 4.99
    "Hyper Dash 3": _v(17200, 21200),    # 5.91
    "Sprint Dash": _v(20700, 27200),     # 7.34
}

# ==== owner-measured mount geometry (mm above ground) ====
MOUNT = {
    "FM-A": dict(low=0.007, high=0.019),      # MEASURED
    "AR": dict(low=0.005, high=0.019),        # MEASURED
    "Super-XX": dict(low=0.006, high=0.019),  # PLACEHOLDER
    "VZ": dict(low=0.006, high=0.019),        # PLACEHOLDER
}
BAR15458 = dict(clear=0.0025, dx_behind_hp=0.020)  # MEASURED (FM-A)
FRONT_15451 = {
    "FM-A": (0.0105, 0.0125),   # MEASURED (front, back edge)
    "AR": (0.0120, 0.0125),     # MEASURED (owner flagged small)
    "Super-XX": (0.0110, 0.0125),  # PLACEHOLDER
    "VZ": (0.0110, 0.0125),        # PLACEHOLDER
}
HP = {
    "setback_mm": 18.0,       # hardpoints behind rear axle — PLACEHOLDER (measure!)
    "halfw_15452_mm": 25.0,
    "halfw_15550_mm": 10.0,
    "bar_halfw_mm": 25.0,
    "front_len_mm": 30.0,     # 15451 contact length — PLACEHOLDER
    "front_ahead_mm": 14.0,   # 15451 front edge ahead of front axle — PLACEHOLDER
}
SPONGES = {  # (thickness m, mu, solref) — friction guesses pending calibration
    "sponge2_hard": dict(thick=0.002, mu=0.5, solref=0.015),
    "sponge2_soft": dict(thick=0.002, mu=0.8, solref=0.020),
    "sponge3_hard": dict(thick=0.003, mu=0.5, solref=0.015),
    "sponge3_soft": dict(thick=0.003, mu=0.8, solref=0.020),
}
BAR_MASS = 0.002       # PLACEHOLDER
SPONGE_MASS = 0.0005
STAY_PHYS = {  # masses + fin heights PLACEHOLDER (weigh/measure when convenient)
    "15452": dict(mass_kg=0.0030, height_mm=25.0),
    "15550": dict(mass_kg=0.0015, height_mm=22.0),
}
DAMPERS = {
    "none": dict(kind="none"),
    "separate": dict(kind="separate"),
    "linked": dict(kind="linked"),
}

WHEEL_R = 0.013            # 26mm wheels — confirm owner wheel type
ROLLER_R = 0.011           # RECONSTRUCTED approx (roller half-length)
ROLLER_Y = 0.048           # RECONSTRUCTED approx
ROLLER_Z_LOW_W = 0.014     # RECONSTRUCTED approx
ROLLER_Z_UP_W = 0.037      # RECONSTRUCTED approx
BODY_L = 0.124             # RECONSTRUCTED approx
BODY_W = 0.050
WALL_Y_INNER = 0.058       # ~116mm lane
RAMP_OBJ = os.path.join(DIR, "ramp_parabola.obj")
RAMP_H = 0.020
RAMP_HALF = 0.090
RAMP_P = 1.709


def attachment_brakes(p):
    """Brake geoms from hard-point assembly. rear_upper = screws from top side
    (plate bottom at MOUNT high); rear_lower = underside (MOUNT low). Sponge may
    mount on either stay; the 15458 crossbar mounts on the LOWER stay only,
    bare or with its own sponge."""
    geoms = []
    for slot, part in (("upper", p.rear_upper), ("lower", p.rear_lower)):
        if part == "off":
            continue
        base = MOUNT[p.chassis]["high" if slot == "upper" else "low"]
        clear, mu, solref = base, 0.3, 0.020
        halfw, extra_m, dx_back = HP[f"halfw_{part}_mm"] / 1000.0, 0.0, 0.0
        attach = p.rear_attach_upper if slot == "upper" else p.rear_attach_lower
        if attach == "sponge":
            sf = SPONGES[p.sponge]
            clear, mu, solref = base - sf["thick"], sf["mu"], sf["solref"]
            extra_m = SPONGE_MASS
        elif attach == "15458" and slot == "lower":
            halfw = HP["bar_halfw_mm"] / 1000.0
            extra_m = BAR_MASS
            dx_back = BAR15458["dx_behind_hp"]
            if p.bar_mode == "bare":
                clear = BAR15458["clear"]
            else:
                sf = SPONGES[p.sponge]
                clear = max(0.0003, BAR15458["clear"] - sf["thick"])
                mu, solref = sf["mu"], sf["solref"]
                extra_m += SPONGE_MASS
        geoms.append(dict(name=f"brake_{part}_{slot}", clearance=max(0.0003, clear),
                          mu=mu, solref=solref, halfw=halfw,
                          extra_mass_kg=extra_m, dx_back=dx_back, slot=slot, part=part))
    return geoms


def build(p):
    ch = dict(CHASSIS[p.chassis])
    track_half = ch["track"] / 2.0
    bd = BODIES[p.body]
    dm_cfg = DAMPERS.get(p.rear_upper_damper if p.rear_upper != "off" else "none",
                         DAMPERS["none"])
    total = ch["mass"] + bd["dm"]
    wb = ch["wb"]
    a = wb * ch["split"]
    b = wb * (1 - ch["split"])
    cg_h = ch["cg_h"] + bd["dcg"]
    fx, rx = a, -b
    wz = WHEEL_R - cg_h
    rlow = ROLLER_Z_LOW_W - cg_h
    rup = ROLLER_Z_UP_W - cg_h
    rxf = min(fx + 0.015, BODY_L / 2)
    rxr = max(rx - 0.015, -BODY_L / 2)
    dm_mass = 0.0094 if dm_cfg["kind"] != "none" else 0.0
    hp_x = rx - HP["setback_mm"] / 1000

    br_geoms = attachment_brakes(p)
    front_str = ""
    if p.att_15451:
        fh, bh = FRONT_15451[p.chassis]
        flen = HP["front_len_mm"] / 1000
        fx_c = fx + HP["front_ahead_mm"] / 1000 - flen / 2
        tilt = math.atan2(bh - fh, flen)  # lowers the front (+x) edge
        front_str = (f'<geom name="brake_15451F" type="box" pos="{fx_c:.5f} 0 '
                     f'{-(cg_h - (fh + bh) / 2):.6f}" euler="{tilt:.4f} 0 0" '
                     f'size="{flen/2:.4f} 0.020 0.001" mass="0" friction="0.1 0.005 0.0001"/>')
    stay_mass = 0.0
    stay_cgx = 0.0
    stay_rects = []
    for g in br_geoms:
        stay_mass += g["extra_mass_kg"]
        sp = STAY_PHYS.get(g["part"])
        if sp:
            stay_mass += sp["mass_kg"]
            stay_cgx += sp["mass_kg"] * hp_x
            zbot = -(cg_h - g["clearance"])
            stay_rects.append([hp_x - 0.008, zbot, hp_x + 0.008,
                               zbot + sp["height_mm"] / 1000])
            g["fin"] = True
    if front_str:
        fh, bh = FRONT_15451[p.chassis]
        flen = HP["front_len_mm"] / 1000
        fx_c = fx + HP["front_ahead_mm"] / 1000 - flen / 2
        stay_mass += 0.002
        stay_cgx += 0.002 * fx_c
        stay_rects.append([fx_c - flen / 2, -(cg_h - fh), fx_c + flen / 2,
                           -(cg_h - fh) + 0.006])
    stay_dx = stay_cgx / max(stay_mass, 1e-9) if stay_mass else 0.0
    brake_str = "".join(
        f'<geom name="{g["name"]}" type="box" pos="{hp_x - g["dx_back"]:.5f} 0 '
        f'{-(cg_h - g["clearance"] - 0.001):.6f}" size="0.008 {g["halfw"]:.4f} 0.001" '
        f'mass="0" friction="{g["mu"]} 0.005 0.0001" solref="{g["solref"]} 1"/>'
        for g in br_geoms)
    fin_str = "".join(
        f'<geom name="fin_{g["name"]}" type="box" pos="{r[0]+0.008:.5f} 0 {(r[1]+r[3])/2:.5f}" '
        f'size="0.008 0.010 {(r[3]-r[1])/2:.5f}" mass="0" friction="0.3 0.005 0.0001"/>'
        for g, r in zip(br_geoms, stay_rects) if g.get("fin"))

    total = total + stay_mass
    cg_shift = stay_dx * (stay_mass / max(total, 1e-9)) if stay_mass else 0.0
    chassis_mass = max(0.05, total - 0.006 - 0.008 - dm_mass - stay_mass)
    Ipitch = 0.00013 * (total / 0.125)

    def roller(name, x, z, s):
        return (f'<body name="{name}" pos="{x} {s * ROLLER_Y} {z}">'
                f'<joint name="{name}_spin" type="hinge" axis="0 1 0" damping="0.0"/>'
                f'<geom name="{name}" type="cylinder" size="0.0045 {ROLLER_R}" '
                f'euler="1.5708 0 0" mass="0.001" friction="0.01 0.005 0.0001"/></body>')

    rollers = "".join([
        roller("frUL", rxf, rup, 1), roller("frUR", rxf, rup, -1),
        roller("frLL", rxf, rlow, 1), roller("frLR", rxf, rlow, -1),
        roller("reUL", rxr, rup, 1), roller("reUR", rxr, rup, -1),
        roller("reLL", rxr, rlow, 1), roller("reLR", rxr, rlow, -1),
    ]) if p.rollers else ""
    stay_rollers = "".join([
        roller("stUL", hp_x, -(cg_h - MOUNT[p.chassis]["high"] - 0.006), 1),
        roller("stUR", hp_x, -(cg_h - MOUNT[p.chassis]["high"] - 0.006), -1),
    ]) if (p.rear_upper != "off" and p.rear_upper_roller) else ""

    if dm_cfg["kind"] == "separate":
        damper_bodies = "".join(
            f'<body name="damper{i}" pos="{rx - HP["setback_mm"]/1000} {s * 0.009} 0.016">'
            f'<joint name="damper{i}_slide" type="slide" axis="0 0 1" range="-0.020 0" damping="0.001"/>'
            f'<geom type="cylinder" size="0.004 0.0015" mass="0.0047" friction="0.1 0.005 0.0001"/></body>'
            for i, s in enumerate((1, -1)))
    elif dm_cfg["kind"] == "linked":
        damper_bodies = (f'<body name="damperL" pos="{rx - HP["setback_mm"]/1000} 0 0.016">'
                         f'<joint name="damperL_slide" type="slide" axis="0 0 1" range="-0.020 0" damping="0.001"/>'
                         f'<geom type="box" size="0.005 0.013 0.0015" mass="0.0094" friction="0.1 0.005 0.0001"/></body>')
    else:
        damper_bodies = ""

    walls = "" if not p.walls else f'''
    <geom name="wallL" type="box" pos="0.75 {WALL_Y_INNER + 0.003} 0.05" size="3.0 0.003 0.05" mass="0" friction="0.3 0.005 0.0001"/>
    <geom name="wallR" type="box" pos="0.75 -{WALL_Y_INNER + 0.003} 0.05" size="3.0 0.003 0.05" mass="0" friction="0.3 0.005 0.0001"/>'''

    return f'''
<mujoco model="viz">
  <option timestep="0.0001" gravity="0 0 -9.81" integrator="implicitfast"/>
  <default><geom solref="0.012 1" solimp="0.92 0.96 0.001"/></default>
  <asset><mesh name="ramp10310" file="{RAMP_OBJ}"/></asset>
  <worldbody>
    <geom name="floor" type="plane" size="20 4 0.1" friction="0.04 0.005 0.0001"/>
<geom name="ramp" type="mesh" mesh="ramp10310" friction="0.04 0.005 0.0001"/>{walls}
    <body name="chassis" pos="-0.60 0 {cg_h}">
      <freejoint name="root"/>
      <inertial pos="{cg_shift:.5f} 0 0" mass="{chassis_mass}" diaginertia="1.5e-4 {Ipitch} 1.7e-4"/>
      <geom name="body" type="box" pos="0 0 -0.0045" size="0.060 0.025 0.006" mass="0" friction="0.3 0.005 0.0001"/>
      {brake_str}{fin_str}{front_str}
      <site name="siteF" pos="{fx} 0 {wz}" size="0.002"/>
      <site name="siteR" pos="{rx} 0 {wz}" size="0.002"/>
      <body name="wheelF_b" pos="{fx} 0 {wz}">
        <joint name="wheelF_spin" type="hinge" axis="0 1 0" damping="0.0" armature="0.0001"/>
        <geom name="wheelF" type="capsule" fromto="0 -{track_half} 0 0 {track_half} 0" size="{WHEEL_R}" mass="0.006" friction="0.6 0.005 0.0001"/>
      </body>
      <body name="wheelR_b" pos="{rx} 0 {wz}">
        <joint name="wheelR_spin" type="hinge" axis="0 1 0" damping="0.0" armature="0.0001"/>
        <geom name="wheelR" type="capsule" fromto="0 -{track_half} 0 0 {track_half} 0" size="{WHEEL_R}" mass="0.006" friction="0.6 0.005 0.0001"/>
      </body>{rollers}{stay_rollers}{damper_bodies}
    </body>
  </worldbody>
</mujoco>''', stay_rects


def euler_from_quat(q):
    w, x, y, z = q
    R00 = 1 - 2 * (y * y + z * z)
    R10 = 2 * (x * y + w * z)
    R20 = 2 * (x * z - w * y)
    R21 = 2 * (y * z + w * x)
    R22 = 1 - 2 * (x * x + y * y)
    return (math.atan2(R21, R22), math.asin(max(-1, min(1, -R20))), math.atan2(R10, R00))


class Params(BaseModel):
    chassis: str = "FM-A"
    body: str = "none"
    motor: str = "Light Dash"
    speed: float = 4.99
    # hard-point-first assembly (owner UX spec)
    rear_upper: str = "off"          # off / 15452 / 15550 (top-side screws, high plate)
    rear_lower: str = "off"          # off / 15452 / 15550 (underside screws, low plate)
    rear_upper_roller: bool = False  # roller posts on upper stay
    rear_upper_damper: str = "none"  # none / separate / linked (mid-stay damper)
    rear_attach_upper: str = "none"  # none / sponge
    rear_attach_lower: str = "none"  # none / sponge / 15458
    bar_mode: str = "bare"           # 15458: bare / sponge
    att_15451: bool = False          # front bumper plate
    front_upper: str = "off"         # scaffold
    front_lower: str = "off"         # scaffold
    side: str = "off"                # scaffold
    sponge: str = "sponge2_hard"
    approach_deg: float = 0.0
    walls: bool = True
    rollers: bool = True


def run_sim(p):
    v0 = MOTORS.get(p.motor, p.speed) if p.motor != "custom" else p.speed
    xml, stay_rects = build(p)
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    d.qvel[:] = 0
    for _ in range(1500):
        mujoco.mj_step(m, d)
    d.qvel[:] = 0
    psi = math.radians(p.approach_deg)
    d.qpos[3:7] = [math.cos(psi / 2), 0, 0, math.sin(psi / 2)]
    if psi != 0 and p.rollers:
        sy, cy = math.sin(psi), math.cos(psi)
        extent = max(v * sy + s * ROLLER_Y * cy
                     for v, s in [(BODY_L / 2, 1), (BODY_L / 2, -1), (-BODY_L / 2, 1), (-BODY_L / 2, -1)]) + 0.0045
        d.qpos[1] -= min(min(sy * 0.45, 0.030), max(0.0, extent - (WALL_Y_INNER - 0.002)))
    d.qvel[0] = v0 * math.cos(psi)
    d.qvel[1] = v0 * math.sin(psi)
    for wn in ("wheelF_spin", "wheelR_spin"):
        j = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, wn)
        if j >= 0:
            d.qvel[m.jnt_dofadr[j]] = v0 / WHEEL_R

    frames = []
    corners_b = [(BODY_L / 2, BODY_W / 2), (BODY_L / 2, -BODY_W / 2),
                 (-BODY_L / 2, -BODY_W / 2), (-BODY_L / 2, BODY_W / 2)]
    wheel_dofs = []
    for wn in ("wheelF_spin", "wheelR_spin"):
        j = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, wn)
        if j >= 0:
            wheel_dofs.append(m.jnt_dofadr[j])
    wheel_geoms = {mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, g) for g in ("wheelF", "wheelR")}
    lo_r, hi_r, lo_t, hi_t = MOTOR_SPECS.get(p.motor, (14600, 17800, 1.3, 1.9))
    F_cap = 0.5 * (lo_t + hi_t) * 1e-3 * GEAR / WHEEL_R
    t_end = 1.1
    step = 0
    while d.time < t_end:
        d.xfrc_applied[:] = 0.0
        wq, xq, yq, zq = d.qpos[3:7]
        fwx = 1 - 2 * (yq * yq + zq * zq)
        fwy = 2 * (xq * yq + wq * zq)
        nrm = math.hypot(fwx, fwy) or 1.0
        fwx, fwy = fwx / nrm, fwy / nrm
        v_along = d.qvel[0] * fwx + d.qvel[1] * fwy
        F_des = min(F_cap, max(0.0, 12.0 * (v0 - v_along)))
        gids = {mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_GEOM, "floor")}
        gids |= {g for g in range(m.ngeom)
                 if (mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, g) or "").startswith("ramp")}
        nF = nR = brkF = 0.0
        Ntot = 0.0
        for i in range(d.ncon):
            c = d.contact[i]
            g1 = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, c.geom1) or ""
            g2 = mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, c.geom2) or ""
            tag = g1 + g2
            wheel = "wheelF" in tag or "wheelR" in tag
            if not wheel and not any(k in tag for k in ("brake_", "fin_")):
                continue
            if not (set((c.geom1, c.geom2)) & (gids | wheel_geoms if False else gids)) and not wheel:
                # brake/fin contacts counted against floor or ramp only
                if not (set((c.geom1, c.geom2)) & gids):
                    continue
            buf = np.zeros(6)
            mujoco.mj_contactForce(m, d, i, buf)
            f = abs(buf[0])
            if wheel:
                if "wheelF" in tag:
                    nF += f
                else:
                    nR += f
                Ntot += f
            else:
                brkF += f
        drvF = 0.0
        if Ntot > 0:
            Ftot = min(F_des, 0.8 * Ntot)
            drvF = Ftot
            # force at CG, no moment (applying at contacts with lever excited
            # a porpoising loop on the flat run)
            d.xfrc_applied[1, 0:3] += np.array([Ftot * fwx, Ftot * fwy, 0.0])
        mujoco.mj_step(m, d)
        step += 1
        if step % 20 == 0:
            x, y, z = d.qpos[0:3]
            roll, pitch, yaw = euler_from_quat(d.qpos[3:7])
            cp, sp_ = math.cos(pitch), math.sin(pitch)
            crr, srr = math.cos(roll), math.sin(roll)
            cyy, syy = math.cos(yaw), math.sin(yaw)
            pts = []
            for cx, cyv in corners_b:
                rx_ = cx * cp + cyv * srr * sp_
                ry_ = cyv * crr
                rz_ = -cx * sp_ + cyv * srr * cp
                wx = x + rx_ * cyy - ry_ * syy
                wy = y + rx_ * syy + ry_ * cyy
                wz_ = z + rz_
                pts += [round(wx, 4), round(wy, 4), round(wz_, 4)]
            for x0, z0, x1, z1 in stay_rects:
                for cx, cz in ((x0, z0), (x1, z0), (x1, z1), (x0, z1)):
                    rx_ = cx * cp
                    rz_ = -cx * sp_
                    pts += [round(x + rx_ * cyy, 4), round(y + rx_ * syy, 4), round(z + rz_, 4)]
            wallf = 0.0
            for i in range(d.ncon):
                c = d.contact[i]
                ns = [mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, c.geom1),
                      mujoco.mj_id2name(m, mujoco.mjtObj.mjOBJ_GEOM, c.geom2)]
                if "wallL" in ns or "wallR" in ns:
                    buf = np.zeros(6)
                    mujoco.mj_contactForce(m, d, i, buf)
                    wallf += abs(buf[0])
            upx = sp_ * crr * cyy - (-srr) * syy
            upz = cp * crr
            frames.append(dict(t=round(d.time, 4), x=round(x, 4), y=round(y, 4), z=round(z, 4),
                               ux=round(upx, 3), uz=round(upz, 3),
                               roll=round(math.degrees(roll), 2), pitch=round(-math.degrees(pitch), 2),
                               yaw=round(math.degrees(yaw), 2), v=round(math.hypot(d.qvel[0], d.qvel[1]), 3),
                               wallF=round(wallf, 2), nF=round(nF, 3), nR=round(nR, 3),
                               drvF=round(drvF, 3), brkF=round(brkF, 3), pts=pts))
    return frames


@app.get("/")
def index():
    return FileResponse(os.path.join(DIR, "viz", "index.html"))


@app.post("/api/simulate")
def simulate(p: Params):
    frames = run_sim(p)
    last = frames[-1]
    maxr = max(abs(f["roll"]) for f in frames)
    maxp = max(abs(f["pitch"]) for f in frames)
    flipped = maxr > 100 or maxp > 100
    out = "CRASH" if flipped else ("SKEWED" if abs(last["yaw"]) > 15 else
                                   ("OUT" if abs(last["y"]) > 0.06 else "CLEAN"))
    return {"frames": frames, "outcome": out, "presets": _presets()}


@app.get("/api/defaults")
def defaults():
    return _presets()


def _presets():
    return {"chassis": list(CHASSIS), "bodies": list(BODIES),
            "motors": list(MOTORS) + ["custom"], "motor_speeds": MOTORS,
            "stays": ["off", "15452", "15550"],
            "attachments": ["none", "sponge", "15458"],
            "bar_modes": ["bare", "sponge"],
            "dampers": ["none", "separate", "linked"],
            "sponges": list(SPONGES)}
