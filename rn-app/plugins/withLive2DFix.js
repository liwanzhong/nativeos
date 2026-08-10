/**
 * Expo config plugin: withLive2DFix
 *
 * `react-native-live2d` ships its native libs as AARs under
 * `node_modules/react-native-live2d/android/libs/`, and its
 * `android/build.gradle` references them with `compileOnly` — which means
 * AGP does NOT package them into the APK. At runtime the app then crashes
 * with `java.lang.NoClassDefFoundError: ICubismLogger` the moment it
 * tries to construct the Live2D view.
 *
 * We fix it by appending two preBuild tasks to `android/app/build.gradle`
 * that:
 *   1. extractLive2DAars    — unpack each AAR, take its `classes.jar` and
 *                              `jni/<abi>/*.so`, and expose them as a
 *                              `fileTree` dependency + jniLibs source set.
 *   2. extractLive2DModels   — copy `web/live2d/<character>/*` into the
 *                              generated assets dir so the native view can
 *                              load `models/<character>/<char>.model3.json`.
 *
 * Why a config plugin? Because `expo prebuild` (run by
 * `rebuild-dev-android.ps1`) regenerates `android/app/build.gradle` from
 * scratch every time, wiping any hand-edited preBuild tasks. Registering
 * this plugin in `app.json` makes the fix idempotent and survives every
 * prebuild run.
 *
 * Idempotency: we look for a unique marker comment at the top of the
 * injection and skip if it's already present.
 *
 * IMPORTANT: do NOT wrap the sourceSets / dependencies modifications in
 * `afterEvaluate { }`. The combination of `apply plugin: "com.facebook.react"`
 * + `afterEvaluate { ... }` in the same `app/build.gradle` triggers a Groovy
 * internal bug (`SourceUnit.getErrorCollector() because "source" is null`)
 * during the RN root project plugin's application. Top-level mutations
 * work fine because the `android { }` block is already evaluated by the
 * time our injection runs.
 */

const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = '// === withLive2DFix: react-native-live2d AAR extraction ===';

// NOTE: this is a plain string (NOT a template literal) because the body
// contains literal `${...}` and `$buildDir` for Groovy interpolation.
// Any `\$` here would still be a literal `$` once the string reaches
// Gradle.
const INJECTION = MARKER + '\n' +
'// react-native-live2d\'s android/build.gradle uses `compileOnly` to reference\n' +
'// its AARs, so AGP does not package them into the APK. This preBuild task\n' +
'// manually extracts classes.jar + jni/.so from each AAR, and copies model\n' +
'// files from web/live2d/ into the assets dir. Without this, the app crashes\n' +
'// at runtime with `NoClassDefFoundError: ICubismLogger`.\n' +
'\n' +
'def live2dProjectRoot = rootDir.getAbsoluteFile().getParentFile().getAbsolutePath()\n' +
'def live2dAarDir = new File(live2dProjectRoot, "node_modules/react-native-live2d/android/libs")\n' +
'def live2dGeneratedLibsDir = file("$buildDir/generated/live2d/libs")\n' +
'def live2dGeneratedJniLibsDir = file("$buildDir/generated/live2d/jniLibs")\n' +
'def live2dGeneratedAssetsDir = file("$buildDir/generated/live2d-assets")\n' +
'\n' +
'tasks.register("extractLive2DAars") {\n' +
'    outputs.dir live2dGeneratedLibsDir\n' +
'    outputs.dir live2dGeneratedJniLibsDir\n' +
'    doLast {\n' +
'        live2dGeneratedLibsDir.deleteDir()\n' +
'        live2dGeneratedJniLibsDir.deleteDir()\n' +
'        live2dGeneratedLibsDir.mkdirs()\n' +
'\n' +
'        fileTree(live2dAarDir).matching { include "*.aar" }.each { aarFile ->\n' +
'            def name = aarFile.name.replaceAll(/\\.aar$/, "")\n' +
'            def tmpDir = file("$buildDir/generated/live2d/aar-${name}")\n' +
'            tmpDir.deleteDir()\n' +
'            copy { from zipTree(aarFile); into tmpDir }\n' +
'\n' +
'            def classesJar = new File(tmpDir, "classes.jar")\n' +
'            if (classesJar.exists()) {\n' +
'                copy {\n' +
'                    from classesJar\n' +
'                    into live2dGeneratedLibsDir\n' +
'                    rename "classes.jar", "${name}.jar"\n' +
'                }\n' +
'            }\n' +
'\n' +
'            def jniDir = new File(tmpDir, "jni")\n' +
'            if (jniDir.exists()) {\n' +
'                copy { from jniDir; into live2dGeneratedJniLibsDir }\n' +
'            }\n' +
'        }\n' +
'    }\n' +
'}\n' +
'\n' +
'tasks.register("extractLive2DModels") {\n' +
'    outputs.dir live2dGeneratedAssetsDir\n' +
'    doLast {\n' +
'        live2dGeneratedAssetsDir.deleteDir()\n' +
'        def modelsSrcDir = new File(live2dProjectRoot, "web/live2d")\n' +
'        if (modelsSrcDir.exists()) {\n' +
'            // IMPORTANT: hard-code the `models/senko/` prefix in the destination.\n' +
'            // AGP flattens every entry under assets.srcDirs into the APK\'s\n' +
'            // `assets/` root, so files here must land at `<generated>/models/senko/`\n' +
'            // to be reachable as `assets/models/senko/<file>` at runtime — which\n' +
'            // is what react-native-live2d loads by default.\n' +
'            fileTree(modelsSrcDir).matching { include "senko/*" }.each { f ->\n' +
'                copy { from f; into new File(live2dGeneratedAssetsDir, "models/senko") }\n' +
'            }\n' +
'        }\n' +
'    }\n' +
'}\n' +
'\n' +
'// IMPORTANT: top-level mutations only. Wrapping in afterEvaluate {} breaks\n' +
'// the RN gradle plugin application (Groovy SourceUnit NPE).\n' +
'android.sourceSets {\n' +
'    main {\n' +
'        jniLibs.srcDirs += live2dGeneratedJniLibsDir\n' +
'        assets.srcDirs += live2dGeneratedAssetsDir\n' +
'    }\n' +
'}\n' +
'dependencies {\n' +
'    implementation fileTree(dir: live2dGeneratedLibsDir, include: ["*.jar"])\n' +
'}\n' +
'\n' +
'preBuild.dependsOn extractLive2DAars\n' +
'preBuild.dependsOn extractLive2DModels\n';

function withLive2DFix(config) {
  return withAppBuildGradle(config, (config) => {
    const contents = config.modResults.contents;
    if (contents.includes(MARKER)) {
      // Already injected by a previous prebuild run — nothing to do.
      return config;
    }
    // Append the injection to the end of the file. The preBuild task
    // definitions, sourceSets / dependencies modifications, and
    // preBuild.dependsOn assignments are all top-level statements that
    // mutate the already-evaluated android { } and dependencies { } blocks.
    // (Don't wrap in afterEvaluate — see header comment.)
    config.modResults.contents = contents.replace(
      /(\n)+$/,
      '\n\n' + INJECTION + '\n',
    );
    return config;
  });
}

module.exports = withLive2DFix;
module.exports.MARKER = MARKER;
