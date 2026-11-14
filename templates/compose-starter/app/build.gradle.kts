import java.util.Properties
import java.util.concurrent.TimeUnit
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    // FR-B2 slice 2: verify/record tasks + comparison mode for Roborazzi goldens.
    id("io.github.takahirom.roborazzi") version "1.41.0"
}

// ---- FR-B3 signing + versioning scaffold ----
// versionCode comes from this project's git history, so it climbs monotonically
// across releases; 1 when there is no history (fresh scaffold before first commit).
val gitCommitCount: Int = runCatching {
    val probe = ProcessBuilder("git", "rev-list", "--count", "HEAD")
        .directory(rootDir)
        .redirectErrorStream(true)
        .start()
    val count = probe.inputStream.bufferedReader().use { it.readText().trim().toInt() }
    probe.waitFor(10, TimeUnit.SECONDS)
    count
}.getOrDefault(1)

// keystore.properties is gitignored and supplies storeFile, storePassword,
// keyAlias and keyPassword for the release signing config.
val keystoreProps = Properties()
val keystorePropsFile = rootProject.file("keystore.properties")
val hasReleaseKeystore = keystorePropsFile.exists()
if (hasReleaseKeystore) {
    keystorePropsFile.inputStream().use { keystoreProps.load(it) }
}

android {
    namespace = "com.example.starter"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.starter"
        minSdk = 26
        targetSdk = 35
        versionCode = gitCommitCount
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Robolectric needs these generated app resources + config to build; without it the
        // manifest/package bridge (test_config.properties) is never generated (issue #4736 family).
        testOptions.unitTests.isIncludeAndroidResources = true
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
    }
}

// Fail closed: a release task without a signing config would silently produce an
// unsigned artifact (APK or AAB). Stop at task-graph time with a message naming
// what is missing.
gradle.taskGraph.whenReady {
    if (!hasReleaseKeystore) {
        val releaseTasks = allTasks.filter {
            it.name.startsWith("assembleRelease") ||
                it.name.startsWith("signingRelease") ||
                it.name.startsWith("uploadRelease") ||
                it.name.startsWith("bundleRelease")
        }
        if (releaseTasks.isNotEmpty()) {
            throw GradleException(
                "keystore.properties is missing in the project root — release tasks would produce an unsigned release artifact (APK/AAB). " +
                    "Add keystore.properties (storeFile, storePassword, keyAlias, keyPassword) or run assembleDebug."
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    // FR-B2 / §11.10: JVM Compose tests run offline via Robolectric; instrumented
    // Compose tests compile now and run on a device in CI (FR-B6).
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("androidx.test.ext:junit:1.2.1")
    testImplementation(platform("androidx.compose:compose-bom:2024.11.00"))
    testImplementation("androidx.compose.ui:ui-test-junit4:1.7.5")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.11.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4:1.7.5")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    // FR-B2 slice 2: screenshot + a11y layers (Roborazzi). Goldens commit under
    // app/src/test/screenshots; verify mode compares, record mode re-captures.
    testImplementation("io.github.takahirom.roborazzi:roborazzi:1.41.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.41.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-junit-rule:1.41.0")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-accessibility-check:1.41.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // ISSUE-23: LifecycleEventEffect re-reads ANIMATOR_DURATION_SCALE on resume.
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.11.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
