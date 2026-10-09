"""Tamiya FRP/Carbon plate geometry — measured from official product photos (DSP hole
extraction) + published specs. Provenance for every number is explicit.

MEASUREMENT METHOD
- Source images: Tamiya official product shots (CDN, 1000x750 / 450x280), saved in parts/.
- Holes extracted by dark-blob detection (scipy.ndimage.label); centers in pixels.
- 15458 image: clean row of 6 holes at y~427px: x = 406.0 444.3 481.1 516.8 552.0 586.2
  -> pitch 35.9 px (uniform +-1). Second bar row of 3 holes at y~337px, pitch 34.4 px.
- SCALE: image-only, no ruler in frame. Two hypotheses (px/mm):
    A) hole diameter = 3.0 mm (holes measure ~10 px) -> 3.33 px/mm
    B) hole diameter = 3.2 mm             -> 3.13 px/mm
  Absolute mm below use hypothesis A and are marked (scale-A). ONE caliper measurement
  of any hole pitch on the real part locks the scale; ratios are exact from the image.

PARTS (published specs from Tamiya product pages, fetched this session)
15451 FRP Wide Front Plate (AR): pairs with 15452; 9-19mm rollers within regulations.
15452 FRP Wide Rear Plate (AR):  product text (fetched): 9/11/13/17/19mm rollers legal.
15458 Brake Set (AR): product text (fetched): 2 sponge types cut into 5 mm wide strips;
      stays molded so sponge rarely detaches. FM-A/MS use requires 15430.
      15550 HG Carbon Brake Stay: 1.5 mm thick (published). Front/rear mountable.
15472: image only (vision relay down); identity unconfirmed — treat as placeholder.
"""

# 15458 crossbar (the bar Car Two uses as a skid), scale-A (3.0 mm hole dia):
BAR_15458 = {
    "hole_row_px": [406.0, 444.3, 481.1, 516.8, 552.0, 586.2],
    "hole_row_mm_from_left_edge_hole": [0.0, 11.5, 22.5, 33.3, 43.9, 54.2],  # scale-A
    "pitch_mm": 10.8,      # scale-A (hypothesis B would give 11.5)
    "n_holes": 6,
    "holes_2nd_bar": 3,    # second stay included in set, same pitch
    "sponge_strip_width_mm": 5.0,   # PUBLISHED (product text)
    "material": "FRP",
    "thickness_mm": 2.0,   # FRP plate standard — UNVERIFIED, flag
}

STAY_15550 = {
    "material": "carbon",
    "thickness_mm": 1.5,   # PUBLISHED (product title "(1.5mm)")
    "mountable": "front and rear",  # published
    "holes": "DSP on carbon weave noisy: >=9 hole-like features (superseded by HOLE_GRIDS below)",
}

PLATES_15451_15452 = {
    "pair": "FRP wide front/rear plates for AR chassis",
    "roller_support": "9, 11, 13, 17, 19 mm",  # published
    "holes_15451_px": [(287.8, 169.6), (307.1, 171.8), (313.9, 166.2), (332.4, 169.1)],
    "holes_15452": "superseded by HOLE_GRIDS below",
}

# Chassis mount points (from Tamiya chassis pages/wiki, this session):
# FM-A: removable 2-hardpoint rear stay; front bumper + front underguard w/ skid bar.
# AR:  NON-removable rear stay w/ brake skid bar under it; extended front bumper.
# SXX/Super-X: 2-hardpoint rear stay replaced by 1-hardpoint in SXX; nose guard holes.
# Standard screw: holes on all plates/stays share ONE pitch family (the community
# chart's center/1-5/13/19 lines) -> parts are cross-mountable, which is why every
# stay works on every chassis' bumper/rear holes.

HOW_TO_LOCK_SCALE = "Measure one hole-to-hole distance on your real 15458 bar with "
"calipers (holes are evenly spaced); tell me the mm and every number here becomes exact."

