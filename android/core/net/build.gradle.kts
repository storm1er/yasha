plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.yasha.assist.core.net"
    compileSdk = 35
    defaultConfig { minSdk = 30 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation(libs.okhttp)
    implementation(libs.okhttp.sse)
    api(libs.kotlinx.serialization.json)
    implementation(libs.security.crypto)
    implementation(libs.datastore.preferences)

    testImplementation(libs.junit)
}
