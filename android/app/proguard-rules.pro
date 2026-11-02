# Keep kotlinx.serialization generated serializers
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

# androidx.security-crypto bundles Tink, which references compile-time-only
# errorprone annotations that don't exist on Android (release/minify builds, #34).
-dontwarn com.google.errorprone.annotations.**
