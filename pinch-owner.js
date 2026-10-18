export const INDEX_PINCH_START = .25;
export const INDEX_PINCH_END = .35;
export const MIDDLE_PINCH_START = .24;
export const MIDDLE_PINCH_END = .40;
const DISTINCT_PINCH_MARGIN = .10;

// Both gestures use the same thumb. Decide once which fingertip owns contact,
// and require release before a doubtful contact can become another action.
export function createPinchOwner() {
  let owner = "none";
  let releasedOwner = null;
  function reset() { owner = "none"; releasedOwner = null; }
  function update({ indexRatio, middleRatio, present = true, enabled = true } = {}) {
    if (!enabled || !present || ![indexRatio, middleRatio].every(Number.isFinite)) {
      reset(); return owner;
    }
    const released = indexRatio >= INDEX_PINCH_END && middleRatio >= MIDDLE_PINCH_END;
    if (released) { reset(); return owner; }
    const clearlyCloser = (near, far) => near + DISTINCT_PINCH_MARGIN < far && near < far * .65;
    if (owner === "ambiguous") return owner;
    if (owner === "release") {
      // Repeating the same gesture only needs its own visible release. A
      // different finger must wait for both contacts to open first.
      if (releasedOwner === "index" && indexRatio < INDEX_PINCH_START && clearlyCloser(indexRatio, middleRatio)) owner = "index";
      else if (releasedOwner === "middle" && middleRatio < MIDDLE_PINCH_START && clearlyCloser(middleRatio, indexRatio)) owner = "middle";
      return owner;
    }
    if (owner === "index") {
      if (indexRatio >= INDEX_PINCH_END) { releasedOwner = owner; owner = "release"; }
      return owner;
    }
    if (owner === "middle") {
      if (middleRatio >= MIDDLE_PINCH_END) { releasedOwner = owner; owner = "release"; }
      return owner;
    }
    const indexContact = indexRatio < INDEX_PINCH_START;
    const middleContact = middleRatio < MIDDLE_PINCH_START;
    if (!indexContact && !middleContact) return owner;
    if (indexContact && clearlyCloser(indexRatio, middleRatio)) owner = "index";
    else if (middleContact && clearlyCloser(middleRatio, indexRatio)) owner = "middle";
    else owner = "ambiguous";
    return owner;
  }
  return { update, reset };
}

export const DRAWING_MOVEMENT_GAIN = .82;

// Scale displacement from a fixed stroke anchor, so a stationary finger never
// causes delayed catch-up. Hovering and region selection keep their full reach.
export function createDrawingGain(gain = DRAWING_MOVEMENT_GAIN) {
  let anchor = null;
  const clamp = value => Math.max(0, Math.min(1, value));
  return {
    reset() { anchor = null; },
    map(point) {
      if (!anchor) anchor = { x: point.x, y: point.y, outputX: clamp(point.x), outputY: clamp(point.y) };
      return { x: clamp(anchor.outputX + (point.x - anchor.x) * gain), y: clamp(anchor.outputY + (point.y - anchor.y) * gain) };
    }
  };
}
