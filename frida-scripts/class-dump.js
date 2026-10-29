/*
 * class-dump.js — runtime class enumeration (truth for packed/hidden classes).
 *
 * CONFIG (all optional):
 *   regex: string  default ".*"  RegExp source tested against each loaded FQCN
 *   max:   number  default 200   hard cap on the number of classes printed
 *
 * Usage:
 *   frida -U -f <package> -l frida-scripts/class-dump.js
 *   frida -U <package> -l frida-scripts/class-dump.js \
 *     -e 'var CONFIG = {regex: "com\\.example", max: 50};'
 *
 * Output contract: every line is "[open-droid] class <fqcn>", followed by one
 * "[open-droid] class-dump: ..." summary. Failures are logged, never thrown.
 */
var CONFIG = CONFIG || {};

(function () {
  function log(msg) {
    console.log("[open-droid] " + msg);
  }

  var pattern = typeof CONFIG.regex === "string" && CONFIG.regex ? CONFIG.regex : ".*";
  var max = typeof CONFIG.max === "number" && CONFIG.max > 0 ? Math.floor(CONFIG.max) : 200;
  var re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    log("class-dump: invalid regex " + pattern + " (" + e + "), falling back to .*");
    re = /.*/;
  }

  if (typeof Java === "undefined") {
    log("class-dump: no Java runtime in this process; nothing to enumerate");
    return;
  }

  Java.perform(function () {
    var classes;
    try {
      classes = Java.enumerateLoadedClassesSync();
    } catch (e) {
      log("class-dump: Java.enumerateLoadedClassesSync failed: " + e);
      return;
    }

    var matched = 0;
    var printed = 0;
    for (var i = 0; i < classes.length; i++) {
      var name = classes[i];
      if (!re.test(name)) continue;
      matched++;
      if (printed < max) {
        log("class " + name);
        printed++;
      }
    }
    log(
      "class-dump: " + matched + " matched, " + printed + " printed, " + classes.length + " loaded",
    );
  });
})();
