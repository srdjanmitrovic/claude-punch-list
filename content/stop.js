/**
 * Takes down either capture controller, injected by background.js when a
 * disarm puts a stop in the page's queue.
 *
 * A file rather than a function, because of the order Chrome delivers
 * injections in: a file is read from the package before it is sent to the
 * page and a function is not, so a function stop sent straight after an arm
 * could reach the page first and leave the overlay that lands after it up.
 * Files are read in the order they were asked for, so this one runs after
 * every arm sent before it, whether or not the worker that sent it is still
 * alive by then.
 *
 * Injected repeatedly, like the capture scripts: no top level const, let or
 * class.
 */
try {
  window.__cdrRegionOverlay?.stop();
} catch {
  /* a controller from an extension context that has since gone */
}
try {
  window.__cdrElementPicker?.stop();
} catch {
  /* likewise */
}
