/**
 * Bot avatars: a blob shape and a colour.
 *
 * Each shape is a single path in a 100×100 box with two eye slots placed by the
 * renderer rather than baked into the path, so eyes can blink and shift
 * independently of the body.
 *
 * The shapes are deliberately irregular. A grid of perfect circles gives a
 * person nothing to recognise a bot by, which is the whole job of the avatar in
 * a sidebar of eight.
 */

/*
 * Every shape has to carry a face.
 *
 * The eyes sit in a fixed band across the middle, so a shape only works if it
 * has body there. A first pass included a thin star and a spiky burst: both
 * looked fine empty and lost their eyes entirely once the slots went in. What
 * is left is round-ish forms with an irregular outline, which is what makes one
 * bot distinguishable from another in a sidebar.
 */
/*
 * Every shape has to carry a face, and they have to differ at 38px.
 *
 * The eyes sit in a fixed band across the middle, so a shape only works if it
 * has body there — a thin star and a spiky burst both lost their eyes entirely.
 * The second problem was sameness: fourteen soft blobs are indistinguishable in
 * a sidebar. These vary by silhouette class — lobed, angular, tall, wide,
 * notched — so the differences survive being small.
 */
export const SHAPES = [
  // four-lobed cloud
  { id: 'cloud', d: 'M50 10c12 0 21 6 25 14 10 2 17 10 17 21 0 10-6 18-15 22 0 11-9 19-21 19-6 0-12-2-16-6-5 4-12 5-18 3-10-4-15-14-12-24-8-5-12-13-10-22 2-10 11-17 21-17 5-7 12-10 29-10z' },
  // soft square
  { id: 'squircle', d: 'M30 10h40c12 0 20 8 20 20v40c0 12-8 20-20 20H30c-12 0-20-8-20-20V30c0-12 8-20 20-20z' },
  // circle, plain on purpose
  { id: 'round', d: 'M50 8a42 42 0 1 0 .1 0z' },
  // hexagon
  { id: 'hex', d: 'M50 8l36 21v42L50 92 14 71V29z' },
  // wide pebble
  { id: 'pebble', d: 'M28 22c16-8 38-7 50 5 11 11 11 29 2 41-10 13-30 19-48 15C15 79 4 64 6 48 8 34 16 27 28 22z' },
  // tall egg
  { id: 'egg', d: 'M50 6c20 0 33 20 33 43 0 25-14 43-33 43S17 74 17 49C17 26 30 6 50 6z' },
  // triangle with rounded corners
  { id: 'tri', d: 'M50 10c4 0 7 2 9 5l32 56c4 7-1 16-9 16H18c-8 0-13-9-9-16l32-56c2-3 5-5 9-5z',
    eyeY: 52 },
  // diamond
  { id: 'diamond', d: 'M50 8l38 42-38 42L12 50z', eyeY: 44 },
  // many-lobed puff
  { id: 'puff', d: 'M50 11c8 0 14 4 18 10 8-1 16 4 19 12 3 8 0 16-6 21 2 9-3 18-13 21-8 2-16-1-20-6-6 5-14 5-21 1-8-5-10-14-7-21-7-6-8-15-3-22 5-7 13-9 20-7 3-6 8-9 13-9z' },
  // tilted bean
  { id: 'bean', d: 'M38 11c17-5 36 2 44 17 8 16 3 36-11 46-13 10-32 9-44-2C15 61 11 42 18 28c4-9 11-14 20-17z' },
  // notched slab
  { id: 'slab', d: 'M28 13h44c10 0 17 8 16 18l-3 42c-1 10-9 17-18 17H33c-9 0-17-7-18-17l-3-42c-1-10 6-18 16-18z' },
  // pentagon
  { id: 'pent', d: 'M50 8l40 29-15 47H25L10 37z', eyeY: 44 },
  // sprout, one lobe lifted
  { id: 'sprout', d: 'M50 8c8 0 14 5 17 12 11 0 21 8 23 20 2 12-5 24-16 29-5 9-15 14-25 12-13-2-24-12-26-25-2-12 4-23 14-29 2-11 7-19 13-19z' },
  // apple, the one with a stem
  { id: 'apple',
    d: 'M50 24c10-8 25-7 33 3 9 11 7 29-3 43-8 11-20 19-30 19s-22-8-30-19C10 56 8 38 17 27c8-10 23-11 33-3z',
    stem: 'M50 24c-1-9 4-15 11-17', eyeY: 48 },
];

