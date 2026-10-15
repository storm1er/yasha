# Android build image: JDK + Android SDK 35 + pinned Gradle (PLAN.md decision D-1:
# containers only — the host never runs gradle/sdk).
FROM ghcr.io/cirruslabs/android-sdk:35

ARG GRADLE_VERSION=8.9
RUN curl -fsSL "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" -o /tmp/gradle.zip \
    && unzip -q /tmp/gradle.zip -d /opt \
    && ln -s "/opt/gradle-${GRADLE_VERSION}/bin/gradle" /usr/local/bin/gradle \
    && rm /tmp/gradle.zip \
    && gradle --version

WORKDIR /project
