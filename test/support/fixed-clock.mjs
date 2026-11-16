/**
 * Pin the zone and the locale before anything builds a Date.
 *
 * The template prints times with toLocaleString(), which follows the machine,
 * and the preview samples parse their times as local time. Without this the
 * golden files would only match on a machine set up like the one that wrote
 * them.
 *
 * This has to be its own module, imported first. Imports are evaluated before
 * the importing module's body runs, so setting TZ in the test file itself
 * would come after tools/preview-prompt.mjs had already parsed its sample
 * times in the machine's zone.
 */

process.env.TZ = 'UTC';

const toLocaleString = Date.prototype.toLocaleString;
Date.prototype.toLocaleString = function (locales, options) {
  return toLocaleString.call(this, locales ?? 'en-US', options);
};
