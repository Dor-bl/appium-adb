import { exec } from 'teen_process';
import log from '../logger.js';
import path from 'path';
import _ from 'lodash';
import { fs, tempDir, util } from '@appium/support';
import LRU from 'lru-cache';
import {
  getJavaForOs, unzipFile, buildInstallArgs, APKS_INSTALL_TIMEOUT
} from '../helpers.js';
import AsyncLock from 'async-lock';
import B from 'bluebird';

const BASE_APK = 'base-master.apk';
const LANGUAGE_APK = (lang) => `base-${lang}.apk`;
const APKS_CACHE = new LRU({
  max: 10,
  dispose: (apksHash, extractedFilesRoot) => fs.rimraf(extractedFilesRoot),
});
const APKS_CACHE_GUARD = new AsyncLock();
const BUNDLETOOL_TIMEOUT_MS = 4 * 60 * 1000;

const apksUtilsMethods = {};

process.on('exit', () => {
  if (!APKS_CACHE.size) {
    return;
  }

  const paths = [...APKS_CACHE.values()];
  log.debug(`Performing cleanup of ${paths.length} cached .apks ` +
    util.pluralize('package', paths.length));
  for (const appPath of paths) {
    try {
      // Asynchronous calls are not supported in onExit handler
      fs.rimrafSync(appPath);
    } catch (e) {
      log.warn(e.message);
    }
  }
});

/**
 * Extracts the particular apks package into a temporary folder,
 * finds and returns the full path to the file contained in this apk.
 * The resulting temporary path, where the .apks file has been extracted,
 * will be stored into the internal LRU cache for better performance.
 *
 * @param {string} apks - The full path to the .apks file
 * @param {string|Array<String>} dstPath - The relative path to the destination file,
 * which is going to be extracted, where each path component is an array item
 * @returns {string} Full path to the extracted file
 * @throws {Error} If the requested item does not exist in the extracted archive or the provides
 * apks file is not a valid bundle
 */
async function extractFromApks (apks, dstPath) {
  if (!_.isArray(dstPath)) {
    dstPath = [dstPath];
  }

  return await APKS_CACHE_GUARD.acquire(apks, async () => {
    // It might be that the original file has been replaced,
    // so we need to keep the hash sums instead of the actual file paths
    // as caching keys
    const apksHash = await fs.hash(apks);
    log.debug(`Calculated '${apks}' hash: ${apksHash}`);

    if (APKS_CACHE.has(apksHash)) {
      const resultPath = path.resolve(APKS_CACHE.get(apksHash), ...dstPath);
      if (await fs.exists(resultPath)) {
        return resultPath;
      }
      APKS_CACHE.del(apksHash);
    }

    const tmpRoot = await tempDir.openDir();
    log.debug(`Unpacking application bundle at '${apks}' to '${tmpRoot}'`);
    await unzipFile(apks, tmpRoot);
    const resultPath = path.resolve(tmpRoot, ...dstPath);
    if (!await fs.exists(resultPath)) {
      throw new Error(`${dstPath.join(path.sep)} cannot be found in '${apks}' bundle. ` +
        `Does the archive contain a valid application bundle?`);
    }
    APKS_CACHE.set(apksHash, tmpRoot);
    return resultPath;
  });
}

/**
 * Executes bundletool utility with given arguments and returns the actual stdout
 *
 * @param {Array<String>} args - the list of bundletool arguments
 * @param {string} errorMsg - The customized error message string
 * @returns {string} the actual command stdout
 * @throws {Error} If bundletool jar does not exist in PATH or there was an error while
 * executing it
 */
apksUtilsMethods.execBundletool = async function execBundletool (args, errorMsg) {
  await this.initBundletool();
  args = [
    '-jar', this.binaries.bundletool,
    ...args
  ];
  const env = process.env;
  if (this.adbPort) {
    env.ANDROID_ADB_SERVER_PORT = `${this.adbPort}`;
  }
  if (this.adbHost) {
    env.ANDROID_ADB_SERVER_HOST = this.adbHost;
  }
  log.debug(`Executing bundletool with arguments: ${JSON.stringify(args)}`);
  let stdout;
  try {
    ({stdout} = await exec(await getJavaForOs(), args, {
      env,
      timeout: BUNDLETOOL_TIMEOUT_MS,
    }));
    log.debug(`Command stdout: ${_.truncate(stdout, {length: 300})}`);
    return stdout;
  } catch (e) {
    if (e.stdout) {
      log.debug(`Command stdout: ${e.stdout}`);
    }
    if (e.stderr) {
      log.debug(`Command stderr: ${e.stderr}`);
    }
    throw new Error(`${errorMsg}. Original error: ${e.message}`);
  }
};

/**
 * @param {string} specLocation - The full path to the generated device spec location
 * @returns {string} The same `specLocation` value
 * @throws {Error} If it is not possible to retrieve the spec for the current device
 */
apksUtilsMethods.getDeviceSpec = async function getDeviceSpec (specLocation) {
  const args = [
    'get-device-spec',
    '--adb', this.executable.path,
    '--device-id', this.curDeviceId,
    '--output', specLocation,
  ];
  log.debug(`Getting the spec for the device '${this.curDeviceId}'`);
  await this.execBundletool(args, 'Cannot retrieve the device spec');
  return specLocation;
};

