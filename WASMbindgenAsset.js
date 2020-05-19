const { Asset } = require('parcel-bundler')
const commandExists = require('command-exists')
const toml = require('@iarna/toml')
const path = require('path')
const util = require('util')
const exec = util.promisify(require('child_process').execFile)
const lib = require('./lib')

const RUST_TARGET = 'wasm32-unknown-unknown'

const cmdExists = async (cmd) => {
  try {
    await commandExists(cmd)
    return true
  } catch (e) {
    return false
  }
}

class WASMbindgenAsset extends Asset {
  // type = 'wasm'

  constructor(name, options) {
    super(name, options)
    this.type = 'js';
  }

  process() {
    if (this.options.isWarmUp) {
      return
    }

    return super.process()
  }

  isTargetRust() {
    return path.basename(this.name) === 'Cargo.toml' || path.extname(this.name) === '.rs'
  }

  isNormalTOML() {
    return path.extname(this.name) === '.toml'
  }

  buildOpts() {
    let inReleaseMode = true;
    let wasmPackProfile = 'release';

    // To figure out the build mode, we'll check WASM_PACK_PROFILE first
    // followed by NODE_ENV. If neither are specified we'll default to using
    // release mode.
    const wasmPackProfileEnv = process.env.WASM_PACK_PROFILE
    const nodeEnv = process.env.NODE_ENV

    if (wasmPackProfileEnv !== undefined) {
      switch (wasmPackProfileEnv.toLowerCase()) {
        case 'dev':
        case 'debug':
          inReleaseMode = false
          wasmPackProfile = 'dev'
          break
        case 'release':
          inReleaseMode = true
          wasmPackProfile = 'release'
          break
        case 'profiling':
          inReleaseMode = true
          wasmPackProfile = 'profiling'
          break
        default:
          throw `${wasmPackProfileEnv} (set by WASM_PACK_PROFILE) is not a recognized wasm-pack build profile`
      }
    } else if (nodeEnv !== undefined) {
      switch (nodeEnv.toLowerCase()) {
        case 'dev':
        case 'development':
          inReleaseMode = false
          wasmPackProfile = 'dev'
          break
        case 'release':
        case 'production':
          inReleaseMode = true
          wasmPackProfile = 'release'
          break

        // Unlike with WASM_PACK_PROFILE, we won't throw on unrecognized values
        // of NODE_ENV.
      }
    }

    // TODO:
    // I'm inclined not to translate `this.options.minify` as `-Clink-arg=-s`
    // like the default parcel Rust plugin does because:
    //  - there isn't really a way to signal this to wasm-pack (which invokes
    //    wasm-opt which also has -Os and -Oz flags)
    //  - this is probably not what users actually want? aiui, minify is enabled
    //    for production builds (when NODE_ENV=production) and you'd usually
    //    want -O3
    //  - I think it's much better to just respect whatever users have already
    //    asked for in their Cargo.toml files for the profile we end up using
    //
    // As for logLevels: cargo offers a verbose option but wasm-pack and
    // wasm-bindgen don't so I'm not sure there's a point...
    //
    // For sourceMaps: wasm-bindgen/rustc don't support source maps but they
    // do support DWARF debug info that browsers seem to be picking up support
    // for: https://developers.google.com/web/updates/2019/12/webassembly
    // wasm-bindgen seems to have options to preserve (and correctly update?)
    // the debug sections in what it produces; when using wasm-pack this is
    // enabled for the debug profile (with settings in Cargo.toml overriding).
    // I'm, again, reticent to try to pass this option into wasm-bindgen and
    // wasm-pack when sourceMaps are enabled because:
    //  - we have no way pass this into wasm-pack
    //  - when using wasm-pack I don't have a good answer for who takes
    //    precedence: the Cargo.toml settings or `this.options`
    // So for now, we can maybe just pass in the flag (`--keep-debug`) into
    // wasm-bindgen when sourceMaps are enabled.
    //
    // For autoInstall, we could try to install wasm-pack _always_ and just
    // ditch the wasm-bindgen support. I kind of want to do this because we
    // don't properly replicate some of the things wasm-pack does (i.e. add in
    // the wasm-bindgen debug asserts (`--debug`) if requested — we could add
    // in the flag for this but I don't want to replicate more wasm-pack
    // functionality here). I think it's also a little weird to fall back to
    // wasm-bindgen calls with no warning since the produced .wasm files can be
    // worse (i.e. we don't call wasm-opt manually).
    let { logLevel, sourceMaps, autoInstall } = this.options;

    return {
      cargoTargetDirName: inReleaseMode ? 'release' : 'debug',
      cargoProfile: inReleaseMode ? '--release' : '--debug',
      wasmPackProfile,
    }
  }

