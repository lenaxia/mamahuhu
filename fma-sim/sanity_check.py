import sys
sys.path.insert(0, "/workspace/fma-sim")
from fma_model import write_ramp_obj, build_xml, Sim, summarize

ramp = write_ramp_obj()
print(f"ramp mesh: {ramp}")

scenarios = {
    "car1_high_rear_brake": dict(brake_clearance=0.005, brake_x=-0.048, brake_mu=0.5, brake_solref=0.006),
    "car2_low_bar_brake": dict(brake_clearance=0.002, brake_x=-0.043, brake_mu=0.5, brake_solref=0.012),
    "car1_no_brake": dict(brake_clearance=0.005, brake_x=-0.048, brake_mu=0.0, brake_solref=0.006),
}

for name, kw in scenarios.items():
    sim = Sim(build_xml(**kw))
    log = sim.run(t_end=1.2)
    s = summarize(log)
    print(f"\n=== {name} ===")
    for k, v in s.items():
        print(f"  {k}: {v:.3f}" if isinstance(v, float) else f"  {k}: {v}")