/**
 * @typedef {Object} InstallMultipleApksOptions
 * @property {?number|string} timeout [20000] - The number of milliseconds to wait until
 * the installation is completed
 * @property {string} timeoutCapName [androidInstallTimeout] - The timeout option name
 * users can increase the timeout.
 * @property {boolean} allowTestPackages [false] - Set to true in order to allow test
 * packages installation.
 * @property {boolean} useSdcard [false] - Set to true to install the app on sdcard
 * instead of the device memory.
 * @property {boolean} grantPermissions [false] - Set to true in order to grant all the
 * permissions requested in the application's manifest automatically after the installation
 * is completed under Android 6+.
 * @property {boolean} partialInstall [false] - Install apks partially. It is used for 'install-multiple'.
 * https://android.stackexchange.com/questions/111064/what-is-a-partial-application-install-via-adb
 */

/**
 * Installs the given apks into the device under test
 *
 * @param {Array<string>} apkPathsToInstall - The full paths to install apks
 * @param {?installMultipleApksOptions} options - Installation options
 */
apksUtilsMethods.installMultipleApks = async function installMultipleApks (apkPathsToInstall, options = {}) {
  const installArgs = buildInstallArgs(await this.getApiLevel(), options);
  return await this.adbExec(['install-multiple', ...installArgs, ...apkPathsToInstall], {
    timeout: options.timeout,
    timeoutCapName: options.timeoutCapName,
  });
};

/**
 * @typedef {Object} InstallApksOptions
 * @property {?number|string} timeout [120000] - The number of milliseconds to wait until
 * the installation is completed
 * @property {string} timeoutCapName [androidInstallTimeout] - The timeout option name
 * users can increase the timeout.
 * @property {boolean} allowTestPackages [false] - Set to true in order to allow test
 * packages installation.
 * @property {boolean} grantPermissions [false] - Set to true in order to grant all the
 * permissions requested in the application's manifest automatically after the installation
 * is completed under Android 6+.
 */

/**
 * Installs the given .apks package into the device under test
 *
 * @param {string} apks - The full path to the .apks file
 * @param {?InstallApksOptions} options - Installation options
 * @throws {Error} If the .apks bundle cannot be installed
 */
apksUtilsMethods.installApks = async function installApks (apks, options = {}) {
  const {
    grantPermissions,
    allowTestPackages,
    timeout,
  } = options;

  const args = [
    'install-apks',
    '--adb', this.executable.path,
    '--apks', apks,
    '--timeout-millis', timeout || APKS_INSTALL_TIMEOUT,
    '--device-id', this.curDeviceId,
  ];
  if (allowTestPackages) {
    args.push('--allow-test-only');
  }
  const tasks = [
    this.execBundletool(args, `Cannot install '${path.basename(apks)}' to the device ${this.curDeviceId}`)
  ];
  if (grantPermissions) {
    tasks.push(this.getApkInfo(apks));
  }
  const [, apkInfo] = await B.all(tasks);
  if (grantPermissions && apkInfo) {
    // TODO: Simplify it after https://github.com/google/bundletool/issues/246 is implemented
    await this.grantAllPermissions(apkInfo.name);
  }
};

/**
 * Extracts and returns the full path to the master .apk file inside the bundle.
 *
 * @param {string} apks - The full path to the .apks file
 * @returns {string} The full path to the master bundle .apk
 * @throws {Error} If there was an error while extracting/finding the file
 */
apksUtilsMethods.extractBaseApk = async function extractBaseApk (apks) {
  return await extractFromApks(apks, ['splits', BASE_APK]);
};

/**
 * Extracts and returns the full path to the .apk, which contains the corresponding
 * resources for the given language in the .apks bundle.
 *
 * @param {string} apks - The full path to the .apks file
 * @param {?string} language - The language abbreviation. The default language is
 * going to be selected if it is not set.
 * @returns {string} The full path to the corresponding language .apk or the master .apk
 * if language split is not enabled for the bundle.
 * @throws {Error} If there was an error while extracting/finding the file
 */
apksUtilsMethods.extractLanguageApk = async function extractLanguageApk (apks, language = null) {
  if (language) {
    try {
      return await extractFromApks(apks, ['splits', LANGUAGE_APK(language)]);
    } catch (e) {
      log.debug(e.message);
      log.info(`Assuming that splitting by language is not enabled for the '${apks}' bundle ` +
        `and returning the main apk instead`);
      return await this.extractBaseApk(apks);
    }
  }

  const defaultLanguages = ['en', 'en_us'];
  for (const lang of defaultLanguages) {
    try {
      return await extractFromApks(apks, ['splits', LANGUAGE_APK(lang)]);
    } catch (ign) {}
  }

  log.info(`Cannot find any split apk for the default languages ${JSON.stringify(defaultLanguages)}. ` +
    `Returning the main apk instead.`);
  return await this.extractBaseApk(apks);
};

apksUtilsMethods.isTestPackageOnlyError = function isTestPackageOnlyError (output) {
  return /\[INSTALL_FAILED_TEST_ONLY\]/.test(output);
};

export default apksUtilsMethods;
