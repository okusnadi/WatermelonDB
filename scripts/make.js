#!/usr/bin/env node

const {
  pipe,
  filter,
  map,
  mapAsync,
  endsWith,
  both,
  prop,
  replace,
  join,
  reduce,
  omit,
  merge,
  forEach,
  tail,
} = require('rambdax')

const rollup = require('rollup')
const klaw = require('klaw-sync')
const mkdirp = require('mkdirp')
const path = require('path')
const fs = require('fs-extra')
const prettyJson = require('json-stringify-pretty-compact')
const chokidar = require('chokidar')
const anymatch = require('anymatch')
const rimraf = require('rimraf')

const pkg = require('../package.json')
const createRollupConfig = require('./rollup.config')

const resolvePath = (...paths) => path.resolve(__dirname, '..', ...paths)
const isDevelopment = process.env.NODE_ENV === 'development'
const rollupConfig = createRollupConfig({ env: process.env.NODE_ENV })

const ESM_MODULES = 'esm'
const CJS_MODULES = 'cjs'

const SOURCE_PATH = resolvePath('src')
const DIST_PATH = resolvePath('dist')
const DEV_PATH = resolvePath('dev')

const DIR_PATH = isDevelopment ? DEV_PATH : DIST_PATH

const DO_NOT_BUILD_PATHS = [
  /adapters\/__tests__/,
  /test\.js/,
  /type\.js/,
  /integrationTest\.js/,
  /__mocks__/,
  /Collection\/RecordCache\.js/,
  /\.DS_Store/,
]

const isNotIncludedInBuildPaths = value => !anymatch(DO_NOT_BUILD_PATHS, value)

const cleanFolder = dir => rimraf.sync(dir)

const takeFiles = pipe(
  prop('path'),
  both(endsWith('.js'), isNotIncludedInBuildPaths),
)

const takeModules = pipe(
  filter(takeFiles),
  map(prop('path')),
)

const removeSourcePath = replace(SOURCE_PATH, '')
const toStringKeyValue = module => `'${module.key}': '${module.value}'`
const indentLine = line => `    ${line},`
const toStringObject = pipe(
  map(
    pipe(
      toStringKeyValue,
      indentLine,
    ),
  ),
  join('\n'),
)

const pathMappingTemplate = obj =>
  `
"use strict"

module.exports = function() {
  return {
${toStringObject(obj)}
  }
}
  `

const createModulePath = format => {
  const modulePath = resolvePath(DIR_PATH, format)
  return replace(SOURCE_PATH, modulePath)
}

const createPathName = file => {
  const value = removeSourcePath(file)
  return endsWith('index.js', value) ? path.dirname(value) : replace('.js', '', value)
}

const createModuleName = name => {
  const module = tail(name)
  return `${pkg.name}${module === '' ? module : `/${module}`}`
}

const buildPathMapping = format =>
  pipe(
    map(file => {
      const name = createPathName(file)

      return {
        key: createModuleName(name),
        value: `${isDevelopment ? DEV_PATH : pkg.name}/${format}${name}`,
      }
    }),
    pathMappingTemplate,
    content => {
      try {
        mkdirp.sync(resolvePath(DIR_PATH, format))
        fs.writeFileSync(resolvePath(DIR_PATH, format, 'path-mapping.js'), content)
      } catch (err) {
        // eslint-disable-next-line
        console.error(err)
      }
    },
  )

const paths = klaw(SOURCE_PATH)
const modules = takeModules(paths)
const createExternals = pipe(
  filter(takeFiles),
  reduce((acc, file) => {
    const name = createPathName(file.path)
    return [...acc, createModuleName(name)]
  }, []),
)
const externals = createExternals(paths)

const buildCjsPathMapping = buildPathMapping(CJS_MODULES)
const buildEsmPathMapping = buildPathMapping(ESM_MODULES)

const buildModule = format => async file => {
  const modulePath = createModulePath(format)
  const inputOptions = {
    ...rollupConfig,
    external: [...rollupConfig.external, ...externals],
    input: file,
  }
  const outputOptions = {
    format,
    file: modulePath(file),
    exports: 'named',
  }

  const bundle = await rollup.rollup(inputOptions)

  await bundle.write(outputOptions)
}

const prepareJson = pipe(
  omit(['scripts']),
  merge({
    main: './cjs/index.js',
    module: './esm/index.js',
    sideEffects: false,
  }),
  obj => prettyJson(obj),
)

const createFolder = dir => mkdirp.sync(resolvePath(dir))

const createPackageJson = (dir, obj) => {
  const json = prepareJson(obj)
  fs.writeFileSync(resolvePath(dir, 'package.json'), json)
}

const copyFiles = (dir, files) =>
  forEach(file => fs.copySync(resolvePath(file), resolvePath(dir, file)), files)

if (isDevelopment) {
  const buildCjsModule = buildModule(CJS_MODULES)
  const buildEsmModule = buildModule(ESM_MODULES)

  const buildModules = file => {
    buildCjsModule(file)
    buildEsmModule(file)
  }

  cleanFolder(DEV_PATH)
  createFolder(DEV_PATH)
  buildCjsPathMapping(modules)
  buildEsmPathMapping(modules)

  chokidar
    .watch(resolvePath('src'), { ignored: DO_NOT_BUILD_PATHS })
    .on('all', (event, fileOrDir) => {
      // eslint-disable-next-line
      switch (event) {
        case 'add':
        case 'change':
          // eslint-disable-next-line
          console.log(`✓ ${removeSourcePath(fileOrDir)}`)
          buildModules(fileOrDir)
          break
        default:
          break
      }
    })
} else {
  const buildModules = format => mapAsync(buildModule(format))
  const buildCjsModules = buildModules(CJS_MODULES)
  const buildEsmModules = buildModules(ESM_MODULES)

  cleanFolder(DIST_PATH)
  createFolder(DIST_PATH)
  createPackageJson(DIST_PATH, pkg)
  copyFiles(DIST_PATH, ['LICENSE', 'README.md', 'yarn.lock', 'docs', 'src', 'native'])
  buildCjsPathMapping(modules)
  buildEsmPathMapping(modules)
  buildEsmModules(modules)
  buildCjsModules(modules)
}
