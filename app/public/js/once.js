/**
 * Memoise an async step, but never memoise a failure.
 *
 * The app loads its models in three groups, each fetched the first time
 * something needs it. A plain cached promise would be wrong: if a background
 * warm-up happened to run while the network was down, every later caller would
 * be handed the same rejected promise forever and the camera would stay broken
 * until a reload. Dropping the cache on failure means the next caller retries.
 *
 * Concurrent callers still share one in-flight attempt, which is the whole
 * point - four callers must not start four downloads of the same 15 MB model.
 */
export const once = (name, fn, mark = n => performance.mark(`bodycomp:${n}`)) => {
  let p = null;
  return () => (p ||= fn()
    .then(v => { mark(name); return v; })
    .catch(err => { p = null; throw err; }));
};
