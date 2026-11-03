plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

// Values baked per-user by the Yasha web app (see lib/apk-builder.ts):
// server URL + pre-authenticated session token → the app skips the login screen.
fun bakedProp(name: String, extra: String = ""): String {
    val raw = (findProperty(name) as? String) ?: ""
    return "\"" + raw.filter { it.isLetterOrDigit() || it in extra } + "\""
}

// Release signing (android/README.md §Signing, issue #34): env-provided keystore
// so every build this server publishes carries ONE stable signature — the only
// way in-place updates work. Without it (dev/tests/CI), release falls back to
// debug signing LOUDLY: such APKs cannot replace properly-signed installs.
val releaseKeystore: String? = System.getenv("YASHA_KEYSTORE")?.takeUnless { it.isBlank() }

android {
    namespace = "com.yasha.assist"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.yasha.assist"
        minSdk = 30
        targetSdk = 35
        versionCode = 2018 // CI-owned: Release workflow commits major·10⁶+minor·10³+patch per tag (android/README.md §Versioning)
        versionName = "0.2.18" // CI-owned: Release workflow sets it to the release tag; value here = dev default
        buildConfigField("String", "YASHA_SERVER_URL", bakedProp("yashaServerUrl", ".-:/"))
        buildConfigField("String", "YASHA_SESSION_TOKEN", bakedProp("yashaSessionToken", "-_./+="))
        buildConfigField("String", "YASHA_USERNAME", bakedProp("yashaUsername", "._-"))
        // Cleartext HTTP only when the baked server URL is http:// (LAN dev stacks).
        manifestPlaceholders["yashaCleartext"] =
            ((findProperty("yashaServerUrl") as? String) ?: "").startsWith("http://").toString()
    }
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("YASHA_KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("YASHA_KEY_ALIAS") ?: ""
                keyPassword = System.getenv("YASHA_KEY_PASSWORD") ?: ""
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: run {
                logger.warn(
                    "*** YASHA_KEYSTORE is not set — assembling a DEBUG-SIGNED release APK. " +
                        "Fine for dev/QA; these APKs cannot update devices running a release-signed build. ***"
                )
                signingConfigs.getByName("debug")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

dependencies {
    implementation(project(":core:design"))
    implementation(project(":core:net"))
    implementation(project(":core:capture"))
    implementation(project(":feature:chat"))
    implementation(project(":feature:assist"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    val composeBom = platform(libs.compose.bom)
    implementation(composeBom)
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    // Periodic background update checks (issue #34 Phase C).
    implementation(libs.androidx.work)
    testImplementation(libs.junit)
    debugImplementation(libs.compose.ui.tooling)
}
