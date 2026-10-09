import org.jetbrains.compose.desktop.application.dsl.TargetFormat

// NahalVPN for Windows: Compose Desktop UI on the shared :core logic, sing-box.exe as the engine (system-proxy mode).
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.jetbrains.compose)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))
    implementation(compose.desktop.windows_x64)
    implementation(compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.kotlinx.coroutines.swing)
    implementation(libs.jna.platform)
    testImplementation(libs.junit)
}

compose.desktop {
    application {
        mainClass = "ir.nahalkmi.nahalvpn.desktop.MainKt"
        nativeDistributions {
            targetFormats(TargetFormat.Msi)
            packageName = "NahalVPN"
            packageVersion = "0.3.3"
            vendor = "NahalVPN"
            description = "NahalVPN for Windows"
            // Only what the app needs (gradlew :desktop:suggestRuntimeModules) + EC crypto for TLS: keeps the installer small.
            modules("java.instrument", "jdk.unsupported", "jdk.crypto.ec", "java.naming")
            // sing-box.exe (tools/build_sing_box_windows.sh) ships next to the app: compose.application.resources.dir.
            appResourcesRootDir.set(project.layout.projectDirectory.dir("appResources"))
            windows {
                iconFile.set(project.layout.projectDirectory.file("icon/nahalvpn.ico"))
                menuGroup = "NahalVPN"
                shortcut = true
                upgradeUuid = "6b1f3f0e-6f43-4c5e-9d0f-1e8f6a5c2b71"
            }
        }
    }
}

// Developer end-to-end check against the live gateway: gradlew :desktop:e2eCheck -Puser=... -Ppass=...
tasks.register<JavaExec>("e2eCheck") {
    group = "verification"
    mainClass.set("ir.nahalkmi.nahalvpn.desktop.CheckKt")
    classpath = sourceSets["main"].runtimeClasspath
    workingDir = projectDir
    args(providers.gradleProperty("user").getOrElse(""), providers.gradleProperty("pass").getOrElse(""))
}
