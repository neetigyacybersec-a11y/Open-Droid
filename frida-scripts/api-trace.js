/*
 * api-trace.js — app-layer request observation (complements mitmproxy).
 *
 * CONFIG (optional):
 *   hosts: array|null  default null   hostnames (or parent domains) to report;
 *                                     null/[] = every host. Matching is
 *                                     case-insensitive and suffix-aware
 *                                     ("example.com" also matches "api.example.com").
 *
 * Hooked layers:
 *   - okhttp3.Request$Builder.build()  -> method + URL
 *   - java.net.URL.openConnection()    -> URL
 *   - java.net.Socket.connect(...)     -> remote address (IP only: hostnames are
 *                                         resolved before this layer)
 *
 * Output: "[open-droid] api-trace: <layer> <METHOD|-> <url|addr>" lines. Every
 * hook passes the original call through; failures are logged, never thrown.
 */
var CONFIG = CONFIG || {};

(function () {
  function log(msg) {
    console.log("[open-droid] " + msg);
  }

  var hosts = Array.isArray(CONFIG.hosts) && CONFIG.hosts.length ? CONFIG.hosts.map(String) : null;

  function wanted(host) {
    if (!hosts) return true;
    var h = String(host || "").toLowerCase();
    if (!h) return false;
    for (var i = 0; i < hosts.length; i++) {
      var want = hosts[i].toLowerCase();
      if (h === want || h.slice(-(want.length + 1)) === "." + want) return true;
    }
    return false;
  }

  function hostOf(url) {
    try {
      var rest = String(url).split("://")[1] || "";
      return rest.split("/")[0].split("?")[0].split("@").pop().split(":")[0];
    } catch (e) {
      return "";
    }
  }

  function clip(value, limit) {
    var s = String(value);
    return s.length > limit ? s.slice(0, limit) + "..." : s;
  }

  if (typeof Java === "undefined") {
    log("api-trace: no Java runtime in this process");
    return;
  }

  Java.perform(function () {
    try {
      var Builder = Java.use("okhttp3.Request$Builder");
      Builder.build.implementation = function () {
        var request = this.build();
        try {
          var url = String(request.url().toString());
          if (wanted(hostOf(url))) {
            log("api-trace: okhttp " + request.method() + " " + clip(url, 200));
          }
        } catch (e) {
          log("api-trace: okhttp request log failed: " + e);
        }
        return request;
      };
      log("api-trace: hooked okhttp3.Request$Builder.build");
    } catch (e) {
      log("api-trace: okhttp3 not present (" + e + ")");
    }

    try {
      var URL = Java.use("java.net.URL");
      URL.openConnection.overload().implementation = function () {
        try {
          var u = String(this.toString());
          if (wanted(hostOf(u))) log("api-trace: url - " + clip(u, 200));
        } catch (e) {
          log("api-trace: URL log failed: " + e);
        }
        return this.openConnection();
      };
      log("api-trace: hooked java.net.URL.openConnection");
    } catch (e) {
      log("api-trace: java.net.URL hook failed (" + e + ")");
    }

    try {
      var Socket = Java.use("java.net.Socket");
      Socket.connect.overload("java.net.SocketAddress").implementation = function (address) {
        try {
          var addr = String(address);
          var host = addr.replace(/^.*\//, "").replace(/:\d+$/, "");
          if (wanted(host)) log("api-trace: socket - " + clip(addr, 200));
        } catch (e) {
          log("api-trace: socket log failed: " + e);
        }
        return this.connect(address);
      };
      log("api-trace: hooked java.net.Socket.connect");
    } catch (e) {
      log("api-trace: java.net.Socket hook failed (" + e + ")");
    }
  });
})();
