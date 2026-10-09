import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "ir.nahalkmi.nahalvpn"
    compileSdk = 36

    defaultConfig {
        applicationId = "ir.nahalkmi.nahalvpn"
        minSdk = 23
        targetSdk = 36
        versionCode = 6
        versionName = "0.3.3"
        buildConfigField("String", "API_BASE", "\"https://api.nahalkmi.ir\"")
        // SHA-256 of the release signing certificate; updates signed by any other key are refused (task 5.7).
        buildConfigField("String", "RELEASE_CERT_SHA256", "\"${providers.gradleProperty("nahal.releaseCertSha256").getOrElse("")}\"")
        // -Pnahal.abi=x86_64 builds a single-ABI APK (emulator testing); release ships all three.
        val abis = providers.gradleProperty("nahal.abi").map { listOf(it) }.getOrElse(listOf("arm64-v8a", "armeabi-v7a", "x86_64"))
        ndk { abiFilters += abis }
    }

    buildTypes {
        debug {
            // Debug builds only: -Pnahal.transports=openvpn_udp,openvpn_tcp restricts the fallback chain for testing.
            buildConfigField("String", "FORCE_TRANSPORTS", "\"${providers.gradleProperty("nahal.transports").getOrElse("")}\"")
            // -Pnahal.breakVless=true makes VLESS fail on purpose, to exercise the fallback to OpenVPN on a real device.
            buildConfigField("boolean", "BREAK_VLESS", providers.gradleProperty("nahal.breakVless").getOrElse("false"))
        }
        release {
            buildConfigField("String", "FORCE_TRANSPORTS", "\"\"")
            buildConfigField("boolean", "BREAK_VLESS", "false")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    // One APK per CPU type keeps downloads small on Iranian mobile data; the universal APK serves the update channel
    // and anyone unsure which to pick. Skipped for single-ABI test builds (-Pnahal.abi=...).
    splits {
        abi {
            isEnable = !providers.gradleProperty("nahal.abi").isPresent
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    packaging {
        jniLibs { useLegacyPackaging = true }
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    // sing-box v1.14.2 libbox (VLESS engine), built lean by tools/build_libbox.sh; GPLv3.
    implementation(project(":core"))
    implementation(files("libs/libbox.aar"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
