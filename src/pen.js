const strokeColor = '#214794';
const walkingMetersPerMinute = 5000 / 60;

function turn(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function hullOf(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  function half(order) {
    const result = [];
    for (const point of order) {
      while (result.length >= 2 && turn(result.at(-2), result.at(-1), point) <= 0) result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  }
  return [...half(sorted), ...half(sorted.reverse())];
}

export function walkingMinutes(points) {
  if (points.length < 8) return null;

  const hull = hullOf(points);
  let diameterSquared = 0;
  for (let i = 0; i < hull.length; i += 1) {
    for (let j = i + 1; j < hull.length; j += 1) {
      const squared = (hull[i][0] - hull[j][0]) ** 2 + (hull[i][1] - hull[j][1]) ** 2;
      diameterSquared = Math.max(diameterSquared, squared);
    }
  }
  const [firstX, firstY] = points[0];
  const [lastX, lastY] = points.at(-1);
  const gap = Math.hypot(lastX - firstX, lastY - firstY);
  const diameter = Math.sqrt(diameterSquared);
  if (!diameter || gap > diameter / 4) return null;

  // Reject straight strokes doubled back on themselves and very thin loops.
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + (point[0] - firstX) * (next[1] - firstY) - (point[1] - firstY) * (next[0] - firstX);
  }, 0);
  if (Math.abs(twiceArea) < 0.25 * diameterSquared) return null;

  return diameter / walkingMetersPerMinute;
}

export function setupPen(panes, getGroundScale, onChange) {
  const [left, right] = panes.map(({ map }) => map);
  const input = left.getCanvas();
  const navigationHelp = input.getAttribute('aria-label');
  const overlays = panes.map(({ element }) => element.querySelector('.pen-overlay'));
  const strokes = [];
  let metersPerPixel = getGroundScale(left);
  let active = false;
  let current;
  let frame = 0;

  function drawStroke(context, points) {
    const [firstX, firstY] = points[0].map((value) => value / metersPerPixel);
    context.beginPath();
    if (points.length === 1) {
      context.arc(firstX, firstY, 2.5, 0, 2 * Math.PI);
      context.strokeStyle = '#fff';
      context.lineWidth = 2.5;
      context.stroke();
      context.fillStyle = strokeColor;
      context.fill();
      return;
    }

    context.moveTo(firstX, firstY);
    for (let i = 1; i < points.length; i += 1) {
      context.lineTo(points[i][0] / metersPerPixel, points[i][1] / metersPerPixel);
    }
    context.lineJoin = context.lineCap = 'round';
    context.strokeStyle = '#fff';
    context.lineWidth = 7;
    context.stroke();
    context.strokeStyle = strokeColor;
    context.lineWidth = 4;
    context.stroke();
  }

  function render() {
    frame = 0;
    const density = window.devicePixelRatio;
    for (const overlay of overlays) {
      const { width, height } = overlay.getBoundingClientRect();
      if (!width || !height) continue;

      const pixelWidth = Math.round(width * density);
      const pixelHeight = Math.round(height * density);
      if (overlay.width !== pixelWidth) overlay.width = pixelWidth;
      if (overlay.height !== pixelHeight) overlay.height = pixelHeight;
      const context = overlay.getContext('2d');
      context.resetTransform();
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.setTransform(density, 0, 0, density, pixelWidth / 2, pixelHeight / 2);
      for (const { points } of strokes) drawStroke(context, points);
      if (current) drawStroke(context, current.points);
    }
  }

  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  const resize = new ResizeObserver(scheduleRender);
  for (const overlay of overlays) resize.observe(overlay);

  function addSample(event, force = false) {
    const { clientX, clientY } = event;
    const previous = current.lastPixel;
    if (previous) {
      const change = Math.hypot(clientX - previous[0], clientY - previous[1]);
      if (change === 0 || (!force && change < 1.5)) return;
    }

    const { left: x, top: y, width, height } = input.getBoundingClientRect();
    current.points.push([
      (clientX - x - width / 2) * metersPerPixel,
      (clientY - y - height / 2) * metersPerPixel,
    ]);
    current.lastPixel = [clientX, clientY];
    scheduleRender();
  }

  function finishStroke(keep) {
    if (!current) return;
    const { pointer, points } = current;
    current = undefined;
    if (keep) strokes.push({ points, minutes: walkingMinutes(points) });
    if (input.hasPointerCapture(pointer)) input.releasePointerCapture(pointer);
    scheduleRender();
    if (keep) onChange();
  }

  input.addEventListener('pointerdown', (event) => {
    if (!active) return;
    if (!event.isPrimary && event.pointerType === 'touch') {
      // Let the map handle two-finger zooming without committing the draft.
      if (current?.type === 'touch') finishStroke(false);
      return;
    }
    if (current || event.button !== 0 || !event.isPrimary) return;

    event.preventDefault();
    left.stop();
    right.stop();
    if (!strokes.length) metersPerPixel = getGroundScale(left);
    current = { pointer: event.pointerId, type: event.pointerType, points: [] };
    input.setPointerCapture(event.pointerId);
    addSample(event);
  });
  input.addEventListener('pointermove', (event) => {
    if (current?.pointer !== event.pointerId) return;
    const samples = event.getCoalescedEvents?.();
    for (const sample of samples?.length ? samples : [event]) addSample(sample);
  });
  input.addEventListener('pointerup', (event) => {
    if (current?.pointer !== event.pointerId) return;
    addSample(event, true);
    finishStroke(true);
  });
  for (const type of ['pointercancel', 'lostpointercapture']) {
    input.addEventListener(type, (event) => {
      if (current?.pointer === event.pointerId) finishStroke(false);
    });
  }

  return {
    setActive(enabled) {
      if (enabled === active) return;
      active = enabled;
      left.getCanvasContainer().classList.toggle('pen-input', enabled);
      input.setAttribute('aria-label', enabled ? `Drag to draw. ${navigationHelp}` : navigationHelp);
      if (enabled) {
        left.dragPan.disable();
        left.boxZoom.disable();
      } else {
        finishStroke(true);
        left.dragPan.enable();
        left.boxZoom.enable();
      }
    },
    setGroundScale(scale) {
      if (metersPerPixel === scale) return;
      metersPerPixel = scale;
      if (strokes.length || current) scheduleRender();
    },
    hasStrokes: () => strokes.length > 0,
    latestEstimate: () => strokes.findLast(({ minutes }) => minutes !== null)?.minutes,
    undo() {
      strokes.pop();
      scheduleRender();
      onChange();
    },
    clear() {
      finishStroke(false);
      strokes.length = 0;
      scheduleRender();
      onChange();
    },
  };
}
