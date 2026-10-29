/*
 * crypto-trace.js — observe symmetric crypto material at the Java layer.
 *
 * CONFIG (all optional):
 *   packages: array|null  null   caller package prefixes to report (matched
 *                                against the current stack trace); null = all
 *   maxLen:   number      256    max characters of hex/key material per value
 *
 * Hooked: javax.crypto.spec.SecretKeySpec ctors, Cipher.getInstance/doFinal,
 * MessageDigest.getInstance/digest. Instrumentation only — every hook passes
 * through to the original; failures are logged as "[open-droid] crypto-trace:
 * ..." and the script keeps running.
 */
var CONFIG = CONFIG || {};
(function () {
  function log(msg) {
    console.log("[open-droid] " + msg);
  }
  var maxLen =
    typeof CONFIG.maxLen === "number" && CONFIG.maxLen > 0 ? Math.floor(CONFIG.maxLen) : 256;
  var prefixes = Array.isArray(CONFIG.packages) ? CONFIG.packages.map(String) : null;
  function inScope() {
    if (!prefixes || prefixes.length === 0) return true;
    try {
      var throwable = Java.use("java.lang.Throwable").$new();
      var stack = Java.use("android.util.Log").getStackTraceString(throwable);
      for (var i = 0; i < prefixes.length; i++) if (stack.indexOf(prefixes[i]) !== -1) return true;
      return false;
    } catch (e) {
      return true; // stack unavailable: prefer observability over silence
    }
  }
  function hex(bytes) {
    if (bytes === null || bytes === undefined) return String(bytes);
    try {
      var out = [], limit = Math.min(bytes.length, Math.ceil(maxLen / 2));
      for (var i = 0; i < limit; i++) out.push((bytes[i] & 0xff).toString(16).padStart(2, "0"));
      return out.join("") + (bytes.length * 2 > maxLen ? "..(" + bytes.length + "B)" : "");
    } catch (e) {
      return "<unreadable bytes>";
    }
  }
  function hook(label, fn) {
    try {
      fn();
      log("crypto-trace: hooked " + label);
    } catch (e) {
      log("crypto-trace: cannot hook " + label + ": " + e);
    }
  }
  if (typeof Java === "undefined") {
    log("crypto-trace: no Java runtime in this process");
    return;
  }

  Java.perform(function () {
    hook("SecretKeySpec.$init", function () {
      var S = Java.use("javax.crypto.spec.SecretKeySpec");
      S.$init.overloads.forEach(function (overload) {
        overload.implementation = function () {
          var args = Array.prototype.slice.call(arguments);
          var algo = "<raw>", key = null, numbers = [];
          args.forEach(function (a) {
            if (typeof a === "string") algo = a;
            else if (a && typeof a.length === "number") { if (key === null) key = a; }
            else if (typeof a === "number") numbers.push(a);
          });
          var off = numbers.length ? numbers[0] : 0, len = numbers.length > 1 ? numbers[1] : -1;
          if (inScope()) {
            log("SecretKeySpec algo=" + algo + " off=" + off + " len=" + len + " key=" + hex(key));
          }
          return this.$init.apply(this, arguments);
        };
      });
    });
    hook("Cipher.getInstance(String)", function () {
      var C = Java.use("javax.crypto.Cipher");
      C.getInstance.overload("java.lang.String").implementation = function (algo) {
        if (inScope()) log("Cipher.getInstance " + algo);
        return this.getInstance(algo);
      };
    });
    hook("Cipher.doFinal([B)", function () {
      var C = Java.use("javax.crypto.Cipher");
      C.doFinal.overload("[B").implementation = function (input) {
        var algo = "?";
        try {
          algo = String(this.getAlgorithm());
        } catch (e) {}
        var out = this.doFinal(input);
        if (inScope()) log("Cipher.doFinal " + algo + " in=" + hex(input) + " out=" + hex(out));
        return out;
      };
    });
    hook("MessageDigest.getInstance(String)", function () {
      var M = Java.use("java.security.MessageDigest");
      M.getInstance.overload("java.lang.String").implementation = function (algo) {
        if (inScope()) log("MessageDigest.getInstance " + algo);
        return this.getInstance(algo);
      };
    });
    hook("MessageDigest.digest([B)", function () {
      var M = Java.use("java.security.MessageDigest");
      M.digest.overload("[B").implementation = function (input) {
        var out = this.digest(input);
        if (inScope()) log("MessageDigest.digest in=" + hex(input) + " out=" + hex(out));
        return out;
      };
    });
    hook("MessageDigest.digest()", function () {
      var M = Java.use("java.security.MessageDigest");
      M.digest.overload().implementation = function () {
        var out = this.digest();
        if (inScope()) log("MessageDigest.digest out=" + hex(out));
        return out;
      };
    });
  });
})();
