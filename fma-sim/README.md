# FM-A × 10310 Jump Ramp — Physics Model

Planar (pitch-plane) physics simulation of a Tamiya FM-A Mini 4WD crossing the 10310
circuit jump ramp, built to answer: why does a high, rearward-mounted brake plate cause a
somersault while a low 15458 brake bar lands clean, and can spring-preloaded mass dampers
mitigate it?

Built on **MuJoCo 3.x** (rigid-body contacts, slide joints, custom push-only spring force)
— no hand-rolled solver. Context and full conversation history:
`/workspace/fma-brake-geometry-chatgpt.md`.

## Run

```
pip install mujoco numpy matplotlib
python3 run_experiments.py      # main scenario table + sweeps + plots
python3 sanity_check.py         # raw scenario debug
```

Outputs: `results_main.png` (trajectories, pitch, brake force), `results_sweeps.png`
(brake-height and spring-rate sweeps), metrics table on stdout.

## Model

- **Car** (body frame = CG, +x forward): free rigid body, m=125 g total, I_pitch=2.0e-4
  kg·m², wheelbase 83 mm (Tamiya FM-A spec), CG 40/43 mm front/rear, CG height 15 mm.
  Two outboard free-spinning wheel discs per axle (r=12.5 mm, μ=0.6, spin matched to
  launch speed), nose/tail via chassis box (5 mm belly clearance), brake pad as a small
  box with per-car clearance / position / μ / contact softness.
- **Mass damper**: 9.4 g (2 × 4.7 g Tamiya 15392) on a 20 mm slide at x=−45 mm. Optional
  compression spring applied as a **push-only** force (k, engages 4 mm above bottom stop)
  — emulates the proposed 10321-spring-under-weight mod. Bottom stop = stock behavior.
- **Ramp 10310** (170 × 110 × 20 mm): raised-dome profile z = H·(1−(x/h)²)^1.5, H=20 mm,
  h=85 mm — tangent-continuous entry (per owner: "not straight, small curve upwards"),
  peak radius ≈ 120 mm, max flank slope ≈ 16°, symmetric (works both ways). Static mesh.
- **Launch**: settled at rest 300 mm before ramp, then v₀ = 4.2 m/s (Light-Dash-class
  under load) with matched wheel spin.
- Timestep 1e-4 s, implicitfast integrator.

### Calibration anchors
- Tamiya specs: FM-A (71 g bare, 83 mm WB), 15392 dampers (4.7 g), 15458 brake set.
- Mini4Science measured sponge μ and tyre rebound (used as priors; brake μ 0.3 bare
  plastic / 0.5 sponge).
- **Primary anchor: the observed fleet behavior** — Car Two (low bar) lands properly,
  Car One (high rearward plate) somersaults. Contact softness was tuned until the model
  reproduces both at 4.2 m/s; comparative results (deltas between configs) are more
  trustworthy than absolute outcomes.

## Findings (v₀ = 4.2 m/s)

| scenario | takeoff pitch rate | max brake N | outcome |
|---|---|---|---|
| Car1: high rear plate, sponge, 4 mm clearance | −8.3 rad/s | 62.6 N | somersault |
| Car2: low 15458 bar, plastic, 1 mm clearance | −4.8 rad/s | 30.6 N | lands clean |
| Car1 + spring-preloaded damper, k=0.10 N/mm | −6.3 rad/s | 18.1 N | survives |
| Car1 with brake lowered to 2 mm | −3.0 rad/s | 20.0 N | lands clean |

1. **Mechanism confirmed**: the high plate's *engagement timing* (not its 5 mm lever arm)
   is the killer. It first contacts where the ramp slope is already steep, acting as a
   rigid prop behind the rear axle → 3× the slam force and the worst takeoff rotation.
   The low bar engages early on the gentle lead-in and drags progressively.
2. **Friction material matters**: a grabby sponge (μ 0.5) at the same geometry where a
   slick bare bar (μ 0.3) survives still flips — bite time × force = angular impulse.
3. **Spring-preloaded damper works, with a sweet spot**: k ≈ 0.10 N/mm cut the slam
   62.6 → 18.1 N and saved the car (max pitch 47°, recovers). k ≥ 0.20 N/mm re-fails —
   the weight couples rigidly (stock-like) and transmits 47 N. Matches the analytical
   prediction of a moderate-spring optimum (0.05–0.30 N/mm).