  async crateTypeCheck(cargoConfig) {
    if (!cargoConfig.lib ||
        !Array.isArray(cargoConfig.lib['crate-type']) ||
        !cargoConfig.lib['crate-type'].includes('cdylib')) {
      throw 'The `crate-type` in Cargo.toml should be `cdylib`'
    }

    return cargoConfig
  }

  async parse(code) {
    if (!this.isTargetRust()) {
      if (this.isNormalTOML())
        return toml.parse(code)
      else
        throw `${this.name} is not valid Rust file or Cargo.toml`
    }

    const cargoConfig = await this.getConfig(['Cargo.toml'])
    const cargoDir = path.dirname(await lib.resolve(this.name, ['Cargo.toml']))
    await this.crateTypeCheck(cargoConfig)

    const has_wasm_pack = await cmdExists('wasm-pack')
    const has_cargo = await cmdExists('cargo')
    const has_wasmbindgen = await cmdExists('wasm-bindgen')

    const build_result = {
      cargoDir
    }

    if (has_wasm_pack) {
      Object.assign(build_result, await this.wasmPackBuild(cargoConfig, cargoDir, has_cargo && has_wasmbindgen))
    } else if (has_cargo) {
      if (has_wasmbindgen) {
        Object.assign(build_result, await this.rawBuild(cargoConfig, cargoDir))
      } else {
        throw 'Please install wasm-pack'
      }
    } else {
      // TODO: autoInstall things would go here
      throw 'Please install Cargo for Rust'
    }

    await this.wasmPostProcess(build_result)
  }

  async wasmPackBuild(cargoConfig, cargoDir, has_deps) {
    const hasBuildCommand = await exec('wasm-pack', ['build', '--help']).then(() => true).catch(() => false)
    const isNode = this.options.target === 'node'
    const { wasmPackProfile } = this.buildOpts();

    let args
    if (hasBuildCommand) {
      args = has_deps ? ['build', '-m', 'no-install'] : ['build']
    } else {
      args = has_deps ? ['init', '-m', 'no-install'] : ['init']
    }

    // TODO: test whether versions of `wasm-pack` that don't have a build
    // command support `--target` (and if they don't, do we need to detect
    // this/try to support them?).
    if (isNode) {
      args.push(...['--target', 'nodejs'])
    } else {
      args.push(...['--target', 'bundler'])
      // Actually using the web target is problematic because we're not actually
      // being used as a module by a browser. This causes import.meta to break.
      // import.meta is problematic anyways since babel does not yet support
      // it (it's being worked on: https://github.com/babel/babel/issues/11364)
      // There are plugins that enable it but still.
      //
      // Also, most importantly, parcel (understandably) can't trace through
      // the import.meta import that wasm-bindgen produces (or any import.meta
      // import — not that it makes a difference).
      // args.push(...['--target', 'web'])
    }

    args.push(`--${wasmPackProfile}`)

    await exec('wasm-pack', args, {
      cwd: cargoDir
    })

    return {
      outDir: path.join(cargoDir, 'pkg'),
      rustName: cargoConfig.package.name.replace(/-/g, '_'),
      cargoDir,
    }
  }

