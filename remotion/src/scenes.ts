export const FPS = 30;
export const TRANSITION = 16; // frames of cross-over between shots

export type Move = {
  scale: [number, number];
  x?: [number, number];
  y?: [number, number];
};

export type Shot = {
  kind: "photo";
  src: string;
  dur: number;
  move: Move;
  portrait?: boolean;
  /** vertical tilt through the image, 0 = top, 1 = bottom */
  tilt?: [number, number];
  aspect?: number;
  chapter?: string;
  caption: string;
};

export type Clip = {
  kind: "video";
  dur: number;
  startAt: number;
  title?: boolean;
  outro?: boolean;
};

export type Scene = Shot | Clip;

const land = (
  src: string,
  dur: number,
  move: Move,
  caption: string,
  chapter?: string,
): Shot => ({ kind: "photo", src: `img/${src}`, dur, move, caption, chapter });

const port = (
  src: string,
  dur: number,
  zoom: [number, number],
  tilt: [number, number],
  caption: string,
  chapter?: string,
): Shot => ({
  kind: "photo",
  src: `img/${src}`,
  dur,
  move: { scale: zoom },
  tilt,
  aspect: 0.75,
  caption,
  chapter,
  portrait: true,
});

export const SCENES: Scene[] = [
  // ── Opening: drone over the property ──
  { kind: "video", dur: 4.6, startAt: 0.2, title: true },

  // ── Arrival ──
  land("reception.jpg", 2.6, { scale: [1.05, 1.18], y: [1.5, -2] }, "Reception", "Arrival"),

  // ── The Rooms ──
  land("std-room-1.jpg", 2.4, { scale: [1.16, 1.04], x: [3, -3] }, "Deluxe Standard", "The Rooms"),
  land("sdlx-1.jpg", 2.3, { scale: [1.04, 1.16], y: [2, -1.5] }, "Superior Deluxe"),
  land("twin-1.jpg", 2.3, { scale: [1.16, 1.05], x: [-3, 2.5] }, "Superior Twin"),
  land("comfort-1.jpg", 2.2, { scale: [1.05, 1.16], y: [-1.5, 2] }, "Comfort Room"),
  port("std-bath.jpg", 2.3, [1.0, 1.06], [0.24, 0.68], "En-suite Bathroom"),

  // ── Suites & Residences ──
  port("ob-1.jpg", 2.5, [1.0, 1.06], [0.68, 0.24], "Apartment Living", "Suites & Residences"),
  port("ob-2.jpg", 2.3, [1.06, 1.0], [0.28, 0.7], "Kitchen & Dining"),
  port("ob-4.jpg", 2.3, [1.0, 1.06], [0.66, 0.26], "The Lounge"),
  land("ph-living.jpg", 2.5, { scale: [1.16, 1.04], x: [-3, 3] }, "Penthouse"),
  port("ph-parlor.jpg", 2.4, [1.0, 1.06], [0.3, 0.72], "Penthouse Parlour"),
  port("ph-bedroom.jpg", 2.3, [1.06, 1.0], [0.62, 0.24], "Penthouse Bedroom"),

  // ── Outside ──
  port("apt-balcony.jpg", 2.4, [1.0, 1.06], [0.22, 0.66], "Private Balcony", "Outside"),

  // ── Closing: drone pulls back over Freetown ──
  { kind: "video", dur: 4.4, startAt: 27.4, outro: true },
];

export const totalFrames = () => {
  const raw = SCENES.reduce((acc, sc) => acc + Math.round(sc.dur * FPS), 0);
  return raw - TRANSITION * (SCENES.length - 1);
};
