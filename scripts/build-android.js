// Builds the signed Android app: npm run android  ->  dist/N.D. Patil Canteen-<version>.apk
const { execSync } = require('child_process');
const fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const tools = path.join(process.env.LOCALAPPDATA, 'Android');
const env = { ...process.env, JAVA_HOME: path.join(tools, 'jdk21'), ANDROID_HOME: path.join(tools, 'Sdk') };
const run = (cmd, cwd = root) => execSync(cmd, { cwd, env, stdio: 'inherit' });

// keep the Android version in step with the desktop version (versionCode must always go up)
const gradleFile = path.join(root, 'android', 'app', 'build.gradle');
const [maj, min, pat] = pkg.version.split('.').map(Number);
const gradle = fs.readFileSync(gradleFile, 'utf8')
  .replace(/versionCode \d+/, `versionCode ${maj * 10000 + min * 100 + pat}`)
  .replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
fs.writeFileSync(gradleFile, gradle);
fs.writeFileSync(path.join(root, 'android', 'local.properties'), `sdk.dir=${env.ANDROID_HOME.replace(/\\/g, '\\\\')}\n`);

run('node scripts/copy-web.js');
run('npx cap sync android');
const androidDir = path.join(root, 'android');
run(`"${path.join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew')}" assembleRelease`, androidDir);

const out = path.join(root, 'dist', `N.D. Patil Canteen-${pkg.version}.apk`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'), out);
console.log('\nAndroid app ready:', out);
