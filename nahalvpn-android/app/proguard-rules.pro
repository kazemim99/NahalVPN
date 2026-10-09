# libbox (gomobile) reflects into these from native code.
-keep class io.nekohasekai.libbox.** { *; }
-keep class go.** { *; }
# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keepclassmembers class ir.nahalkmi.nahalvpn.** { *** Companion; }
-keepclasseswithmembers class ir.nahalkmi.nahalvpn.** { kotlinx.serialization.KSerializer serializer(...); }
