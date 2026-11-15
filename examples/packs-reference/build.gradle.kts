// FR-R1 / ISSUE-17 reference consumer. Plugin versions match manifest/packs.json
// and the template stack (AGP 8.7.2, Kotlin 2.0.21).
plugins {
    id("com.android.application") version "8.7.2" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.0.21" apply false
    id("org.jetbrains.kotlin.kapt") version "2.0.21" apply false
    id("com.google.dagger.hilt.android") version "2.52" apply false
}