# === CONFIRMED VIA DIRECT API VISION (thekaocloud/default) + DSP, this session ===
# User photo (570x95): 5-hole center row confirmed (3 sharp DSP @ x=244.6/279.1/313.3
# px + 2 more per vision at ~x=342/376), uniform pitch 34.3px; PLUS 2 END holes at
# y~45: x=147.7 & 409.6 (span 261.9px). Vision independently read the same row.
# SCALE (two hypotheses, no ruler in photo):
#   hole=2.0mm -> 4.75px/mm -> pitch 7.2mm, end-hole span 55.1mm  (physically sensible)
#   hole=3.0mm -> 3.17px/mm -> pitch 10.8mm, end-span 82.6mm (implausible for 97mm chassis)
# => working values: pitch 7.2mm, span 55mm, bar length ~60mm. CONFIRM with calipers.
BAR_15458.update(n_holes=6, holes_center_row=5, pitch_mm=7.2, end_hole_span_mm=55.1)

# Chart line membership (miniyonfan chart read by vision):
STAY_15451_AR_FRONT_WIDE = {"lines_with_holes": {1:2, 2:1, 3:1, 4:2, 5:1, "19mm":2}}
STAY_15452_AR_REAR_WIDE  = {"lines_with_holes": {1:2, 2:1, 3:2, 4:2, 5:2, "19mm":2}}
# NOTE: line-to-mm offsets not yet numeric (chart lines unlabeled in mm).
# 15472 identity: vision read low-confidence (hallinated hardware) - UNVERIFIED.

# === 15452 extracted via contrast-stretch + 3x upscale + threshold sweep (th=100/115) ===
# Three hole rows (px in upscaled 1350x840 image):
#  row A y~446: x=215.5 265.4 289.9 337.9 363.6  -> spacings 50/24.5/48/26 (alternating)
#  row B y~519: x=419.4 452.0 534.0 576.4 608.8 (+830.5, 1167.8 far holes)
#  row C y~641: x=415.7 448.5 497.4 528.7         -> spacings 33/49/31
# Spacing quanta: ~24.5px, ~32.5px, ~49px. Ratios 1 : 1.33 : 2 -> dual-pitch grid.
# If narrow=5mm (sponge-cut standard): quantum = 24.5px/5mm = 4.9px/mm ->
#   row pitch alt 5mm/10mm; 32.5px=6.6mm (~15458 bar pitch, consistent); row gap ~50mm? (unlikely) 
# -> row gaps need the caliper lock same as 15458. Grid SHAPE is certain; mm pending.
STAY_15452_AR_REAR_WIDE.update({
    "rows_px_upscaled": {"A":[215.5,265.4,289.9,337.9,363.6], "B":[419.4,452.0,534.0,576.4,608.8], "C":[415.7,448.5,497.4,528.7]},
    "spacing_quantum_px": [24.5, 32.5, 49.0],
    "grid": "alternating dual-pitch rows (narrow/wide), matches chart lines 1-5 + 19mm",
})

# === GROUND TRUTH from owner (this session) + DSP confirmation ===
HOLE_COUNTS_GT = {"15452": 21, "15451": 17, "15458": 7, "15550": 21}
# 15458 structure CONFIRMED: 3 center holes (x=244.6/279.1/313.3, y~27)
# + vertical pairs on both sides: left x~148 (y=18.0 & 45.2), right x~409.6 (y=17.8 & 44.9)
# -> DSP found both stacked pairs exactly as described: 3 + 2*2 = 7 holes total.
# Geometry (user photo): side stacks at x=148/410 -> lateral span 261.6px;
# center 3 @ 34.3px pitch; stack vertical pitch ~27px (y 18->45).
BAR_15458.update(holes_total=7, structure="3 center + 2 vertical stacks (one per side)",
                 stack_x_px=(148, 409.6), stack_y_px=(18, 45), center_y_px=27)
# 15452: 21 holes total (owner). DSP rows A/B/C captured 14; 7 more at untested
# thresholds/positions. 15550: 21 holes (owner); carbon-weave noise limited DSP to 9.

# === COMPLETE HOLE GRIDS (bright-blob DSP: holes show white bg through dark plate) ===
# Method fix: plates are DARK on white bg -> holes are BRIGHT blobs INSIDE the plate
# region (earlier dark-blob runs were hitting the loose screws/washers below the plate).
# All grids LR-symmetric (axis from mirror-pair sums, consistent +-1.5px).

