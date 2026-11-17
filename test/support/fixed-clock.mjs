/**
 * Pin the zone before anything builds a Date.
 *
 * The template prints times by hand in the machine's zone, with the zone
 * named, and the preview samples parse their times as local time. Without
 * this the golden files would only match on a machine in the zone of the one
 * that wrote them. It used to print with toLocaleString(), and a test still
 * checks that nothing does any more (test/prompt.test.mjs), so the locale is
 * no longer pinned.
 *
 * This has to be its own module, imported first. Imports are evaluated before
 * the importing module's body runs, so setting TZ in the test file itself
 * would come after tools/preview-prompt.mjs had already parsed its sample
 * times in the machine's zone.
 */

process.env.TZ = 'UTC';
