'use strict';

/**
 * sherpa-onnx's CUDA build of ONNX Runtime, for PROVIDER=cuda (README.md, "Using an NVIDIA GPU").
 *
 * The npm package sherpa-onnx-node ships CPU-only libraries, and sherpa-onnx picks the CUDA
 * execution provider at run time from whatever onnxruntime library it finds, so the same release
 * of sherpa-onnx built with CUDA (ONNX Runtime 1.28.2, CUDA 13, cuDNN 9) is all that is needed.
 * scripts/download-models.js fetches that package into MODELS_DIR/gpu-libs; the libraries then
 * have to be where the addon loads them from, which differs by platform:
 *  - Windows: copied next to sherpa-onnx.node (`copy`). Node loads addons with
 *    LOAD_WITH_ALTERED_SEARCH_PATH, so a DLL's imports come from the addon's folder before PATH:
 *    nothing on PATH can replace the CPU onnxruntime.dll that sits there.
 *  - Linux: left in place, and scripts/launch.js puts the folder in the server's LD_LIBRARY_PATH.
 *    The addon's RUNPATH ($ORIGIN) is searched after LD_LIBRARY_PATH, so the CUDA
 *    libsherpa-onnx-c-api.so there wins over the npm package's, and it loads libonnxruntime.so
 *    from the same folder (its own RUNPATH). The npm package's libsherpa-onnx-c-api.so could not
 *    be redirected this way: it has an RPATH, which is searched before LD_LIBRARY_PATH. Copying
 *    is no option there either, because /usr/lib/voicerecon is read-only to the Debian service.
 * The package must match the installed sherpa-onnx-node version: update SHERPA_VERSION, the
 * file names and the SHA-256 values together with package.json.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHERPA_VERSION = '1.13.8';
const RELEASE = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}`;
const BUILD = 'cuda-13.x-cudnn-9.x-onnxruntime1.28.2';

/**
 * Per platform (`process.platform-process.arch`): the release file, its SHA-256, the libraries used
 * from it, and the NVIDIA libraries the CUDA provider loads (`needs`). A missing one of those does
 * not raise an error: sherpa-onnx ends the process at the first decode (cuDNN) or when the
 * recognizer is created (the others), so they are looked for before CUDA is asked for.
 */
