// Wheel-to-page-flip gesture detection.
//
// In paginated mode a horizontal/vertical wheel event flips the page. Touch
// surfaces like the Magic Mouse emit a long stream of tiny, low-magnitude
// wheel events for a single physical gesture (plus an inertial "momentum"
// tail), and even a light brush of the surface produces spurious deltas.
// Without filtering, every one of those events turns a page, so a single
// touch cascades into several accidental page turns.
//
// This detector mirrors what native readers (e.g. Apple Books) do for touch
// surfaces: it accumulates wheel travel, only flips once the accumulated
// distance crosses a deliberate-intent threshold, and then swallows the rest
// of the stream (the momentum tail) until the wheel goes idle — so one
// gesture flips exactly one page.
//
// A physical mouse wheel is different: every detent notch is one discrete
// event carrying the full notch travel (typically ±100px). Each such event is
// deliberate intent on its own, so it flips immediately and consecutive
// notches keep flipping — rolling N notches turns N pages. The swallow-latch
// only applies to sub-notch travel, which is what touch momentum tails are
// made of.

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** WheelEvent.deltaMode: 0 = pixel, 1 = line, 2 = page. */
  deltaMode: number;
  /** Monotonic timestamp in milliseconds. */
  timeStamp: number;
}

export interface WheelFlipResult {
  deltaX: number;
  deltaY: number;
}

export interface WheelGestureOptions {
  /** Accumulated normalized travel (px) required before a page turn fires. */
  threshold?: number;
  /** Single-event normalized travel (px) that marks the event as a discrete
   *  wheel-detent notch, which flips immediately without latching. */
  notchThreshold?: number;
  /** Idle gap (ms) after which a gesture — including its momentum tail — is
   *  considered finished and the accumulators reset. */
  idleResetMs?: number;
  /** Pixels per line, used to normalize line-mode (deltaMode 1) deltas. */
  lineHeight?: number;
  /** Pixels per page, used to normalize page-mode (deltaMode 2) deltas. */
  pageHeight?: number;
}

const DEFAULT_THRESHOLD = 30;
// Comfortably above per-event touchpad deltas, below the standard wheel
// notch (±100px in Chromium pixel mode, ±3 lines = 120px normalized
// elsewhere). A 1-line-per-notch OS setting (≈33px) falls back to the
// accumulated-threshold path.
const DEFAULT_NOTCH_THRESHOLD = 50;
const DEFAULT_IDLE_RESET_MS = 200;
const DEFAULT_LINE_HEIGHT = 40;
const DEFAULT_PAGE_HEIGHT = 800;

export const createWheelGestureDetector = (options: WheelGestureOptions = {}) => {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const notchThreshold = options.notchThreshold ?? DEFAULT_NOTCH_THRESHOLD;
  const idleResetMs = options.idleResetMs ?? DEFAULT_IDLE_RESET_MS;
  const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const pageHeight = options.pageHeight ?? DEFAULT_PAGE_HEIGHT;

  let accumX = 0;
  let accumY = 0;
  let lastTime = -Infinity;
  // True once a flip has fired for the current gesture: the remaining events
  // are the momentum tail and must be ignored until the wheel goes idle.
  let flipped = false;

  const normalize = (delta: number, mode: number) =>
    mode === 1 ? delta * lineHeight : mode === 2 ? delta * pageHeight : delta;

  /**
   * Feed one wheel sample. Returns the axis-resolved delta to flip by, or
   * `null` when the sample should not (yet) trigger a page turn.
   */
  const feed = (sample: WheelSample): WheelFlipResult | null => {
    // A gap longer than idleResetMs means the previous gesture (including any
    // inertial momentum tail) has ended — start a fresh gesture.
    if (sample.timeStamp - lastTime > idleResetMs) {
      accumX = 0;
      accumY = 0;
      flipped = false;
    }
    lastTime = sample.timeStamp;

    const normX = normalize(sample.deltaX, sample.deltaMode);
    const normY = normalize(sample.deltaY, sample.deltaMode);

    // A single event carrying a full wheel notch is a discrete detent: it is
    // deliberate intent on its own, so flip on it directly and let the next
    // notch flip again even inside the current gesture's window. Latching
    // here still swallows any sub-notch momentum that follows.
    if (Math.abs(normX) >= notchThreshold || Math.abs(normY) >= notchThreshold) {
      accumX = 0;
      accumY = 0;
      flipped = true;
      return Math.abs(normX) > Math.abs(normY)
        ? { deltaX: normX, deltaY: 0 }
        : { deltaX: 0, deltaY: normY };
    }

    // Already flipped for this gesture: swallow the momentum tail.
    if (flipped) return null;

    accumX += normX;
    accumY += normY;

    if (Math.abs(accumX) < threshold && Math.abs(accumY) < threshold) {
      return null;
    }

    flipped = true;
    // Resolve to the dominant axis so a tiny amount of cross-axis noise
    // doesn't flip in the wrong direction.
    const result: WheelFlipResult =
      Math.abs(accumX) > Math.abs(accumY)
        ? { deltaX: accumX, deltaY: 0 }
        : { deltaX: 0, deltaY: accumY };
    accumX = 0;
    accumY = 0;
    return result;
  };

  const reset = () => {
    accumX = 0;
    accumY = 0;
    lastTime = -Infinity;
    flipped = false;
  };

  return { feed, reset };
};

export type WheelGestureDetector = ReturnType<typeof createWheelGestureDetector>;