4. **Cheapest fix**: lowering the plate 2 mm beats every damper tuning (−3.0 rad/s,
   lands clean) — geometry first, damper second.

## Speed-retention trade-off (v0 = 4.2 m/s)

| config | takeoff ω | exit v | note |
|---|---|---|---|
| sponge plate 4 mm (Car1 stock) | −8.29 | 2.91 | flips |
| **slick plate** 4 mm (μ0.3) | −6.14 | 3.05 | grip removal = free 2 rad/s |
| sponge plate **lowered 2 mm** | −2.96 | 2.93 | best ω; exit speed unpenalized |
| CG drop 3 mm | −5.70 | 2.97 | free 2.6 rad/s |
| spring k=100 N/m | −6.31 | 2.98 | + survives (47°) |

- High-mounted sponge is *worse than nothing*: no approach drag, first bites on the steep
  section, and its grip extends the prop force through the front-unload window. A slick
  face (bare FRP / tape over sponge) kicks and releases. At 2 mm the same sponge becomes
  the best config — height, not material, is the problem.
- Pre-crest braking costs ~0.4 m/s but repays itself in avoided slam dissipation: exit
  speeds are equal (2.93 vs 2.91) — the "speed burn" fear is overstated at this scale.
- Nose-skid and CG-back were tested and gave no robust benefit in this planar model
  (skid either catches the entry like a front brake or never engages; landing outcomes
  near the survival boundary are chaotic — treat ω as the metric, not the flip boolean).

## Limitations
- Planar: no lateral dynamics, rollers, or lane walls (real cars are caught by guide
  walls on landing, so absolute flip rates here overstate crash severity).
- No motor torque during crossing (speed near-constant after braking), no aero.
- 10310 exact profile not measured (vision analysis unavailable); dome shape fit to
  170×20 mm spec + "small upward curve" + calibration to observed behavior.
- 2D wheel discs; single contact point per brake (no pad-area smear).

## Files
- `fma_model.py` — ramp mesh builder, MJCF model builder, Sim runner, metrics
- `run_experiments.py` — scenario suite, sweeps, plots
- `sanity_check.py` — debug scenarios
- `ramp_10310.obj` — generated ramp mesh

## 3D extension — `fma3d.py` (arrival angle, walls, rollers)

Full 6-DOF car (roll/yaw free), lane walls at 105 mm spacing, eight two-stage
rollers (front/rear x upper/lower), three rear damper architectures (none /
two separate 4.7 g weights / one 9.4 g linked spanning weight), yaw-angle
arrivals aimed at the wall (kiss 30-500 mm before ramp or at ramp mouth).

Findings (v0 = 4.2 m/s, sponge brake at 2 mm):
- Front-roller wall kisses self-correct up to ~12 deg arrival error — even with
  the kiss landing at the ramp mouth. Caster geometry works.
- 15-21 deg errors: survive the crossing but exit skewed ~30 deg — failure is
  deferred to the next section, not a crash on the ramp.
- Upper-roller-only contact (low rollers disabled): 3-5x more roll excursion,
  still recovers at this speed — confirms contact-height doctrine directionally.
- Separate vs linked dampers: indistinguishable in every scenario tested. Wall
  impulses (~1 N·s) dwarf the weights' authority for lateral events.
- Mid-ramp / mid-air wall hits never materialized: the first kiss kills the
  lateral drift; a second mid-flight perturbation would be required.
- Known noise: mild yaw wander at psi=0 (dome-crossing yaw instability) is
  realistic but chaotic run-to-run; treat single cells as qualitative.

## Verification log (euler + wall contact)

- `euler_from_quat` exact on known pure/composed orientations (an apparent
  yaw/roll swap during testing was a bug in the test's quaternion builder,
  not the model). Tracks compound tumbling: 108 deg measured vs ~102 deg
  expected over 0.2 s at 8.9 rad/s.
- CONVENTION: in `fma3d` positive pitch = nose-DOWN (z-up frame, rotation
  about +y) — opposite the 2D model's nose-up convention. All reported 3D
  results use magnitudes. Euler decomposition is singular at pitch = +/-90 deg
  (car exactly vertical) where roll/yaw swap; at 1 ms sampling the unwrap
  handles it and flip classification (>100 deg any axis) is unaffected.
- Wall contact verified: zero penetration, correct rebound (1.0 -> -0.22 m/s),
  measured impulse 0.21 N·s vs momentum change 0.15 N·s (excess = contact
  damping dissipation, as designed for soft contacts).
