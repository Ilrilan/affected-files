import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'
import glob from 'glob'
import debug from 'debug'
import minimatch from 'minimatch'
import filterDependent from 'filter-dependent'

const log = debug('af')

type Filename = string
type GlobPattern = string

interface Options {
  pattern?: string
  changed?: Filename[]
  abs?: boolean
  absolute?: boolean
  superleaves?: GlobPattern[]
  cwd?: string
  missing?: string[]
  mergeBase?: string
  tracked?: Filename[]
}

interface ROptions extends Options {
  pattern: string
  cwd: string
  missing: string[]
  absolute: boolean
}

export const DEFAULT_PATTERN = './src/**/*'
const DEFAULT_OPTIONS = {
  absolute: false,
  cwd: process.cwd(),
  missing: [],
}

function getChanged(mergeBase: string = 'origin/master', argChanged?: Filename[]): Filename[] {
  if (argChanged) {
    // to abs path
    return argChanged.map((f) => path.resolve(f))
  }

  const staged = String(execSync('git diff --name-only --pretty=format: HEAD'))
    .trim()
    .split('\n')
    .filter((s) => s.length)
  const base = execSync(`git merge-base ${mergeBase} HEAD`)
    .toString()
    .trim()
  const cmd = `git log --name-only --pretty=format: HEAD ^${base}`

  log('base', base)
  log('cmd', cmd)

  const comitted = String(execSync(cmd))
    .trim()
    .split('\n')
    .filter((s) => s.length)
  const changed = staged.concat(comitted).map((f) => path.resolve(f))

  log('changed', changed)

  return changed.filter((f) => fs.existsSync(f))
}

function getTracked(argTracked?: Filename[]): Filename[] {
  let tracked = argTracked

  if (!tracked) {
    tracked = String(execSync('git ls-tree --full-tree -r --name-only HEAD'))
      .trim()
      .split('\n')
      .filter((s) => s.length)
  }

  log('tracked', tracked)

  return tracked.map((f) => path.resolve(f))
}

function getOptions(patternArg: string | Options, optionsArg?: Options): ROptions {
  let pattern = DEFAULT_PATTERN
  let realOptionsArg = optionsArg

  if (typeof patternArg === 'object') {
    realOptionsArg = patternArg
    pattern = patternArg.pattern || DEFAULT_PATTERN
  } else {
    pattern = patternArg
  }

  let options: ROptions = { pattern, ...DEFAULT_OPTIONS, ...realOptionsArg }

  let fileOptions: Options = {}

  try {
    const fn = path.resolve(options.cwd as string, 'affected-files.config.js')

    fileOptions = require(fn)
    log(`File config found`, fn, fileOptions)
  } catch (e) {
    log(`No config file detected`)
  }

  options = { pattern, ...DEFAULT_OPTIONS, ...fileOptions, ...realOptionsArg }

  return options
}

function publicGetAffectedFiles(patternArg: string | Options, optionsArg?: Options) {
  const options: ROptions = getOptions(patternArg, optionsArg)

  return getAffectedFiles(options)
}

function absConv(files: Filename[], absolute: boolean, cwd: string) {
  return files.map((f) => {
    if (f.startsWith('/') && !absolute) {
      return f.slice(cwd.length + 1)
    } else if (!f.startsWith('/') && absolute) {
      return path.resolve(cwd, f)
    }

    return f
  })
}

function getAffectedFiles(options: ROptions): string[] {
  const { pattern, absolute, cwd, missing } = options
  const missingSet = new Set(missing)

  if (options.changed) {
    log('custom changed detected', options.changed)
  }

  const changed = getChanged(options.mergeBase, options.changed)
  const tracked = getTracked(options.tracked)
  const trackedSet = new Set(tracked)

  log('pattern', pattern)

  const sources = glob.sync(pattern, { cwd, absolute: true }).filter((f) => trackedSet.has(f))

  log('sources', sources)

  const affectedFiles = filterDependent(sources, changed, {
    onMiss: (fn, dep) => {
      const relFn = fn.slice(cwd.length + 1) // `/root/dir/foo/fn.js` → `foo/fn.js`

      log('Checking unresolved dependency in missing', relFn, dep)

      if (missingSet.has(`${relFn} >>> ${dep}`) || missingSet.has(`* >>> ${dep}`)) {
        return
      }

      console.error(`Failed to resolve "${dep}" in "${fn}". Fix it or add to 'missing'.`)
      throw new Error(`Failed to resolve "${dep}" in "${fn}"`)
    },
  })

  log('affectedFiles', affectedFiles)

  if (options.superleaves) {
    log('superleaves detected', options.superleaves)

    const superfiles = options.superleaves
      .reduce((acc: string[], sl: GlobPattern) => {
        const lfiles = glob.sync(sl, { absolute: true })

        acc = acc.concat(lfiles)

        return acc
      }, [])
      .filter((f) => trackedSet.has(f))

    log('superfiles', superfiles)

    log(`checking superfiles to match pattern...`)

    superfiles.forEach((f) => {
      const relf = f.slice(cwd.length + 1)

      if (!minimatch(relf, pattern)) {
        throw new Error(`Superfile "${relf}" does not match against pattern "${pattern}"`)
      }
    })

    const superfilesSet = new Set(superfiles)
    const affectedSet = new Set(affectedFiles)

    for (let fn of superfilesSet) {
      if (affectedSet.has(fn)) {
        log(`Superleaf "${fn}" is affected, returning all sources files`)

        return absConv(sources, absolute, cwd)
      }
    }

    log(`Superleaves not affected, returning only affected files`)
  }

  if (absolute === true) {
    return affectedFiles
  }

  // /abs/path/to/cwd/folder/1.js → folder/1.js
  return affectedFiles.map((f: string) => f.slice(cwd.length + 1))
}

export default publicGetAffectedFiles