HOLE_GRIDS = {
 "15451": {  # 17/17 vs owner count; th=120 stable at th=140; plate bbox x13-437 y83-156
   "axis_px": 225.2, "img": "15451_1.jpg (450x280)",
   "trio": [(199.1,101.8),(224.6,101.9),(249.6,101.8)],   # pitch 25.4px
   "left":  [(49.1,95.1),(117.4,96.9),(33.9,110.3),(74.5,111.0),
             (128.2,123.1),(29.7,126.7),(25.6,143.7)],
   "right": [(401.3,95.2),(332.5,97.0),(417.0,110.6),(376.0,110.6),
             (320.8,123.2),(421.0,127.2),(425.3,144.6)]},
 "15452": {  # 21/21 vs owner count; th=150, area>=9; plate bbox x11-440 y39-149
   "axis_px": 225.6, "img": "15452_1.jpg (450x280)",
   "trio": [(200.3,70.7),(225.6,70.9),(251.2,70.6)],      # pitch 25.4px
   "left":  [(48.5,54.1),(128.6,55.7),(73.7,69.2),(33.0,76.0),(128.6,81.6),
             (41.5,89.4),(24.7,92.6),(28.4,109.2),(158.5,138.8)],
   "right": [(404.3,53.2),(323.6,55.5),(378.9,68.5),(419.7,74.7),(323.6,81.1),
             (411.6,88.7),(429.0,91.3),(424.8,107.4),(294.0,137.2)]},
 "15550": {  # 21/21 vs owner count; stable th=140-180 after median-9 weave removal;
   # vertical columns! col357/col640 = 5 holes, col295/col702 = 4 holes, + center trio
   "axis_px": 498.75, "img": "15550_1.jpg (1000x750), plate bbox x264-733 y100-404",
   "trio": [(445.6,269.8),(498.9,269.8),(551.9,269.8)],   # pitch 53.15px
   "col_inner_L": (357.2, [129.0,170.5,212.0,265.4,366.9]),
   "col_inner_R": (640.4, [129.2,170.9,212.5,266.0,367.6]),
   "col_outer_L": (295.3, [247.3,300.2,344.7,384.3]),
   "col_outer_R": (702.5, [247.9,301.5,345.7,385.4])},
 "15458": {  # 7/7 owner photo user_15458.jpg (570x95) — authoritative
   "axis_px": 280.6, "img": "user_15458.jpg (570x95)",
   "trio": [(244.6,27.0),(279.1,27.0),(313.3,27.0)],      # pitch 34.3px
   "stack_L": (148.0, [18.0,45.2]), "stack_R": (409.6, [17.8,44.9])},
}

# CROSS-PLATE FINDINGS (px ratios exact; mm pending ONE caliper number):
# - 15451 & 15452: SAME scale (trio pitch 25.4px both, plate widths 424/429px).
#   Shared hole x-positions (stacking): 25.3/24.7, 29.4/28.4, 33.8/33.0, 48.9/48.5,
#   73.9/73.7 -> end-tab holes align; 15452 adds x=41.5 & pairs@128.6/323.6 + 158.5/294.
# - 15452 vertical pairs @x=128.6: dy=25.9px (1.02 trio pitch).
# - 15458 bar (user photo) trio pitch 34.3px = 1.35x the 450-img scale; stack dy=27.2px
#   (0.79 pitch); stack span 261.6px (7.63 pitches).
# - 15550 trio pitch 53.15px = 2.09x the 15451/52 trio pitch at plate-width ratio 469/429
#   -> NOT same-width plates: if trios share mm pitch, 15550 is ~half the width of the
#   WIDE plates; if 15550 is same width, its trio pitch is 2x (dual-pitch stacking).
#   OWNER GUIDANCE NEEDED: is 15550 much narrower than 15451/15452, or same width?

# === ARM REGISTRATION 15550 <-> 15452 (owner: "black arms line up") ===
# Vision (default) identified arms: 15452 holes 12/21 = bottom-center droop tabs
#   (158.5,138.8)/(294.0,137.2); 15550 holes 6,7,10,11 = top ears (inner columns
#   x=357.2/640.4, lower holes). Arm lateral span: 15452=135.5px, 15550=283.2px.
#   ratio 2.0900 vs trio-pitch ratio 2.0925 -> agree 0.12%. ARMS LINE UP at same mm.
# => SCALE LOCK: s(15550) = 2.09 x s(15451/15452). Arm holes sit at u_x = -+2.65u
#   on BOTH plates (15452: -+2.64/2.69; 15550: -+2.67/2.66). 15550 arms point UP
#   from plate edge, 15452 arms droop DOWN (u_y 15550 = -1.09/-0.08 vs 15452 = +2.65).
# => All grids normalized to u-units (1u = center-trio pitch, origin=trio middle):
#   grids_u.json. mm = u * pitch_mm. ONE caliper trio-pitch measurement finishes it.
# 15458 bar stacks: u_x = -+3.81, u_y = -0.27/+0.53 (stack pitch 0.79u).

