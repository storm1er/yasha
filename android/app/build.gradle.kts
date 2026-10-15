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

android {
    namespace = "com.yasha.assist"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.yasha.assist"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-M0"
        buildConfigField("String", "YASHA_SERVER_URL", bakedProp("yashaServerUrl", ".-:/"))
        buildConfigField("String", "YASHA_SESSION_TOKEN", bakedProp("yashaSessionToken", "-_./+="))
        buildConfigField("String", "YASHA_USERNAME", bakedProp("yashaUsername", "._-"))
        // Cleartext HTTP only when the baked server URL is http:// (LAN dev stacks).
        manifestPlaceholders["yashaCleartext"] =
            ((findProperty("yashaServerUrl") as? String) ?: "").startsWith("http://").toString()
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
    debugImplementation(libs.compose.ui.tooling)
}
