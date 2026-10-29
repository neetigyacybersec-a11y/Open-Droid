/*
 * hook-method.js — generic method tracer: log entry args + return value.
 *
 * CONFIG:
 *   className:   string  REQUIRED  fully-qualified Java class (no-op + warning
 *                                  if missing)
 *   methodRegex: string  ".*"      RegExp source matched against declared method
 *                                  names of className
 *   maxLen:      number  256       max characters per rendered argument/return
 *
 * Usage:
 *   frida -U -f <package> -l frida-scripts/hook-method.js \
 *     -e 'var CONFIG = {className: "com.example.Vault", methodRegex: "decrypt|encrypt"};'
 * Task 6's frida_trace_methods embeds this file with a CONFIG prelude: keep the
 * guard below and avoid top-level side effects beyond the IIFE.
 *
 * Output: "[open-droid] hook-method: <class>#<method>(args) -> <ret>" plus one
 * "hooked ..." line per method. Failures are logged, never thrown; exceptions
 * from the original method are logged and rethrown unchanged.
 */
var CONFIG = CONFIG || {};
(function () {
  function log(msg) {
    console.log("[open-droid] " + msg);
  }
  var className = typeof CONFIG.className === "string" ? CONFIG.className : "";
  var methodPattern =
    typeof CONFIG.methodRegex === "string" && CONFIG.methodRegex ? CONFIG.methodRegex : ".*";
  var maxLen =
    typeof CONFIG.maxLen === "number" && CONFIG.maxLen > 0 ? Math.floor(CONFIG.maxLen) : 256;
  if (!className) {
    log('hook-method: CONFIG.className is required (e.g. {"className": "com.example.Foo"}); no hooks');
    return;
  }
  if (typeof Java === "undefined") {
    log("hook-method: no Java runtime in this process");
    return;
  }
  function fmt(value) {
    if (value === null || value === undefined) return String(value);
    var s;
    try { s = String(value); } catch (e) { return "<unprintable>"; }
    try {
      // Frida renders Java byte[] as "[B@<hash>"; show length + truncated hex.
      if (typeof value === "object" && typeof value.length === "number" && /^\[B@/.test(s)) {
        var limit = Math.min(value.length, Math.ceil(maxLen / 2));
        var out = [];
        for (var i = 0; i < limit; i++) out.push((value[i] & 0xff).toString(16).padStart(2, "0"));
        s = "bytes[" + value.length + "] " + out.join("") + (value.length > limit ? ".." : "");
      }
    } catch (e) {}
    return s.length > maxLen ? s.slice(0, maxLen) + "...(" + s.length + ")" : s;
  }
  function install(methodName, overloads) {
    overloads.forEach(function (overload) {
      try {
        overload.implementation = function () {
          var rendered = Array.prototype.map.call(arguments, fmt).join(", ");
          log("hook-method: " + className + "#" + methodName + "(" + rendered + ")");
          var result;
          try {
            result = this[methodName].apply(this, arguments);
          } catch (e) {
            log("hook-method: " + className + "#" + methodName + " threw " + e);
            throw e;
          }
          log("hook-method: " + className + "#" + methodName + " -> " + fmt(result));
          return result;
        };
      } catch (e) {
        log("hook-method: cannot hook " + className + "#" + methodName + ": " + e);
      }
    });
  }
  Java.perform(function () {
    var re;
    try {
      re = new RegExp(methodPattern);
    } catch (e) {
      log("hook-method: invalid methodRegex " + methodPattern + " (" + e + "), using .*");
      re = /.*/;
    }
    var cls;
    try {
      cls = Java.use(className);
    } catch (e) {
      log("hook-method: class not found or not loadable: " + className + " (" + e + ")");
      return;
    }
    var declared;
    try {
      declared = cls.class.getDeclaredMethods();
    } catch (e) {
      log("hook-method: reflection failed for " + className + ": " + e);
      return;
    }
    var seen = Object.create(null);
    var count = 0;
    for (var i = 0; i < declared.length; i++) {
      var methodName;
      try {
        methodName = String(declared[i].getName());
      } catch (e) {
        continue;
      }
      if (seen[methodName] || !re.test(methodName)) continue;
      seen[methodName] = true;
      try {
        var overloads = cls[methodName].overloads;
        install(methodName, overloads);
        log("hook-method: hooked " + className + "#" + methodName + " (" + overloads.length + " overloads)");
        count++;
      } catch (e) {
        log("hook-method: cannot resolve " + className + "#" + methodName + ": " + e);
      }
    }
    log("hook-method: " + count + " method(s) hooked in " + className);
  });
})();