# === CHASSIS MOUNT POINTS (rear stay interface) ===
# LOCKED by plate arm registration (this is the chassis-side counterpart):
CHASSIS_MOUNTS = {
 "_shared_2hardpoint": {   # AR / FM-A / MA family (15451/15452/15550 bolt pattern)
   "rear_hardpoint_spacing": "5.30u (=+-2.65u) lateral — EXACT, from arm span match 0.12%",
   "high_low_mount": "which ARM hole you screw through (user: 'top or bottom of mount "
       "point'): 15550 ear pairs 1.00u apart vertical, 15458 bar stacks 0.79u apart "
       "-> plate sits lower/higher by that amount; chassis hardpoint itself is fixed"},
 "FM-A": {"wb_mm":83, "width_mm":97, "rear_stay":"removable 2-hardpoint w/ built-in skid (published)", "note":"2-hardpoint stays only (wiki)"},
 "AR":  {"wb_mm":82, "width_mm":97, "rear_stay":"integrated, non-removable (published)"},
 "VZ":  {"wb_mm":80, "width_mm":None, "rear_stay":"estimated; wb=80 est (wiki blocked earlier, VZ page now reachable)"},
 "SXX": {"wb_mm":84, "width_mm":98, "rear_stay":"2-hardpoint (1-hardpoint in SXX era change; published notes)"},
}
# STILL OPEN (needs straight-on drawing or owner caliper):
#  - hardpoint HEIGHT above rear-axle line + set-back behind axle, per chassis.
#    (Construction photos are angled -> vision coords unreliable; Tamiya product CDN
#     shots 95509_4c1..4c3 + wiki construction views saved in parts/chassis/.)
#  - absolute mm: ONE trio-pitch caliper reading converts u -> mm everywhere.

# === CORRECTION (owner): high/low mount semantics ===
# NOT "which arm hole": BOTH hardpoints are always screwed. High/low = inserting the
# screws from the TOP side of the car vs from the UNDERSIDE -> plate clamps to the
# OTHER face of the chassis mount boss, shifting plate height by ~boss height.
# To quantify: need SIDE-VIEW geometry (hardpoint height above rear axle, boss height,
# set-back behind axle). Official photos reachable online are all angled/low-res ->
# vision coords unreliable. PLAN: owner side-view photo of FM-A + known wheel dia for
# scale; caliper trio pitch for mm. Then all chassis follow via 5.30u shared interface.

# === OWNER-MEASURED mount heights (mm above ground) — replaces placeholders ===
# FM-A: plate bottom low=7, high=19 (shift 12mm). 15458 bar: lowest point 2.5mm,
#   20mm behind hardpoint center. 15451 front: front edge 10.5, back 12.5 (2deg rake
#   down toward bumper). AR: plate bottom low=5, high=19 (shift 14mm); 15451
#   front 12.0, back 12.5 (0.5mm over plate — owner asks confirm; no public source
#   available: official photos angled, no published drawings. Flagged for re-measure.)
# Copied into server.py: MOUNT, BAR15458, FRONT_15451 (FM-A/AR measured; SXX/VZ
# placeholder 6/19 + 11/12.5 until owner measures).

# === OWNER-MEASURED 10310 ramp profile (this session) ===
# 180mm total base @1mm height (so ends are 1mm off track), curved section 150mm,
# peak 20mm from track (19mm above base) at center. Measured from leading edge:
#   20mm->3mm, 30mm->5mm, 40mm->7.5-8mm, 50mm->10.5-11mm, 75mm(peak)->20mm.
# Fit: z = 1mm + 19mm*(d/75mm)^1.709  (all points within 0.26mm).
# ramp_parabola.obj regenerated with this profile (151 stations); viz preview + side
# view updated to same formula. Replaces the old z=20*(1-|x|/85)^2 parabola.
