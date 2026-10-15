pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "yasha-android"

include(":app")
include(":core:design")
include(":core:markdown")
include(":core:net")
include(":core:capture")
include(":core:audio")
include(":feature:chat")
include(":feature:assist")
