"""Photo -> BodyM-style binary silhouette, with capture quality control.

Closes the last gap in the pipeline: Stage 1 was trained on clean ground-truth
masks, and this produces one from an ordinary phone photo.

Two design decisions come straight out of reports/mask_robustness.csv:

1. The alpha matte is thresholded on the CONSERVATIVE side. Over-segmentation
   (dilation) cost up to +0.70 cm of waist error, while equivalent
   under-segmentation cost nothing and slightly helped. When in doubt, cut in.

2. Quality control gates on POSE and FRAMING rather than on mask IoU. The same
   study showed IoU does not predict downstream error - a 0.90-IoU soft matte was
   harmless while a 0.92-IoU dilated mask was the worst case - so the useful
   checks are whether the whole body is in frame and the arms are clear of the
   torso, which is what the ellipse model actually assumes.
"""
import numpy as np, cv2
from pathlib import Path

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models" / "mediapipe"

# selfie_multiclass categories: 0 background, 1 hair, 2 body-skin, 3 face-skin,
# 4 clothes, 5 others(accessories). Everything except background is "person".
PERSON_CLASSES = (1, 2, 3, 4, 5)
ALPHA_CUT = 0.62          # >0.5 deliberately: bias toward under-segmentation
LM = {"nose": 0, "l_shoulder": 11, "r_shoulder": 12, "l_hip": 23, "r_hip": 24,
      "l_wrist": 15, "r_wrist": 16, "l_ankle": 27, "r_ankle": 28}

_segmenter = _pose = None


def _load():
    global _segmenter, _pose
    if _segmenter is None:
        _segmenter = vision.ImageSegmenter.create_from_options(vision.ImageSegmenterOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODELS / "selfie_multiclass.tflite")),
            running_mode=vision.RunningMode.IMAGE,
            output_category_mask=True, output_confidence_masks=True))
        _pose = vision.PoseLandmarker.create_from_options(vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(MODELS / "pose_landmarker_heavy.task")),
            running_mode=vision.RunningMode.IMAGE, num_poses=1,
            min_pose_detection_confidence=0.5))
    return _segmenter, _pose


def _largest_component(mask: np.ndarray) -> np.ndarray:
    """Drop stray blobs - mirrors, furniture, a second person in frame."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    if n <= 1:
        return mask
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return lab == biggest


def segment(image_path) -> dict:
    """Return the silhouette plus a quality-control verdict."""
    seg, pose = _load()
    bgr = cv2.imread(str(image_path))
    if bgr is None:
        raise FileNotFoundError(f"cannot read image: {image_path}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    mp_img = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

    res = seg.segment(mp_img)
    # sum the person classes' confidences, then cut conservatively
    conf = sum(np.asarray(res.confidence_masks[c].numpy_view()) for c in PERSON_CLASSES)
    mask = conf >= ALPHA_CUT
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))).astype(bool)
    mask = _largest_component(mask)

    h, w = mask.shape
    qc, issues = {}, []
    qc["coverage_pct"] = round(100 * mask.mean(), 1)
    if qc["coverage_pct"] < 4:
        issues.append("subject too small in frame - move closer or crop")
    if qc["coverage_pct"] > 60:
        issues.append("subject fills the frame - step back so the whole body fits")

    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    if len(rows) and len(cols):
        if rows[0] <= 1 or rows[-1] >= h - 2:
            issues.append("body is cut off at the top or bottom of the frame")
        if cols[0] <= 1 or cols[-1] >= w - 2:
            issues.append("body is cut off at the left or right edge")

    pres = pose.detect(mp_img)
    if not pres.pose_landmarks:
        issues.append("no person detected - check lighting and that the full body is visible")
        qc["pose_detected"] = False
    else:
        qc["pose_detected"] = True
        lm = pres.pose_landmarks[0]
        vis = {k: lm[i].visibility for k, i in LM.items()}
        qc["min_landmark_visibility"] = round(float(min(vis.values())), 2)
        if min(vis["l_ankle"], vis["r_ankle"]) < 0.5:
            issues.append("feet not visible - the whole body must be in frame for height scaling")
        if vis["nose"] < 0.5:
            issues.append("head not clearly visible")

        # arms must clear the torso, or the waist chord swallows them
        sh_w = abs(lm[LM["l_shoulder"]].x - lm[LM["r_shoulder"]].x) or 1e-6
        hip_x = (lm[LM["l_hip"]].x + lm[LM["r_hip"]].x) / 2
        gap = min(abs(lm[LM["l_wrist"]].x - hip_x), abs(lm[LM["r_wrist"]].x - hip_x)) / sh_w
        qc["arm_clearance"] = round(float(gap), 2)
        if gap < 0.55:
            issues.append("arms too close to the body - hold them out at about 30 degrees")

        # shoulders level and square to the camera
        tilt = abs(lm[LM["l_shoulder"]].y - lm[LM["r_shoulder"]].y) / sh_w
        qc["shoulder_tilt"] = round(float(tilt), 2)
        if tilt > 0.18:
            issues.append("shoulders not level - stand square to the camera")

        # Does the mask actually cover the body the pose model found? Pose
        # landmarks survive low contrast that segmentation does not, so a mask
        # ending well above the ankles has lost the legs - which silently
        # inflates every circumference. Independent of landmark confidence, so
        # it holds whichever pose model is loaded.
        if len(rows):
            pose_bottom = max(lm[LM["l_ankle"]].y, lm[LM["r_ankle"]].y)
            pose_top = lm[LM["nose"]].y
            mask_bottom, mask_top = rows[-1] / h, rows[0] / h
            qc["mask_shortfall_bottom"] = round(float(pose_bottom - mask_bottom), 3)
            qc["mask_shortfall_top"] = round(float(mask_top - pose_top), 3)
            if pose_bottom - mask_bottom > 0.05:
                issues.append("silhouette is missing the legs or feet - need more contrast with the background")
            if mask_top - pose_top > 0.05:
                issues.append("silhouette is missing the head - need more contrast with the background")

    qc["issues"] = issues
    qc["usable"] = len(issues) == 0
    return {"mask": mask, "qc": qc}


def save_mask(mask: np.ndarray, out_path) -> Path:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), mask.astype(np.uint8) * 255)
    return out


if __name__ == "__main__":
    import sys
    paths = sys.argv[1:] or [ROOT / "data" / "test_photos" / "standing_front.jpg"]
    for p in paths:
        r = segment(p)
        qc, m = r["qc"], r["mask"]
        rows = np.where(m.any(axis=1))[0]
        cols = np.where(m.any(axis=0))[0]
        print(f"\n{Path(p).name}  ({m.shape[1]}x{m.shape[0]})")
        print(f"  silhouette   {qc['coverage_pct']}% of frame, "
              f"bbox {cols[-1]-cols[0]+1}x{rows[-1]-rows[0]+1} px" if len(rows) else "  empty mask")
        print(f"  pose         detected={qc['pose_detected']}"
              + (f", min visibility {qc.get('min_landmark_visibility')}, "
                 f"arm clearance {qc.get('arm_clearance')}, tilt {qc.get('shoulder_tilt')}"
                 if qc["pose_detected"] else ""))
        print(f"  usable       {qc['usable']}")
        for i in qc["issues"]:
            print(f"    - {i}")
        out = save_mask(m, ROOT / "reports" / f"mask_{Path(p).stem}.png")
        print(f"  wrote {out.relative_to(ROOT)}")
