const rest = { x: 0, y: 0, angle: 0 };
const rotationStep = Math.PI / 12;

export function sketchBounds(strokes) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const { points } of strokes) {
    for (const [x, y] of points) {
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }

  return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
}

export function setupSketchAdjustment(input, viewport, getScale, redraw, commit) {
  const outline = document.createElement('div');
  outline.className = 'sketch-selection';
  outline.setAttribute('aria-hidden', 'true');
  outline.hidden = true;
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'sketch-rotation';
  handle.title = 'Drag to rotate the sketch';
  handle.setAttribute('aria-label', 'Rotate sketch');
  handle.hidden = true;
  viewport.append(outline, handle);

  let bounds;
  let gesture;
  let change = rest;

  function groundPoint(event) {
    const rect = input.getBoundingClientRect();
    const scale = getScale();
    return [
      (event.clientX - rect.left - rect.width / 2) * scale,
      (event.clientY - rect.top - rect.height / 2) * scale,
    ];
  }

  function angleAt([x, y]) {
    return Math.atan2(y - bounds.y, x - bounds.x);
  }

  function start(event) {
    if (!bounds) return;
    if (event.pointerType === 'touch' && !event.isPrimary) {
      if (gesture?.pointerType === 'touch') finish(false);
      return;
    }
    if (gesture || !event.isPrimary || event.button !== 0) return;
    const target = event.currentTarget;
    const origin = groundPoint(event);
    gesture = { id: event.pointerId, pointerType: event.pointerType, target, origin };
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    input.classList.add('adjusting');
  }

  function move(event) {
    if (!gesture || event.pointerId !== gesture.id) return;
    const point = groundPoint(event);
    if (gesture.target === handle) {
      change = { ...rest, angle: angleAt(point) - angleAt(gesture.origin) };
    } else {
      change = { ...rest, x: point[0] - gesture.origin[0], y: point[1] - gesture.origin[1] };
    }
    redraw();
  }

  function finish(keep) {
    if (!gesture) return;
    const { target, id } = gesture;
    const completed = change;
    gesture = undefined;
    change = rest;
    input.classList.remove('adjusting');
    if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
    if (keep) apply(completed);
    redraw();
  }

  function apply({ x, y, angle }) {
    if (!x && !y && !angle) return;
    const { x: centerX, y: centerY } = bounds;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    commit(([px, py]) => [
      centerX + x + (px - centerX) * cos - (py - centerY) * sin,
      centerY + y + (px - centerX) * sin + (py - centerY) * cos,
    ]);
  }

  for (const target of [input, handle]) {
    target.addEventListener('pointerdown', start);
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', (event) => {
      if (event.pointerId !== gesture?.id) return;
      move(event);
      finish(true);
    });
    for (const type of ['pointercancel', 'lostpointercapture']) {
      target.addEventListener(type, (event) => {
        if (event.pointerId === gesture?.id) finish(false);
      });
    }
  }

  input.addEventListener('keydown', (event) => {
    if (!bounds || gesture) return;
    const step = 10 * getScale();
    const x = (Number(event.key === 'ArrowRight') - Number(event.key === 'ArrowLeft')) * step;
    const y = (Number(event.key === 'ArrowDown') - Number(event.key === 'ArrowUp')) * step;
    if (!x && !y) return;
    event.preventDefault();
    event.stopPropagation();
    apply({ ...rest, x, y });
  });
  handle.addEventListener('keydown', (event) => {
    if (!bounds || gesture) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    apply({ ...rest, angle: event.key === 'ArrowLeft' ? -rotationStep : rotationStep });
  });
  handle.addEventListener('click', (event) => {
    if (bounds && !gesture && event.detail === 0) apply({ ...rest, angle: rotationStep });
  });

  return {
    setBounds(next) {
      finish(false);
      bounds = next;
      outline.hidden = handle.hidden = !bounds;
    },
    applyPreview(context, scale) {
      if (!gesture) return;
      context.translate((bounds.x + change.x) / scale, (bounds.y + change.y) / scale);
      context.rotate(change.angle);
      context.translate(-bounds.x / scale, -bounds.y / scale);
    },
    renderControls(width, height, scale) {
      if (!bounds) return;
      const x = width / 2 + (bounds.x + change.x) / scale;
      const y = height / 2 + (bounds.y + change.y) / scale;
      const selectionWidth = Math.max(14, bounds.width / scale + 10);
      const selectionHeight = Math.max(14, bounds.height / scale + 10);
      outline.style.left = `${x - selectionWidth / 2}px`;
      outline.style.top = `${y - selectionHeight / 2}px`;
      outline.style.width = `${selectionWidth}px`;
      outline.style.height = `${selectionHeight}px`;
      outline.style.transform = `rotate(${change.angle}rad)`;

      const distance = selectionHeight / 2 + 27;
      const handleX = x + Math.sin(change.angle) * distance;
      const handleY = y - Math.cos(change.angle) * distance;
      handle.style.left = `${Math.max(22, Math.min(width - 22, handleX))}px`;
      handle.style.top = `${Math.max(22, Math.min(height - 22, handleY))}px`;
    },
  };
}