/** The colours a bot can be, in the order they appear in the picker. */
export const COLORS = [
  { id: 'ink', hex: '#1c1c1f' },
  { id: 'clay', hex: '#8b6a4a' },
  { id: 'red', hex: '#ef4444' },
  { id: 'orange', hex: '#f97316' },
  { id: 'amber', hex: '#f0a92b' },
  { id: 'green', hex: '#4ec07a' },
  { id: 'teal', hex: '#3cc0a8' },
  { id: 'blue', hex: '#3b82f6' },
  { id: 'violet', hex: '#8b5cf6' },
  { id: 'pink', hex: '#ec4899' },
  { id: 'grey', hex: '#9b9ba3' },
];

export const DEFAULT_SHAPE = 'cloud';
export const DEFAULT_COLOR = 'violet';

export function shapeById(id) {
  return SHAPES.find((s) => s.id === id) ?? SHAPES[0];
}

export function colorById(id) {
  return COLORS.find((c) => c.id === id) ?? COLORS.find((c) => c.id === DEFAULT_COLOR);
}

/**
 * Builds a bot's avatar as an SVG element.
 *
 * `state` drives the animation: 'idle' sits still, 'working' breathes and
 * blinks. The movement is on the group rather than the path so the shape itself
 * stays exact — a morphing blob reads as a rendering glitch, a breathing one
 * reads as alive.
 */
export function botAvatar(shapeId, colorId, { size = 38, state = 'idle' } = {}) {
  const shape = shapeById(shapeId);
  const color = colorById(colorId);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.classList.add('botface');
  svg.dataset.state = state;

  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.classList.add('botbody');

  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', shape.d);
  body.setAttribute('fill', color.hex);
  g.append(body);

  if (shape.stem) {
    const stem = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    stem.setAttribute('d', shape.stem);
    stem.setAttribute('stroke', '#2b2b2f');
    stem.setAttribute('stroke-width', '5');
    stem.setAttribute('stroke-linecap', 'round');
    stem.setAttribute('fill', 'none');
    g.append(stem);
  }

  // Two slots, not circles: the reference reads as a face because the eyes are
  // vertical capsules rather than dots.
  const eyes = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  eyes.classList.add('boteyes');
  // Tapered shapes (triangle, diamond) are narrow where a centred eye band
  // would sit, so each shape can push its eyes to where it has body.
  const eyeY = shape.eyeY ?? 42;
  for (const x of [39, 53]) {
    const eye = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    eye.setAttribute('x', String(x));
    eye.setAttribute('y', String(eyeY));
    eye.setAttribute('width', '8');
    eye.setAttribute('height', '18');
    eye.setAttribute('rx', '4');
    eye.setAttribute('fill', '#fff');
    eyes.append(eye);
  }
  g.append(eyes);

  svg.append(g);
  return svg;
}

/**
 * A stable shape and colour for a bot that has not chosen one.
 *
 * Both shifts are unsigned. `h >> 8` is signed, so for any hash with the high
 * bit set — about half of them — it goes negative, the modulo stays negative,
 * and the lookup returns undefined. That failed on roughly every other new bot.
 */
export function derive(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return {
    shape: SHAPES[(h >>> 0) % SHAPES.length].id,
    color: COLORS[(h >>> 8) % COLORS.length].id,
  };
}
