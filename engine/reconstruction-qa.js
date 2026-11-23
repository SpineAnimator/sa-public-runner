'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SAReconstructionQA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const fail = message => { throw new Error('ReconstructionQA: ' + message); };
  const isBytes = value => value instanceof Uint8Array || value instanceof Uint8ClampedArray;
  function verifyRenderedPartition({ source, rendered } = {}) {
    if (!source || !rendered || rendered.schema !== 'sa.semantic-contour-render' || rendered.version !== 1 ||
        rendered.status !== 'rendered') fail('a completed semantic contour render is required');
    if (rendered.source.sha256 !== source.sha256 || rendered.source.width !== source.width ||
        rendered.source.height !== source.height) fail('rendered source identity does not match QA source');
    if (!Array.isArray(source.layers) || !Array.isArray(rendered.parts)) fail('source layers and rendered parts are required');
    const partsByLayer = new Map();
    for (const part of rendered.parts) {
      if (!part || typeof part.layerId !== 'string' || typeof part.partId !== 'string' ||
          !Number.isInteger(part.width) || !Number.isInteger(part.height) ||
          !isBytes(part.rgba) || !isBytes(part.alphaMask) ||
          part.rgba.length !== part.width * part.height * 4 ||
          part.alphaMask.length !== part.width * part.height) fail('malformed rendered part');
      if (!partsByLayer.has(part.layerId)) partsByLayer.set(part.layerId, []);
      partsByLayer.get(part.layerId).push(part);
    }
    const layerReports = [];
    let sourcePixels = 0, reconstructedPixels = 0, mismatchPixels = 0, overlapPixels = 0, missingPixels = 0;
    for (const layer of source.layers) {
      if (!layer || typeof layer.id !== 'string' || !Number.isInteger(layer.width) ||
          !Number.isInteger(layer.height) || !isBytes(layer.rgba) ||
          layer.rgba.length !== layer.width * layer.height * 4) fail('malformed source layer');
      const parts = partsByLayer.get(layer.id) || [];
      for (const part of parts) {
        if (part.width !== layer.width || part.height !== layer.height ||
            part.left !== layer.left || part.top !== layer.top) fail('part geometry does not match source layer ' + layer.id);
      }
      const reconstructed = new Uint8ClampedArray(layer.rgba.length);
      const ownership = new Uint8Array(layer.width * layer.height);
      let layerSourcePixels = 0, layerReconstructedPixels = 0, layerMismatchPixels = 0;
      let layerOverlapPixels = 0, layerMissingPixels = 0;
      for (const part of parts) {
        for (let pixel = 0; pixel < ownership.length; pixel++) {
          const mask = part.alphaMask[pixel];
          if (mask !== 0 && mask !== 1) fail('alpha mask must be binary for ' + part.partId);
          if (!mask) continue;
          const offset = pixel * 4;
          if (!part.rgba[offset + 3]) fail('mask includes a fully transparent pixel in ' + part.partId);
          if (ownership[pixel]) layerOverlapPixels++;
          else {
            ownership[pixel] = 1;
            reconstructed.set(part.rgba.subarray(offset, offset + 4), offset);
          }
        }
      }
      for (let pixel = 0; pixel < ownership.length; pixel++) {
        const offset = pixel * 4, visible = layer.rgba[offset + 3] > 0;
        if (!visible) {
          if (ownership[pixel]) layerMismatchPixels++;
          continue;
        }
        layerSourcePixels++;
        if (!ownership[pixel]) { layerMissingPixels++; continue; }
        layerReconstructedPixels++;
        for (let channel = 0; channel < 4; channel++) {
          if (reconstructed[offset + channel] !== layer.rgba[offset + channel]) {
            layerMismatchPixels++; break;
          }
        }
      }
      sourcePixels += layerSourcePixels;
      reconstructedPixels += layerReconstructedPixels;
      mismatchPixels += layerMismatchPixels;
      overlapPixels += layerOverlapPixels;
      missingPixels += layerMissingPixels;
      layerReports.push({ layerId: layer.id, sourcePixels: layerSourcePixels,
        reconstructedPixels: layerReconstructedPixels, mismatchPixels: layerMismatchPixels,
        overlapPixels: layerOverlapPixels, missingPixels: layerMissingPixels,
        pixelExact: layerMismatchPixels === 0 && layerOverlapPixels === 0 && layerMissingPixels === 0 &&
          layerSourcePixels === layerReconstructedPixels });
    }
    for (const layerId of partsByLayer.keys()) {
      if (!source.layers.some(layer => layer.id === layerId)) fail('rendered output contains unknown source layer ' + layerId);
    }
    const pixelExact = mismatchPixels === 0 && overlapPixels === 0 && missingPixels === 0 &&
      sourcePixels === reconstructedPixels && layerReports.every(layer => layer.pixelExact);
    return Object.freeze({ schema: 'sa.reconstruction-qa', version: 1,
      status: pixelExact ? 'pass' : 'fail', pixelExact,
      source: { sha256: source.sha256, width: source.width, height: source.height },
      metrics: { sourcePixels, reconstructedPixels, mismatchPixels, overlapPixels, missingPixels },
      layers: layerReports,
      scope: { verifies: 'exact visible RGBA pixel preservation within each source layer',
        doesNotVerify: ['Photoshop native composite parity', 'anatomical correctness', 'Spine 4.3 import'] } });
  }
  return Object.freeze({ verifyRenderedPartition });
});