const PACKAGES = {
  'win32-x64': {
    name: `sherpa-onnx-v${SHERPA_VERSION}-${BUILD}-win-x64-cuda`,
    sha256: '1702e4a1ee68a07422469a7ec1d304a54b43a345ad888daf8e0b0257004a3273',
    megabytes: 478,
    libs: ['onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'onnxruntime_providers_cuda.dll'],
    copy: true,
    needs: ['cudart64_13.dll', 'cublas64_13.dll', 'cublasLt64_13.dll', 'cufft64_12.dll', 'cudnn64_9.dll'],
  },
  'linux-x64': {
    name: `sherpa-onnx-v${SHERPA_VERSION}-${BUILD}-linux-x64-gpu`,
    sha256: '7eddaee14a42d143ec995ed68e9ec3623dd6ca9d22076139d4c0879c3121c819',
    megabytes: 255,
    libs: ['libsherpa-onnx-c-api.so', 'libonnxruntime.so', 'libonnxruntime_providers_shared.so', 'libonnxruntime_providers_cuda.so'],
    copy: false,
    needs: ['libcudart.so.13', 'libcublas.so.13', 'libcublasLt.so.13', 'libcurand.so.10', 'libnvrtc.so.13', 'libcudnn.so.9'],
  },
};

const PROVIDER_LIBRARY = /onnxruntime_providers_cuda\.(dll|so)$/;

/**
 * The CUDA package for a platform, or null where sherpa-onnx has none (macOS, ARM).
 * @param {string} [platform]
 * @param {string} [arch]
 */
function gpuPackage(platform = process.platform, arch = process.arch) {
  const pkg = PACKAGES[`${platform}-${arch}`];
  return pkg ? { ...pkg, url: `${RELEASE}/${pkg.name}.tar.bz2` } : null;
}

/** The folder with the extracted libraries (the package's lib/). */
function libDir(config, pkg) {
  return path.join(config.gpuLibsDir, pkg.name, 'lib');
}

/**
 * The folder of the sherpa-onnx-node addon for this platform, where its libraries are loaded from.
 * @param {string} [platform]
 * @param {string} [arch]
 */
function addonDir(platform = process.platform, arch = process.arch) {
  // The Windows package is named win-x64, not win32-x64 (sherpa-onnx renamed it).
  const name = `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`;
  return path.dirname(require.resolve(`${name}/package.json`));
}

const size = (file) => (fs.existsSync(file) ? fs.statSync(file).size : -1);

/**
 * The libraries PROVIDER=cuda still needs: files missing from the extracted package and, where
 * they are copied next to the addon, copies that are missing or differ in size (npm install puts
 * the CPU libraries back). Empty when everything is in place, and on platforms without a package.
 * @param {{ gpuLibsDir: string }} config
 * @param {{ platform?: string, arch?: string, addon?: string }} [where] tests give the addon folder
 * @returns {string[]}
 */
function missingLibs(config, { platform = process.platform, arch = process.arch, addon = '' } = {}) {
  const pkg = gpuPackage(platform, arch);
  if (!pkg) return [];
  const dir = libDir(config, pkg);
  const missing = pkg.libs.map((f) => path.join(dir, f)).filter((f) => !fs.existsSync(f));
  if (!pkg.copy || missing.length) return missing;
  const target = addon || addonDir(platform, arch);
  return pkg.libs.map((f) => path.join(target, f)).filter((f) => size(f) !== size(path.join(dir, path.basename(f))));
}

/**
 * Copies the libraries next to the addon where the platform needs that (Windows). Returns the
 * files copied; nothing on Linux, where launch.js points LD_LIBRARY_PATH at them instead.
 * @param {{ gpuLibsDir: string }} config
 * @param {{ platform?: string, arch?: string, addon?: string }} [where]
 */
function installLibs(config, { platform = process.platform, arch = process.arch, addon = '' } = {}) {
  const pkg = gpuPackage(platform, arch);
  if (!pkg || !pkg.copy) return [];
  const dir = libDir(config, pkg);
  const target = addon || addonDir(platform, arch);
  const copied = [];
  for (const f of pkg.libs) {
    if (size(path.join(target, f)) === size(path.join(dir, f))) continue;
    fs.copyFileSync(path.join(dir, f), path.join(target, f));
    copied.push(path.join(target, f));
  }
  return copied;
}

/**
 * The environment for the server process: with PROVIDER=cuda on Linux, LD_LIBRARY_PATH starts with
 * the CUDA libraries' folder (see the top of this file); otherwise `env` as it is.
 * @param {{ provider: string, gpuLibsDir: string }} config
 * @param {NodeJS.ProcessEnv} env
 * @param {string} [platform]
 * @param {string} [arch]
 */
function serverEnv(config, env, platform = process.platform, arch = process.arch) {
  const pkg = config.provider === 'cuda' ? gpuPackage(platform, arch) : null;
  if (!pkg || pkg.copy) return env;
  const dir = libDir(config, pkg);
  return { ...env, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH ? `${dir}:${env.LD_LIBRARY_PATH}` : dir };
}

/** The shared libraries the dynamic linker knows (`ldconfig -p`), by file name; empty where there is no ldconfig. */
function knownLibraries() {
  const r = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return new Set();
  return new Set(r.stdout.split('\n').map((line) => line.trim().split(' ')[0]).filter(Boolean));
}

/**
 * The NVIDIA libraries that cannot be found, so CUDA must not be asked for (see PACKAGES): on
 * Windows looked for in PATH, on Linux in LD_LIBRARY_PATH and the linker's cache. Where
 * sherpa-onnx has no CUDA package, that package.
 * @param {{ platform?: string, arch?: string, env?: NodeJS.ProcessEnv, known?: Set<string> }} [where] tests give the environment and the linker's libraries
 * @returns {string[]}
 */
function missingPrerequisites({ platform = process.platform, arch = process.arch, env = process.env, known = undefined } = {}) {
  const pkg = gpuPackage(platform, arch);
  if (!pkg) return [`sherpa-onnx's CUDA libraries for ${platform}-${arch} (none exist)`];
  const dirs = ((pkg.copy ? env.PATH || env.Path : env.LD_LIBRARY_PATH) || '').split(path.delimiter).filter(Boolean);
  const cache = pkg.copy ? new Set() : known || knownLibraries();
  return pkg.needs.filter((lib) => !cache.has(lib) && !dirs.some((d) => fs.existsSync(path.join(d, lib))));
}

/**
 * Whether the CUDA execution provider's library is loaded in this process. The addon cannot say
 * which provider a model got, and sherpa-onnx only logs its fallback to the CPU, so after the
 * models are loaded the process's shared objects are the one reliable sign.
 */
function cudaLoaded() {
  const report = /** @type {{ sharedObjects: string[] }} */ (process.report.getReport());
  return report.sharedObjects.some((f) => PROVIDER_LIBRARY.test(f));
}

/**
 * What to check when PROVIDER=cuda did not give a working GPU: the libraries (installed by
 * download-models.js, on Linux seen only through launch.js) and the NVIDIA software they need.
 * @param {{ gpuLibsDir: string }} config
 * @param {string} [platform]
 * @param {string} [arch]
 */
function cudaHint(config, platform = process.platform, arch = process.arch) {
  const pkg = gpuPackage(platform, arch);
  if (!pkg) return 'CUDA is available on Windows and Linux x64 only; set PROVIDER=cpu.';
  return pkg.copy
    ? 'Run "npm run models" (start.cmd does it) to install the CUDA libraries, and check that the NVIDIA driver, '
      + 'the CUDA 13 runtime and cuDNN 9 are installed, with the bin folders of both on PATH (README.md, "Using an NVIDIA GPU").'
    : `Start VoiceRecon with start.sh or the service, which put ${libDir(config, pkg)} in LD_LIBRARY_PATH, and check that `
      + 'the NVIDIA driver, the CUDA 13 runtime libraries and cuDNN 9 are installed (README.md, "Using an NVIDIA GPU").';
}

module.exports = { SHERPA_VERSION, gpuPackage, libDir, addonDir, missingLibs, installLibs, serverEnv, missingPrerequisites, cudaLoaded, cudaHint };
