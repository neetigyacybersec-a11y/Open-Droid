import java.util.Properties
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// ---- FR-B3 signing + versioning scaffold ----
// versionCode comes from this project's git history, so it climbs monotonically
// across releases; 1 when there is no history (fresh scaffold before first commit).
val gitCommitCount: Int = runCatching {
    providers.exec {
        commandLine("git", "rev-list", "--count", "HEAD")
    }.standardOutput.get().trim().toInt()
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
// unsigned APK. Stop at task-graph time with a message naming what is missing.
gradle.taskGraph.whenReady {
    if (!hasReleaseKeystore) {
        val releaseTasks = allTasks.filter {
            it.name.startsWith("assembleRelease") ||
                it.name.startsWith("signingRelease") ||
                it.name.startsWith("uploadRelease")
        }
        if (releaseTasks.isNotEmpty()) {
            throw GradleException(
                "keystore.properties is missing in the project root — release tasks would produce an unsigned APK. " +
                    "Add keystore.properties (storeFile, storePassword, keyAlias, keyPassword) or run assembleDebug."
            )
        }
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation(platform("androidx.compose:compose-bom:2024.11.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
