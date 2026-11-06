configure<com.android.build.api.dsl.ApplicationExtension> {
    defaultConfig {
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Tauri's final activity destruction exits the shared instrumentation process.
        testInstrumentationRunnerArguments["waitForActivitiesToComplete"] = "false"
    }
}

dependencies {
    add("androidTestImplementation", "androidx.test:runner:1.6.2")
    add("androidTestImplementation", "androidx.test:core:1.6.1")
    add("androidTestImplementation", "com.squareup.okhttp3:mockwebserver:4.12.0")
}
