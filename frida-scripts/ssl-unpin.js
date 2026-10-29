/*
 * ssl-unpin.js — best-effort Java-layer certificate-pinning bypass.
 *
 * CONFIG: none. The script is safe to run on any Java app; absent libraries are
 * reported and skipped.
 *
 * What it does (each step independently try/catch'ed):
 *   1. Replaces checkServerTrusted/checkClientTrusted on every loaded
 *      X509TrustManager implementation with a no-op.
 *   2. Neutralises okhttp3.CertificatePinner.check and OkHostnameVerifier.verify.
 *   3. Installs a trust-all SSLContext as the JVM default.
 *   4. Ignores HttpsURLConnection.setSSLSocketFactory / setDefaultSSLSocketFactory
 *      and hostname-verifier overrides.
 *
 * Output: "[open-droid] ssl-unpin: ..." per bypass and per failure. This is not
 * universal: native pinning (BoringSSL/Flutter) and Network Security Config
 * pins need a native hook or a patched manifest. Failures never abort the script.
 */
var CONFIG = CONFIG || {};

(function () {
  function log(msg) {
    console.log("[open-droid] " + msg);
  }
  function safe(label, fn) {
    try {
      return fn();
    } catch (e) {
      log("ssl-unpin: " + label + " failed: " + e);
      return null;
    }
  }
  if (typeof Java === "undefined") {
    log("ssl-unpin: no Java runtime in this process");
    return;
  }
  Java.perform(function () {
    // 1. Patch every already-loaded TrustManager implementation.
    function patchTrustManager(name) {
      var cls = safe("Java.use(" + name + ")", function () {
        return Java.use(name);
      });
      if (!cls) return;
      ["checkServerTrusted", "checkClientTrusted"].forEach(function (method) {
        safe(name + "." + method, function () {
          cls[method].overloads.forEach(function (overload) {
            overload.implementation = function () {
              log("trust-all " + name + "." + method);
            };
          });
        });
      });
    }
    safe("enumerateLoadedClasses", function () {
      var loaded = Java.enumerateLoadedClassesSync();
      loaded.forEach(function (name) {
        if (/TrustManager/i.test(name)) patchTrustManager(name);
      });
    });
    // 2. OkHttp pinner + hostname verifier.
    safe("okhttp3.CertificatePinner.check", function () {
      var Pinner = Java.use("okhttp3.CertificatePinner");
      Pinner.check.overloads.forEach(function (overload) {
        overload.implementation = function () {
          log("bypass CertificatePinner.check");
        };
      });
      log("okhttp3.CertificatePinner neutralised");
    });
    safe("okhttp3 OkHostnameVerifier.verify", function () {
      var Verifier = Java.use("okhttp3.internal.tls.OkHostnameVerifier");
      Verifier.verify.overloads.forEach(function (overload) {
        overload.implementation = function () {
          log("bypass OkHostnameVerifier.verify");
          return true;
        };
      });
    });
    // 3. Trust-all default SSLContext.
    safe("trust-all SSLContext", function () {
      var X509TrustManager = Java.use("javax.net.ssl.X509TrustManager");
      var TrustAll = Java.registerClass({
        name: "com.open_droid.TrustAllManager",
        implements: [X509TrustManager],
        methods: {
          checkClientTrusted: function (chain, authType) {},
          checkServerTrusted: function (chain, authType) {},
          getAcceptedIssuers: function () {
            return Java.array("java.security.cert.X509Certificate", []);
          },
        },
      });
      var SSLContext = Java.use("javax.net.ssl.SSLContext");
      var ctx = SSLContext.getInstance("TLS");
      ctx.init(null, Java.array("javax.net.ssl.TrustManager", [TrustAll.$new()]), null);
      SSLContext.setDefault(ctx);
      log("installed trust-all default SSLContext");
    });
    // 4. HttpsURLConnection factory/verifier overrides become no-ops.
    safe("HttpsURLConnection hooks", function () {
      var Https = Java.use("javax.net.ssl.HttpsURLConnection");
      ["setSSLSocketFactory", "setDefaultSSLSocketFactory"].forEach(function (method) {
        Https[method].overloads.forEach(function (overload) {
          overload.implementation = function () {
            log("ignored HttpsURLConnection." + method);
          };
        });
      });
      ["setHostnameVerifier", "setDefaultHostnameVerifier"].forEach(function (method) {
        Https[method].overloads.forEach(function (overload) {
          overload.implementation = function () {
            log("ignored HttpsURLConnection." + method);
          };
        });
      });
      log("HttpsURLConnection overrides disabled");
    });
  });
})();
