'use strict';

/*
 * Semantic Contour Renderer (SCR)
 *
 * Converts independently approved, source-coordinate polygon contours into
 * lossless RGBA cut-outs. It never infers anatomy from pixel topology.
 * The renderer fails closed unless every non-transparent source pixel is
 * assigned to exactly one semantic part.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SASemanticContourRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_SOURCE_PIXELS = 64000000;
  const MAX_PARTS = 500;
  const MAX_LAYERS = 2000;
  const MAX_CONTOUR_POINTS = 2048;
  const MAX_TOTAL_POINTS = 200000;
  const fail = message => { throw new Error('SemanticContourRenderer: ' + message); };
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const finite = (value, label) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(label + ' must be finite');
    return value;
  };
  const integer = (value, min, max, label) => {
    if (!Number.isInteger(value) || value < min || value > max) fail(label + ' outside supported budget');
    return value;
  };

  function pointOnSegment(p, a, b) {
    const cross = (p.y - a.y) * (b.x - a.x) - (p.x - a.x) * (b.y - a.y);
    if (Math.abs(cross) > 1e-9) return false;
    const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
    if (dot < -1e-9) return false;
    const length = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    return dot <= length + 1e-9;
  }
  function segmentsIntersect(a, b, c, d) {
    const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (((o1 > 1e-9 && o2 < -1e-9) || (o1 < -1e-9 && o2 > 1e-9)) &&
        ((o3 > 1e-9 && o4 < -1e-9) || (o3 < -1e-9 && o4 > 1e-9))) return true;
    return (Math.abs(o1) <= 1e-9 && pointOnSegment(c, a, b)) ||
      (Math.abs(o2) <= 1e-9 && pointOnSegment(d, a, b)) ||
      (Math.abs(o3) <= 1e-9 && pointOnSegment(a, c, d)) ||
      (Math.abs(o4) <= 1e-9 && pointOnSegment(b, c, d));
  }
  function normalizeRing(raw, label, source) {
    if (!isObject(raw) || !Array.isArray(raw.points) || raw.points.length < 3 ||
        raw.points.length > MAX_CONTOUR_POINTS) fail(label + ' must contain 3..' + MAX_CONTOUR_POINTS + ' points');
    const role = raw.role || 'outer';
    if (role !== 'outer' && role !== 'hole') fail(label + ' role must be outer or hole');
    const points = raw.points.map((point, index) => {
      if (!isObject(point)) fail(label + ' point ' + index + ' must be an object');
      const x = finite(point.x, label + ' point.x'), y = finite(point.y, label + ' point.y');
      if (x < 0 || y < 0 || x > source.width || y > source.height) fail(label + ' point outside source canvas');
      return { x, y };
    });
    let area2 = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) fail(label + ' has duplicate adjacent points');
      area2 += a.x * b.y - b.x * a.y;
    }
    // Reject self-intersections before the zero-area check so bow-ties receive
    // the more useful structural diagnostic; contour winding is irrelevant.
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      for (let j = i + 1; j < points.length; j++) {
        if (j === i || j === i + 1 || (i === 0 && j === points.length - 1)) continue;
        const c = points[j], d = points[(j + 1) % points.length];
        if (segmentsIntersect(a, b, c, d)) fail(label + ' self-intersects');
      }
    }
    if (Math.abs(area2) < 1e-6) fail(label + ' has zero area');
    return { role, points, bounds: {
      left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)),
      right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y))
    } };
  }
  function contains(ring, x, y) {
    const p = { x, y }, points = ring.points;
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j], b = points[i];
      if (pointOnSegment(p, a, b)) return true;
      if ((a.y > y) !== (b.y > y) &&
          x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function normalizePlan(plan, source, layerIds) {
    if (!isObject(plan) || plan.schema !== 'sa.semantic-anatomy-plan' || plan.version !== 1)
      fail('unsupported semantic anatomy plan schema');
    if (plan.status !== 'approved' || !isObject(plan.review) || plan.review.status !== 'approved' ||
        typeof plan.review.reviewerId !== 'string' || !plan.review.reviewerId.trim() ||
        typeof plan.review.reviewId !== 'string' || !plan.review.reviewId.trim())
      fail('independent anatomy approval receipt is required');
    if (!isObject(plan.source) || plan.source.width !== source.width || plan.source.height !== source.height ||
        typeof source.sha256 !== 'string' || plan.source.sha256 !== source.sha256)
      fail('plan source identity does not match the supplied source');
    if (!Array.isArray(plan.parts) || !plan.parts.length || plan.parts.length > MAX_PARTS)
      fail('semantic parts must be a bounded non-empty array');
    const ids = new Set();
    let totalPoints = 0;
    const parts = plan.parts.map((part, index) => {
      if (!isObject(part) || typeof part.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(part.id) ||
          ids.has(part.id)) fail('part ' + index + ' has an invalid or duplicate ID');
      ids.add(part.id);
      if (typeof part.label !== 'string' || !part.label.trim() || part.label.length > 120) fail('part label is invalid');
      const confidence = finite(part.confidence, 'part confidence');
      if (confidence < 0 || confidence > 1) fail('part confidence must be 0..1');
      if (!Array.isArray(part.contours) || !part.contours.length || part.contours.length > 10000)
        fail('part ' + part.id + ' requires explicit contours');
      const contours = part.contours.map((contour, ci) => {
        if (!isObject(contour) || typeof contour.layerId !== 'string' || !layerIds.has(contour.layerId))
          fail('part ' + part.id + ' contour ' + ci + ' references an unknown source layer');
        const ring = normalizeRing(contour, 'part ' + part.id + ' contour ' + ci, source);
        totalPoints += ring.points.length;
        if (totalPoints > MAX_TOTAL_POINTS) fail('total contour point budget exceeded');
        return { layerId: contour.layerId, ...ring };
      });
      return { id: part.id, label: part.label, confidence, contours };
    });
    return parts;
  }
  function renderApprovedContours({ source, plan } = {}) {
    if (!isObject(source) || !Number.isInteger(source.width) || !Number.isInteger(source.height) ||
        source.width < 1 || source.height < 1 || source.width * source.height > MAX_SOURCE_PIXELS ||
        typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256) ||
        !Array.isArray(source.layers) || !source.layers.length || source.layers.length > MAX_LAYERS)
      fail('source identity, dimensions and bounded raster layers are required');
    const layerIds = new Set();
    const layers = source.layers.map((layer, index) => {
      if (!isObject(layer) || typeof layer.id !== 'string' || !layer.id.trim() || layerIds.has(layer.id))
        fail('source layer ' + index + ' has an invalid or duplicate ID');
      layerIds.add(layer.id);
      const left = integer(layer.left, 0, source.width - 1, 'layer.left');
      const top = integer(layer.top, 0, source.height - 1, 'layer.top');
      const width = integer(layer.width, 1, source.width - left, 'layer.width');
      const height = integer(layer.height, 1, source.height - top, 'layer.height');
      const rgba = layer.rgba;
      if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4)
        fail('source layer ' + layer.id + ' must contain exact local RGBA bytes');
      return { id: layer.id, left, top, width, height, rgba };
    });
    const parts = normalizePlan(plan, source, layerIds);
    const byLayer = new Map(layers.map(layer => [layer.id, []]));
    for (const part of parts) for (const contour of part.contours) byLayer.get(contour.layerId).push({ part, contour });
    const rendered = [], layerReports = [];
    for (const layer of layers) {
      const hasVisibleAlpha = layer.rgba.some((value, index) => index % 4 === 3 && value > 0);
      if (!hasVisibleAlpha) continue;
      const assignments = byLayer.get(layer.id);
      if (!assignments.length) {
        if (layer.rgba.some((value, index) => index % 4 === 3 && value > 0))
          fail('visible source layer ' + layer.id + ' has no semantic contour assignment');
        continue;
      }
      const masks = new Map();
      const ringsByPart = new Map();
      for (const { part, contour } of assignments) {
        if (!ringsByPart.has(part.id)) ringsByPart.set(part.id, []);
        ringsByPart.get(part.id).push(contour);
      }
      const owner = new Int32Array(layer.width * layer.height);
      owner.fill(-1);
      let overlapPixels = 0;
      const partEntries = [...ringsByPart.entries()];
      for (let partIndex = 0; partIndex < partEntries.length; partIndex++) {
        const [partId, rings] = partEntries[partIndex];
        const outers = rings.filter(ring => ring.role === 'outer');
        const holes = rings.filter(ring => ring.role === 'hole');
        if (!outers.length) fail('part ' + partId + ' has holes but no outer contour on layer ' + layer.id);
        const mask = new Uint8Array(layer.width * layer.height);
        masks.set(partId, mask);
        const left = Math.max(0, Math.floor(Math.min(...outers.map(ring => ring.bounds.left)) - layer.left));
        const top = Math.max(0, Math.floor(Math.min(...outers.map(ring => ring.bounds.top)) - layer.top));
        const right = Math.min(layer.width, Math.ceil(Math.max(...outers.map(ring => ring.bounds.right)) - layer.left));
        const bottom = Math.min(layer.height, Math.ceil(Math.max(...outers.map(ring => ring.bounds.bottom)) - layer.top));
        for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
          const pixel = y * layer.width + x;
          if (!layer.rgba[pixel * 4 + 3]) continue;
          const px = layer.left + x + 0.5, py = layer.top + y + 0.5;
          const insideOuter = outers.some(ring => contains(ring, px, py));
          const insideHole = holes.some(ring => contains(ring, px, py));
          if (!insideOuter || insideHole) continue;
          mask[pixel] = 1;
          if (owner[pixel] !== -1) overlapPixels++;
          else owner[pixel] = partIndex;
        }
      }
      let sourcePixels = 0, assignedPixels = 0, missingPixels = 0;
      for (let pixel = 0; pixel < layer.width * layer.height; pixel++) {
        if (!layer.rgba[pixel * 4 + 3]) continue;
        sourcePixels++;
        if (owner[pixel] === -1) missingPixels++;
        else assignedPixels++;
      }
      if (overlapPixels || missingPixels)
        fail('layer ' + layer.id + ' contour partition failed: overlap=' + overlapPixels + ', missing=' + missingPixels);
      for (const [partId, mask] of masks) {
        const rgba = new Uint8ClampedArray(layer.rgba.length), alphaMask = new Uint8Array(mask.length);
        let pixelCount = 0, minX = layer.width, minY = layer.height, maxX = -1, maxY = -1;
        for (let pixel = 0; pixel < mask.length; pixel++) if (mask[pixel]) {
          const offset = pixel * 4;
          if (!layer.rgba[offset + 3]) continue;
          alphaMask[pixel] = 1;
          rgba[offset] = layer.rgba[offset]; rgba[offset + 1] = layer.rgba[offset + 1];
          rgba[offset + 2] = layer.rgba[offset + 2]; rgba[offset + 3] = layer.rgba[offset + 3];
          const x = pixel % layer.width, y = Math.floor(pixel / layer.width);
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
          pixelCount++;
        }
        if (pixelCount) rendered.push({ partId, layerId: layer.id, left: layer.left, top: layer.top,
          width: layer.width, height: layer.height, rgba, alphaMask, pixelCount,
          bounds: { left: minX + layer.left, top: minY + layer.top, right: maxX + layer.left + 1, bottom: maxY + layer.top + 1 } });
      }
      layerReports.push({ layerId: layer.id, sourcePixels, assignedPixels, overlapPixels, missingPixels,
        partitionExact: sourcePixels === assignedPixels && overlapPixels === 0 && missingPixels === 0 });
    }
    const expectedVisibleLayers = layers.filter(layer => layer.rgba.some((value, index) => index % 4 === 3 && value > 0)).length;
    if (layerReports.length !== expectedVisibleLayers) fail('one or more visible layers were not partitioned');
    return Object.freeze({
      schema: 'sa.semantic-contour-render', version: 1, status: 'rendered',
      source: { sha256: source.sha256.toLowerCase(), width: source.width, height: source.height },
      approval: { reviewerId: plan.review.reviewerId, reviewId: plan.review.reviewId },
      parts: rendered, layers: layerReports,
      metrics: { partLayerCount: rendered.length, sourceLayerCount: expectedVisibleLayers,
        sourcePixels: layerReports.reduce((sum, item) => sum + item.sourcePixels, 0),
        assignedPixels: layerReports.reduce((sum, item) => sum + item.assignedPixels, 0),
        overlapPixels: layerReports.reduce((sum, item) => sum + item.overlapPixels, 0),
        missingPixels: layerReports.reduce((sum, item) => sum + item.missingPixels, 0),
        exactPartition: layerReports.every(item => item.partitionExact) }
    });
  }
  return Object.freeze({ renderApprovedContours, normalizePlan });
});
