// ISSUE-122: release versionCode must be explicit and validated.
//
// Git commit count is only a development fallback. It is not monotonic in
// shallow CI checkouts (actions/checkout defaults to depth 1), source archives
// have no history at all, and rebased branches can go backwards. Release tasks
// therefore fail closed unless -PversionCode or VERSION_CODE supplies a value.
import java.util.concurrent.TimeUnit

fun parseVersionCode(raw: String, source: String): Int {
    val value = raw.trim().toIntOrNull()
        ?: throw GradleException("$source must be an integer between 1 and 2100000000; got '$raw'")
    if (value <= 0 || value > 2_100_000_000) {
        throw GradleException("$source must be between 1 and 2100000000; got $value")
    }
    return value
}

fun gitCommitCount(projectDir: File): Int = runCatching {
    val probe = ProcessBuilder("git", "rev-list", "--count", "HEAD")
        .directory(projectDir)
        .redirectErrorStream(true)
        .start()
    val count = probe.inputStream.bufferedReader().use { it.readText().trim().toInt() }
    probe.waitFor(10, TimeUnit.SECONDS)
    count
}.getOrDefault(1)

val explicitVersionCode = (project.findProperty("versionCode") as String?)
    ?: providers.environmentVariable("VERSION_CODE").orNull?.takeIf { it.isNotBlank() }

val releaseRequested = gradle.startParameter.taskNames.any { name ->
    name.contains("release", ignoreCase = true)
}

val resolvedVersionCode: Int = when {
    explicitVersionCode != null -> {
        parseVersionCode(explicitVersionCode, "versionCode/VERSION_CODE")
    }
    releaseRequested -> throw GradleException(
        "Release builds require an explicit version code: pass -PversionCode=<n> or set " +
            "VERSION_CODE=<n>. Git commit count is only a development fallback and is not " +
            "monotonic in shallow clones, source archives or rebased histories.",
    )
    else -> gitCommitCount(rootDir)
}

project.extra["resolvedVersionCode"] = resolvedVersionCode
