/*
 * root-bypass.js — hide common root indicators from Java-layer checks.
 *
 * CONFIG (optional):
 *   fakePaths: array  default ["/system/bin/su", "/system/xbin/su", "/sbin/magisk"]
 *              Paths to hide. Any path equal to an entry, nested under it, or
 *              sharing its basename (e.g. any ".../su") is reported as absent.
 *
 * What it does: java.io.File.exists/isFile/isDirectory/canRead/canExecute
 * return false for the configured root paths; Runtime.exec(...) logs and blocks
 * commands that reference su/magisk, returning a process that exits 1 instead.
 *
 * Output: "[open-droid] root-bypass: ..." per hidden check and per failure.
 * Limitations: native checks, SafetyNet/Play Integrity attestations and
 * PackageManager queries for Magisk are not covered here.
 */
var CONFIG = CONFIG || {};
(function () {
  function log(msg) {
    console.log("[open-droid] " + msg);
  }
  var fake = Array.isArray(CONFIG.fakePaths) ? CONFIG.fakePaths.map(String) : [];
  if (!fake.length) fake = ["/system/bin/su", "/system/xbin/su", "/sbin/magisk"];
  var fakeBases = {};
  fake.forEach(function (p) {
    var base = p.replace(/\/+$/, "").replace(/^.*\//, "");
    if (base) fakeBases[base] = true;
  });
  function isFakePath(path) {
    if (!path) return false;
    var p = String(path).replace(/\/+$/, "");
    for (var i = 0; i < fake.length; i++) {
      var entry = fake[i].replace(/\/+$/, "");
      if (p === entry || p.indexOf(entry + "/") === 0) return true;
    }
    var base = p.substring(p.lastIndexOf("/") + 1);
    return fakeBases[base] === true;
  }
  function commandOf(value) {
    try {
      if (typeof value === "object" && value !== null && typeof value.length === "number") {
        return Array.prototype.join.call(value, " ");
      }
    } catch (e) {
      return "";
    }
    return value === null || value === undefined ? "" : String(value);
  }
  function isRootCommand(cmd) {
    return /(^|[\s/;"'])(su|magisk|magiskhide|supersu)([\s;"']|$)/.test(String(cmd).toLowerCase());
  }
  if (typeof Java === "undefined") {
    log("root-bypass: no Java runtime in this process");
    return;
  }
  Java.perform(function () {
    var File;
    try {
      File = Java.use("java.io.File");
    } catch (e) {
      log("root-bypass: java.io.File unavailable: " + e);
    }
    if (File) {
      ["exists", "isFile", "isDirectory", "canRead", "canExecute"].forEach(function (method) {
        try {
          File[method].implementation = function () {
            var path;
            try {
              path = String(this.getAbsolutePath());
            } catch (e) {
              path = String(this);
            }
            if (isFakePath(path)) {
              log("hidden File." + method + "(" + path + ")");
              return false;
            }
            return this[method]();
          };
        } catch (e) {
          log("root-bypass: File." + method + " hook failed: " + e);
        }
      });
    }
    try {
      var Runtime = Java.use("java.lang.Runtime");
      var execArray = null;
      try {
        execArray = Runtime.exec.overload("[Ljava.lang.String;");
      } catch (e) {
        log("root-bypass: Runtime.exec(String[]) not available: " + e);
      }
      Runtime.exec.overloads.forEach(function (overload) {
        try {
          overload.implementation = function () {
            var cmd = commandOf(arguments.length ? arguments[0] : null);
            if (isRootCommand(cmd)) {
              log("blocked exec: " + cmd);
              if (execArray) {
                try {
                  return execArray.call(
                    this,
                    Java.array("java.lang.String", ["/system/bin/sh", "-c", "exit 1"]),
                  );
                } catch (e) {
                  log("root-bypass: fake exec failed: " + e);
                }
              }
            }
            return this.exec.apply(this, arguments);
          };
        } catch (e) {
          log("root-bypass: Runtime.exec hook failed: " + e);
        }
      });
    } catch (e) {
      log("root-bypass: java.lang.Runtime unavailable: " + e);
    }
  });
})();
