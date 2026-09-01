// Gradient-boosted tree inference in the browser.
//
// Reads the compact binary written by src/export_web_models.py. Each section is
// copied out with slice() rather than viewed in place: float64 sections are not
// guaranteed 8-byte aligned in the packed file, and a misaligned TypedArray view
// throws.

export function loadModel(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const numTrees = dv.getInt32(0, true);
  const numInternal = dv.getInt32(4, true);
  const numLeaves = dv.getInt32(8, true);

  let o = 12;
  const take = (Type, n) => {
    const bytes = n * Type.BYTES_PER_ELEMENT;
    const a = new Type(arrayBuffer.slice(o, o + bytes));
    o += bytes;
    return a;
  };
  const roots = take(Int32Array, numTrees);
  const feature = take(Int16Array, numInternal);
  const threshold = take(Float64Array, numInternal);
  const left = take(Int32Array, numInternal);
  const right = take(Int32Array, numInternal);
  const defaultLeft = take(Uint8Array, numInternal);
  const leafValue = take(Float64Array, numLeaves);

  if (o !== arrayBuffer.byteLength) {
    throw new Error(`model size mismatch: read ${o} of ${arrayBuffer.byteLength} bytes`);
  }
  return { numTrees, roots, feature, threshold, left, right, defaultLeft, leafValue };
}

// x is a plain array indexed the same way the model was trained.
export function predict(model, x) {
  const { numTrees, roots, feature, threshold, left, right, defaultLeft, leafValue } = model;
  let sum = 0;
  for (let t = 0; t < numTrees; t++) {
    let node = roots[t];
    while (node >= 0) {
      const v = x[feature[node]];
      // NaN follows the training-time default direction, matching LightGBM
      const goLeft = Number.isNaN(v) ? defaultLeft[node] === 1 : v <= threshold[node];
      node = goLeft ? left[node] : right[node];
    }
    sum += leafValue[-node - 1];
  }
  return sum;
}