  async rawBuild(cargoConfig, cargoDir) {
    try {
      let { cargoProfile, cargoTargetDirName } = this.buildOpts();

      // Run cargo
      // TODO: earlier we used `nightly` here; is this still what we want?
      // (wasm/wasm-bindgen work on stable now)
      let args = ['build', '--target', RUST_TARGET, cargoProfile]
      await exec('cargo', args, {cwd: cargoDir})

      // Get output file paths
      let { stdout } = await exec('cargo', ['metadata', '--format-version', '1'], {
        cwd: cargoDir
      })
      const cargoMetadata = JSON.parse(stdout)
      const cargoTargetDir = cargoMetadata.target_directory
      let outDir = path.join(cargoTargetDir, RUST_TARGET, cargoTargetDir)

      // Rust converts '-' to '_' when outputting files.
      let rustName = cargoConfig.package.name.replace(/-/g, '_')

      // Build with wasm-bindgen
      // TODO: do we try to detect/support versions of wasm-bindgen that don't
      // support `--target`?
      // If no: we should add a check that searches `wasm-bindgen --help` for
      // `--target`.
      const isNode = this.options.target === 'node'
      args = [
        path.join(outDir, rustName + '.wasm'),
        '--out-dir', outDir,
        '--target', isNode ? 'nodejs' : 'web',
      ]
      await exec('wasm-bindgen', args, {cwd: cargoDir})

      return {
        outDir,
        rustName,
        cargoDir,
      }
    } catch (e) {
      throw `Building failed... Please install wasm-pack and try again.`
    }
  }

  async wasmPostProcess({outDir, rustName, cargoDir}) {
    const { cargoTargetDirName } = this.buildOpts()

    const getPath = (relative) => {
      let p = path.relative(path.dirname(this.name), path.join(outDir, relative))
      if (p[0] !== '.')
        p = './' + p
      p = p.replace('\\', '/')

      return p
    }

    this.jsPath = getPath(rustName + '.js')
    this.jsAltPath = getPath(rustName + '_bg.js')
    this.wasmPath = getPath(rustName + '_bg.wasm')

    // Get output file paths
    let { stdout } = await exec('cargo', ['metadata', '--format-version', '1'], {
      cwd: cargoDir,
      maxBuffer: 1024 * 1024
    })
    const cargoMetadata = JSON.parse(stdout)
    const cargoTargetDir = cargoMetadata.target_directory
    this.depsPath = path.join(cargoTargetDir, RUST_TARGET, cargoTargetDirName, rustName + '.d')
  }

  // TODO: This seems to be copied from the built-in RustAsset.js file; there
  // doesn't seem to be an easy way to do so but it'd be nice to import it
  // rather than copying it here.
  //
  // On the other hand it's not part of the public interface and doesn't have
  // stability guarantees (there also isn't really a good way to do this) so I
  // guess this is fine.
  async collectDependencies() {
    if (!this.isTargetRust())
      return false

    // Read deps file
    let contents = await lib.readFile(this.depsPath, 'utf8')
    let dir = path.dirname(this.name)

    let deps = contents.trim().split(':')[1].split(/\b\ /g).map(x => x.trim().replace('\\ ', ''))

    for (let dep of deps) {
      if (dep !== this.name) {
        this.addDependency(dep, {includedInParent: true})
      }
    }
  }

  async generate() {
    if (this.isTargetRust()) {
      // return /*[*/
        // {
        //   wasm: {
        //     path: this.wasmPath,
        //     // mtime: Date.now(),
        //   }
        // },

        // return {
        //   js: {
        //     path: this.jsPath,
        //     mtime: Date.now(),
        //   },
        // }

        // console.log(this.jsPath);
        const isNode = this.options.target === 'node'

        let value
        if (isNode) {
          value = await lib.readFile(this.jsPath, 'utf8');
        } else {
          value = `import * as wasm from '${this.wasmPath}'
export * from '${this.jsAltPath}'
`
        }

        return [{
          type: 'js',
          // TODO: can we avoid reading the file in here?
          value,
        }]
      // ]
    } else {
      throw `${this.name} is not valid Rust file or Cargo.toml`
    }
  }
}

module.exports = WASMbindgenAsset
