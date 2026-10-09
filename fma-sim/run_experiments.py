import sys
sys.path.insert(0, "/workspace/fma-sim")
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from fma_model import write_ramp_obj, build_xml, Sim, summarize, RAMP_HALF_LEN, RAMP_HEIGHT

V0 = 4.2

write_ramp_obj(profile_k=1.5)

CAR1 = dict(brake_clearance=0.004, brake_x=-0.048, brake_mu=0.5, brake_solref=0.015)
CAR2 = dict(brake_clearance=0.001, brake_x=-0.043, brake_mu=0.3, brake_solref=0.006)
CAR1_FIXED = dict(brake_clearance=0.002, brake_x=-0.048, brake_mu=0.5, brake_solref=0.015)

SCENARIOS = [
    ("Car1: high rear plate (sponge)", CAR1, 0.0),
    ("Car2: low 15458 bar (plastic)", CAR2, 0.0),
    ("Car1 + spring k=0.10 N/mm", CAR1, 100.0),
    ("Car1 brake lowered to 2mm", CAR1_FIXED, 0.0),
]


def run_all():
    results = {}
    logs = {}
    for name, kw, k in SCENARIOS:
        sim = Sim(build_xml(**kw), spring_k=k, spring_preload=0.004, v0=V0)
        log = sim.run(t_end=1.2)
        results[name] = summarize(log)
        logs[name] = log
    return results, logs


def sweeps():
    fix = []
    for cl in [0.001, 0.002, 0.003, 0.004, 0.005]:
        sim = Sim(build_xml(brake_clearance=cl, brake_x=-0.048, brake_mu=0.5, brake_solref=0.015), v0=V0)
        fix.append((cl * 1000, summarize(sim.run(t_end=1.2))))
    spring = []
    for k in [0, 25, 50, 100, 150, 200]:
        sim = Sim(build_xml(**CAR1), spring_k=k, spring_preload=0.004, v0=V0)
        spring.append((k, summarize(sim.run(t_end=1.2))))
    return fix, spring


def plots(logs, fix, spring):
    xs = np.linspace(-0.2, 0.5, 300)
    zs = RAMP_HEIGHT * np.maximum(0, 1 - (xs / RAMP_HALF_LEN) ** 2) ** 1.5

    fig, ax = plt.subplots(1, 3, figsize=(16, 4.5))
    colors = ["tab:red", "tab:blue", "tab:green", "tab:orange"]
    for (name, log), c in zip(logs.items(), colors):
        ax[0].plot(log["x"], log["z"] * 1000, color=c, lw=1, label=name)
    ax[0].plot(xs * 1000, zs * 1000, "k-", lw=2, label="10310 profile")
    ax[0].set_xlabel("x (mm)")
    ax[0].set_ylabel("CG height (mm)")
    ax[0].set_title("Trajectory @ %.1f m/s" % V0)
    ax[0].legend(fontsize=7)
    ax[0].grid(alpha=0.3)

    for (name, log), c in zip(logs.items(), colors):
        m = (log["t"] > 0.1) & (log["t"] < 0.6)
        ax[1].plot(log["t"][m], np.degrees(log["pitch"][m]), color=c, lw=1.2, label=name)
    ax[1].axhline(0, color="k", lw=0.5)
    ax[1].axhline(-90, color="gray", ls="--", lw=0.8)
    ax[1].set_xlabel("t (s)")
    ax[1].set_ylabel("pitch (deg, + nose-up)")
    ax[1].set_title("Pitch through crossing + flight")
    ax[1].legend(fontsize=7)
    ax[1].grid(alpha=0.3)

    for (name, log), c in zip(logs.items(), colors):
        m = (log["t"] > 0.1) & (log["t"] < 0.5)
        ax[2].plot(log["t"][m], log["brakeN"][m], color=c, lw=1.2, label=name)
    ax[2].set_xlabel("t (s)")
    ax[2].set_ylabel("brake normal force (N)")
    ax[2].set_title("Brake contact force")
    ax[2].legend(fontsize=7)
    ax[2].grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig("/workspace/fma-sim/results_main.png", dpi=130)

    fig, ax = plt.subplots(1, 2, figsize=(11, 4.2))
    ax[0].plot([f[0] for f in fix], [f[1]["takeoff_pitch_rate_rad_s"] for f in fix], "o-", label="takeoff pitch rate")
    ax[0].plot([f[0] for f in fix], [f[1]["max_brake_N"] / 10 for f in fix], "s--", label="max brake N / 10")
    fl = [f[1]["flipped"] for f in fix]
    ax[0].scatter([f[0] for f in fix], [-12 if f else -6 for f in zip(fl, fl)], c=["red" if x else "green" for x in fl], marker="x", s=80, label="flip (red) / survive (green)")
    ax[0].set_xlabel("Car1 brake clearance (mm)")
    ax[0].set_ylabel("rate (rad/s) / N/10")
    ax[0].legend(fontsize=8)
    ax[0].grid(alpha=0.3)
    ax[0].set_title("Brake height sweep (Car1)")

    ax[1].plot([s[0] / 1000 for s in spring], [s[1]["takeoff_pitch_rate_rad_s"] for s in spring], "o-", label="takeoff pitch rate")
    ax[1].plot([s[0] / 1000 for s in spring], [s[1]["max_brake_N"] / 10 for s in spring], "s--", label="max brake N / 10")
    fl2 = [s[1]["flipped"] for s in spring]
    ax[1].scatter([s[0] / 1000 for s in spring], [-12 if f else -6 for f in zip(fl2, fl2)], c=["red" if x else "green" for x in fl2], marker="x", s=80, label="flip (red) / survive (green)")
    ax[1].set_xlabel("damper spring k (N/mm)")
    ax[1].legend(fontsize=8)
    ax[1].grid(alpha=0.3)
    ax[1].set_title("Spring preload sweep (Car1, 4mm brake)")
    fig.tight_layout()
    fig.savefig("/workspace/fma-sim/results_sweeps.png", dpi=130)


if __name__ == "__main__":
    results, logs = run_all()
    print(f"{'scenario':35} {'to_rate':>8} {'to_pitch':>9} {'maxN':>6} {'max|pit|':>9} {'flip':>5} {'settle':>6}")
    for name, s in results.items():
        print(f"{name:35} {s['takeoff_pitch_rate_rad_s']:+8.2f} {s['takeoff_pitch_deg']:+9.1f} {s['max_brake_N']:6.1f} {s['max_abs_pitch_deg']:9.0f} {str(s['flipped']):>5} {str(s['settled_flat']):>6}")
    fix, spring = sweeps()
    plots(logs, fix, spring)
    print("\nplots: results_main.png, results_sweeps.png")
